import { ClientSecretCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';

let cachedSiteId = null;

function getEnvOrThrow(name) {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not configured`);
    return v;
}

async function getAccessToken() {
    const tenantId = getEnvOrThrow('AZURE_TENANT_ID');
    const clientId = getEnvOrThrow('AZURE_CLIENT_ID');
    const clientSecret = getEnvOrThrow('AZURE_CLIENT_SECRET');

    const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const token = await cred.getToken('https://graph.microsoft.com/.default');
    if (!token) throw new Error('Failed to acquire Graph token');
    return token.token;
}

function parseSiteUrl(siteUrl) {
    // example: https://contoso.sharepoint.com/sites/MySite
    const u = new URL(siteUrl);
    const hostname = u.hostname; // contoso.sharepoint.com
    const path = u.pathname; // /sites/MySite or /teams/...
    return { hostname, path };
}

export async function getSiteId() {
    if (cachedSiteId) return cachedSiteId;
    const siteUrl = getEnvOrThrow('SP_SITE_URL');
    const { hostname, path } = parseSiteUrl(siteUrl);
    const token = await getAccessToken();

    const url = `https://graph.microsoft.com/v1.0/sites/${hostname}:${path}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Failed to resolve site id: ${res.status} ${txt}`);
    }
    const body = await res.json();
    cachedSiteId = body.id;
    return cachedSiteId;
}

async function listFolderChildren(siteId, folderPath) {
    // folderPath: 'Shared Documents/Aetna/2026'
    const token = await getAccessToken();
    // normalize path: default drive root corresponds to Shared Documents
    let normalized = folderPath.replace(/^\//, '');
    if (/^shared documents/i.test(normalized)) {
        normalized = normalized.replace(/^shared documents\/?/i, '');
    }
    let url;
    if (!normalized) {
        url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root/children`;
    } else {
        const encoded = encodeURIComponent(normalized);
        url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encoded}:/children`;
    }
    console.log('sharepointClient: listing folder', folderPath, 'normalized', normalized, 'siteId', siteId, 'url', url);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        const txt = await res.text();
        console.error('sharepointClient: listFolderChildren error', res.status, txt);
        throw new Error(`List folder failed: ${res.status} ${txt}`);
    }
    const body = await res.json();
    return body.value || [];
}

export async function downloadItemContent(siteId, itemId) {
    const token = await getAccessToken();
    const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${itemId}/content`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Download failed: ${res.status} ${txt}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}

export function getBlobContainerClient() {
    const conn = getEnvOrThrow('AZURE_STORAGE_CONNECTION_STRING');
    const containerName = process.env.AZURE_CONTAINER || getEnvOrThrow('AZURE_CONTAINER');
    const svc = BlobServiceClient.fromConnectionString(conn);
    return svc.getContainerClient(containerName);
}

export async function uploadBufferToBlob(containerClient, blobPath, buffer) {
    const blockClient = containerClient.getBlockBlobClient(blobPath);
    await blockClient.uploadData(buffer, { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } });
}

async function uploadSharePointFolder(spFolderPath, prefix = '') {
    // spFolderPath: '/Shared Documents/Aetna/2026' or 'Shared Documents/Aetna/2026'
    const siteId = await getSiteId();
    const normalized = spFolderPath.replace(/^\//, '');
    const containerClient = getBlobContainerClient();

    async function recurse(path, currentPrefix) {
        const children = await listFolderChildren(siteId, path);
        for (const child of children) {
            if (child.folder) {
                const subPath = `${path}/${child.name}`;
                await recurse(subPath, `${currentPrefix}/${child.name}`);
            } else if (child.file) {
                const name = child.name;
                const lower = name.toLowerCase();
                if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) continue;

                const blobPath = `${currentPrefix}/${name}`.replace(/^\//, '');
                const content = await downloadItemContent(siteId, child.id);
                await uploadBufferToBlob(containerClient, blobPath, content);
            }
        }
    }

    await recurse(normalized, prefix || '');
    return { uploadedTo: prefix };
}

export async function testSharePointConnection() {
    try {
        const siteId = await getSiteId();
        return { connected: true, siteId };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

export async function syncSharePointFolder(spFolderPath, prefix = '') {
    return uploadSharePointFolder(spFolderPath, prefix);
}

// List children for a given SharePoint folder path (returns files and folders)
export async function listSharePointFolder(spFolderPath) {
    const siteId = await getSiteId();
    const normalized = spFolderPath.replace(/^\//, '');
    const children = await listFolderChildren(siteId, normalized);
    return children.map((c) => ({ id: c.id, name: c.name, folder: !!c.folder, file: !!c.file, size: c.size }));
}

// Debug helper: return site info and drive listings
export async function debugSite() {
    const siteId = await getSiteId();
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}` };

    const baseUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}`;
    const results = {};
    // get site metadata
    const r1 = await fetch(baseUrl, { headers });
    results.site = await r1.json();

    // list all drives under site
    const r2 = await fetch(`${baseUrl}/drives`, { headers });
    results.drives = await r2.json();

    // list root children of default drive (drive/root/children)
    const r3 = await fetch(`${baseUrl}/drive/root/children`, { headers });
    results.rootChildren = await r3.json();

    return results;
}

// Migrate specific SharePoint items (files) to blob storage. items: [{ id, name }]
export async function migrateSelectedItems(items, containerName, prefix = '') {
    if (!Array.isArray(items) || items.length === 0) return { uploaded: [] };
    const siteId = await getSiteId();
    const containerClient = getBlobContainerClient();

    const uploaded = [];
    for (const it of items) {
        if (!it || !it.id || !it.name) continue;
        try {
            const content = await downloadItemContent(siteId, it.id);
            const blobPath = `${prefix}/${it.name}`.replace(/^\//, '');
            await uploadBufferToBlob(containerClient, blobPath, content);
            uploaded.push({ name: it.name, blobPath });
        } catch (err) {
            uploaded.push({ name: it.name, error: err.message });
        }
    }

    return { uploaded };
}
