import jsforce from 'jsforce';
import { TokenCache } from './azure/tokenCache.js';

// ── Credential-based login (username + password + security token) ─────────────
// Used when SF_USERNAME / SF_PASSWORD / SF_TOKEN are present in .env.
// This is the default flow — no Connected App required.

async function connectWithCredentials() {
    const conn = new jsforce.Connection({
        loginUrl: (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, ''),
    });
    await conn.login(
        process.env.SF_USERNAME,
        (process.env.SF_PASSWORD || '') + (process.env.SF_TOKEN || '')
    );
    return conn;
}

// ── OAuth 2.0 flow (Connected App) ────────────────────────────────────────────
// Used when SF_CLIENT_ID is set and the user has signed in via the dashboard button.
// Tokens are cached by TokenCache; refresh tokens keep the session alive.

function getOAuth2() {
    return new jsforce.OAuth2({
        loginUrl: (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, ''),
        clientId: process.env.SF_CLIENT_ID,
        clientSecret: process.env.SF_CLIENT_SECRET,
        redirectUri: `http://localhost:${process.env.PORT || 3001}/api/sf-callback`,
    });
}

export function getSalesforceAuthUrl() {
    if (!process.env.SF_CLIENT_ID) {
        throw new Error('SF_CLIENT_ID is not set. Create a Salesforce Connected App and add the Consumer Key to .env');
    }
    return getOAuth2().getAuthorizationUrl({ scope: 'api refresh_token openid' });
}

export async function exchangeCodeForToken(code) {
    const oauth2 = getOAuth2();
    const conn = new jsforce.Connection({ oauth2 });
    await conn.authorize(code);
    TokenCache.saveToken('salesforce', {
        token: conn.accessToken,
        refreshToken: conn.refreshToken,
        instanceUrl: conn.instanceUrl,
        expiresOn: new Date(Date.now() + 2 * 3600 * 1000),
    });
    return conn;
}

function connectWithOAuth(cached) {
    const oauth2 = getOAuth2();
    const conn = new jsforce.Connection({
        oauth2,
        instanceUrl: cached.instanceUrl,
        accessToken: cached.token,
        refreshToken: cached.refreshToken,
    });
    conn.on('refresh', (newAccessToken) => {
        TokenCache.saveToken('salesforce', {
            token: newAccessToken,
            refreshToken: cached.refreshToken,
            instanceUrl: cached.instanceUrl,
            expiresOn: new Date(Date.now() + 2 * 3600 * 1000),
        });
    });
    return conn;
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Priority: cached OAuth token → credential login → error

export async function connectSalesforce() {
    const cachedOAuth = TokenCache.loadToken('salesforce');
    if (cachedOAuth) {
        return connectWithOAuth(cachedOAuth);
    }

    const hasCredentials =
        process.env.SF_USERNAME &&
        process.env.SF_PASSWORD &&
        process.env.SF_TOKEN;

    if (hasCredentials) {
        return connectWithCredentials();
    }

    throw new Error(
        'Salesforce not configured. Add SF_USERNAME / SF_PASSWORD / SF_TOKEN to .env, ' +
        'or sign in via the dashboard using a Connected App.'
    );
}

export async function testSalesforceConnection() {
    try {
        const conn = await connectSalesforce();
        const identity = await conn.identity();
        return {
            connected: true,
            username: identity.username,
            orgId: identity.organization_id,
            displayName: identity.display_name,
        };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

export async function querySalesforce(soql) {
    const conn = await connectSalesforce();
    return await conn.query(soql);
}
