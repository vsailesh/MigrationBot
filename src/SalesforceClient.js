import { TokenCache } from './azure/tokenCache.js';

// jsforce's bundled `node-fetch` v2 dependency cannot read HTTP response bodies
// on the Node version running here (every call hangs indefinitely or throws
// "Premature close" — confirmed via direct testing). So this client talks to
// Salesforce's SOAP/REST/OAuth endpoints directly using the native `fetch`,
// bypassing jsforce entirely.

const API_VERSION = '59.0';

function loginUrlBase() {
    return (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, '');
}

function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlTag(xml, tag) {
    return xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, 's'))?.[1];
}

// ── Credential-based login (username + password + security token) ─────────────
// Used when SF_USERNAME / SF_PASSWORD / SF_TOKEN are present in .env.
// This is the default flow — no Connected App required.

async function loginWithCredentials() {
    const username = process.env.SF_USERNAME || '';
    const password = (process.env.SF_PASSWORD || '') + (process.env.SF_TOKEN || '');

    const body = `<?xml version="1.0" encoding="utf-8"?><env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><n1:login xmlns:n1="urn:partner.soap.sforce.com"><n1:username>${escapeXml(username)}</n1:username><n1:password>${escapeXml(password)}</n1:password></n1:login></env:Body></env:Envelope>`;

    const res = await fetch(`${loginUrlBase()}/services/Soap/u/${API_VERSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: 'login' },
        body,
    });
    const xml = await res.text();

    const fault = xmlTag(xml, 'faultstring');
    if (fault) {
        throw new Error(fault);
    }

    const sessionId = xmlTag(xml, 'sessionId');
    const serverUrl = xmlTag(xml, 'serverUrl');
    if (!sessionId || !serverUrl) {
        throw new Error('Salesforce login failed: could not parse SOAP login response');
    }

    return {
        source: 'credentials',
        instanceUrl: serverUrl.split('/services/')[0],
        accessToken: sessionId,
        userInfo: {
            username: xmlTag(xml, 'userName'),
            organization_id: xmlTag(xml, 'organizationId'),
            display_name: xmlTag(xml, 'userFullName'),
        },
    };
}

// ── OAuth 2.0 flow (Connected App) ────────────────────────────────────────────
// Used when SF_CLIENT_ID is set and the user has signed in via the dashboard button.
// Tokens are cached by TokenCache; refresh tokens keep the session alive.

function redirectUri() {
    return `http://localhost:${process.env.PORT || 3001}/api/sf-callback`;
}

export function getSalesforceAuthUrl() {
    if (!process.env.SF_CLIENT_ID) {
        throw new Error('SF_CLIENT_ID is not set. Create a Salesforce Connected App and add the Consumer Key to .env');
    }
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.SF_CLIENT_ID,
        redirect_uri: redirectUri(),
        scope: 'api refresh_token openid',
    });
    return `${loginUrlBase()}/services/oauth2/authorize?${params.toString()}`;
}

async function requestOAuthToken(params) {
    const res = await fetch(`${loginUrlBase()}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error_description || data.error || `Salesforce OAuth error (${res.status})`);
    }
    return data;
}

export async function exchangeCodeForToken(code) {
    const data = await requestOAuthToken({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
        redirect_uri: redirectUri(),
    });
    TokenCache.saveToken('salesforce', {
        token: data.access_token,
        refreshToken: data.refresh_token,
        instanceUrl: data.instance_url,
        identityUrl: data.id,
        expiresOn: new Date(Date.now() + 2 * 3600 * 1000),
    });
    return { source: 'oauth', instanceUrl: data.instance_url, accessToken: data.access_token };
}

async function refreshOAuthSession(cached) {
    const data = await requestOAuthToken({
        grant_type: 'refresh_token',
        refresh_token: cached.refreshToken,
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
    });
    const updated = {
        token: data.access_token,
        refreshToken: cached.refreshToken,
        instanceUrl: data.instance_url || cached.instanceUrl,
        identityUrl: data.id || cached.identityUrl,
        expiresOn: new Date(Date.now() + 2 * 3600 * 1000),
    };
    TokenCache.saveToken('salesforce', updated);
    return { source: 'oauth', instanceUrl: updated.instanceUrl, accessToken: updated.token, identityUrl: updated.identityUrl };
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Priority: cached OAuth token → credential login → error
// Returns a plain session object: { source, instanceUrl, accessToken, userInfo? }

export async function connectSalesforce() {
    const cachedOAuth = TokenCache.loadToken('salesforce');
    if (cachedOAuth) {
        return {
            source: 'oauth',
            instanceUrl: cachedOAuth.instanceUrl,
            accessToken: cachedOAuth.token,
            identityUrl: cachedOAuth.identityUrl,
            _refresh: () => refreshOAuthSession(cachedOAuth),
        };
    }

    const hasCredentials =
        process.env.SF_USERNAME &&
        process.env.SF_PASSWORD &&
        process.env.SF_TOKEN;

    if (hasCredentials) {
        return loginWithCredentials();
    }

    throw new Error(
        'Salesforce not configured. Add SF_USERNAME / SF_PASSWORD / SF_TOKEN to .env, ' +
        'or sign in via the dashboard using a Connected App.'
    );
}

// ── REST helper with one retry-after-refresh for OAuth sessions ────────────────

async function sfFetch(session, path, options = {}) {
    const url = path.startsWith('http') ? path : `${session.instanceUrl}${path}`;
    let res = await fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${session.accessToken}`, ...options.headers },
    });

    if (res.status === 401 && session._refresh) {
        session = await session._refresh();
        res = await fetch(path.startsWith('http') ? path : `${session.instanceUrl}${path}`, {
            ...options,
            headers: { Authorization: `Bearer ${session.accessToken}`, ...options.headers },
        });
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Salesforce request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
}

export async function testSalesforceConnection() {
    try {
        const session = await connectSalesforce();

        if (session.userInfo) {
            return {
                connected: true,
                username: session.userInfo.username,
                orgId: session.userInfo.organization_id,
                displayName: session.userInfo.display_name,
            };
        }

        const identityUrl = session.identityUrl || `${session.instanceUrl}/services/oauth2/userinfo`;
        const identity = await sfFetch(session, `${identityUrl}${identityUrl.includes('?') ? '&' : '?'}format=json`);
        return {
            connected: true,
            username: identity.preferred_username || identity.username,
            orgId: identity.organization_id,
            displayName: identity.name || identity.display_name,
        };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

export async function querySalesforce(soql) {
    const session = await connectSalesforce();
    return sfFetch(session, `/services/data/v${API_VERSION}/query?q=${encodeURIComponent(soql)}`);
}

// ── Write / Upsert ────────────────────────────────────────────────────────────
//
// upsertSalesforceRecords — main entry point for writing cleaned data to Salesforce.
// Routes to Composite PATCH API (≤ 200 records per batch) or Bulk API v2 (> 200).
//
// @param {string} objectName       Salesforce API object name, e.g. 'Contact' or 'HealthcareMember__c'
// @param {Array}  records          Array of plain objects { field: value, ... }
// @param {string} externalIdField  The field used to match existing records (upsert key)
// @returns {Object} { success, totalProcessed, failed, errors[] }

export async function upsertSalesforceRecords(objectName, records, externalIdField) {
    if (!records || records.length === 0) return { success: true, totalProcessed: 0, failed: 0, errors: [] };
    const session = await connectSalesforce();

    if (records.length <= 200) {
        return compositeUpsert(session, objectName, records, externalIdField);
    }
    return bulkApiV2Upsert(session, objectName, records, externalIdField);
}

// ── Composite API upsert (≤ 200 records per call, batched automatically) ──────

async function compositeUpsert(session, objectName, records, externalIdField) {
    const BATCH = 200;
    const results = { success: true, totalProcessed: 0, failed: 0, errors: [] };

    for (let i = 0; i < records.length; i += BATCH) {
        const batch = records.slice(i, i + BATCH).map(r => ({
            attributes: { type: objectName },
            ...r,
        }));

        const res = await sfFetch(session, `/services/data/v${API_VERSION}/composite/sobjects/${objectName}/${externalIdField}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ allOrNone: false, records: batch }),
        });

        for (const item of (Array.isArray(res) ? res : [])) {
            if (item.success) {
                results.totalProcessed++;
            } else {
                results.failed++;
                results.success = false;
                results.errors.push({ id: item.id, errors: item.errors });
            }
        }
    }
    console.log(`[SalesforceClient] Composite upsert: ${results.totalProcessed} ok, ${results.failed} failed`);
    return results;
}

// ── Bulk API v2 upsert (for > 200 records) ────────────────────────────────────
// Flow: create job → upload CSV → close upload → poll until done → fetch results

async function bulkApiV2Upsert(session, objectName, records, externalIdField) {
    const baseUrl = `/services/data/v${API_VERSION}/jobs/ingest`;

    // 1. Create the job
    const job = await sfFetch(session, baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            object: objectName,
            contentType: 'CSV',
            operation: 'upsert',
            externalIdFieldName: externalIdField,
        }),
    });
    const jobId = job.id;
    console.log(`[SalesforceClient] Bulk API v2 job created: ${jobId}`);

    try {
        // 2. Upload CSV content
        const csv = recordsToCsv(records);
        await sfFetchRaw(session, `${baseUrl}/${jobId}/batches`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/csv' },
            body: csv,
        });

        // 3. Signal upload complete
        await sfFetch(session, `${baseUrl}/${jobId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'UploadComplete' }),
        });

        // 4. Poll until job finishes (max 10 min)
        const finalJob = await pollBulkJob(session, `${baseUrl}/${jobId}`);

        // 5. Fetch error details
        const errors = [];
        if ((finalJob.numberRecordsFailed || 0) > 0) {
            try {
                const failedCsv = await sfFetchText(session, `${baseUrl}/${jobId}/failedResults`);
                errors.push(...parseCsvErrors(failedCsv));
            } catch { /* non-critical */ }
        }

        const result = {
            success: finalJob.state === 'JobComplete' && finalJob.numberRecordsFailed === 0,
            totalProcessed: finalJob.numberRecordsProcessed || 0,
            failed: finalJob.numberRecordsFailed || 0,
            errors,
        };
        console.log(`[SalesforceClient] Bulk job ${jobId}: ${result.totalProcessed} ok, ${result.failed} failed`);
        return result;

    } catch (err) {
        // Try to abort the job on error
        await sfFetch(session, `${baseUrl}/${jobId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'Aborted' }),
        }).catch(() => {});
        throw err;
    }
}

async function pollBulkJob(session, jobUrl, maxMs = 600000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const job = await sfFetch(session, jobUrl);
        if (['JobComplete', 'Failed', 'Aborted'].includes(job.state)) return job;
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error('Bulk API v2 job timed out after 10 minutes');
}

// ── Low-level fetch helpers for write paths ────────────────────────────────────

async function sfFetchRaw(session, path, options = {}) {
    const url = path.startsWith('http') ? path : `${session.instanceUrl}${path}`;
    return fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${session.accessToken}`, ...options.headers },
    });
}

async function sfFetchText(session, path) {
    const res = await sfFetchRaw(session, path);
    if (!res.ok) throw new Error(`Salesforce ${res.status}: ${await res.text()}`);
    return res.text();
}

// ── CSV helpers ────────────────────────────────────────────────────────────────

function recordsToCsv(records) {
    if (!records.length) return '';
    const headers = Object.keys(records[0]);
    const escape = v => {
        const s = v == null ? '' : String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const rec of records) lines.push(headers.map(h => escape(rec[h])).join(','));
    return lines.join('\n');
}

function parseCsvErrors(csv) {
    const lines = csv.split('\n').filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',');
    return lines.slice(1, 51).map(line => {
        const vals = line.split(',');
        return Object.fromEntries(headers.map((h, i) => [h, vals[i]]));
    });
}
