/**
 * SharePointPoller
 * ================
 * Uses the Microsoft Graph API Delta query to detect new or modified files
 * in a configured SharePoint folder without full re-scans.
 *
 * How Delta works:
 *  1. First call returns a snapshot of all items + a `@odata.deltaLink`
 *  2. Subsequent calls using that deltaLink return ONLY items changed since last call
 *  3. The deltaLink is persisted to .cache/sp-delta.json so restarts resume correctly
 *
 * This avoids listing the entire folder on every poll cycle and is efficient
 * even for folders with thousands of files.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ClientSecretCredential } from '@azure/identity';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '../../.cache/sp-delta.json');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const SUPPORTED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

export class SharePointPoller {
    /**
     * @param {string} watchFolderPath  SharePoint-relative path, e.g. "Shared Documents/SFTP-Incoming"
     * @param {object} options
     * @param {number} options.intervalMs          Poll interval in ms (default: 15 min)
     * @param {string} options.projectName         Default project name to tag detected files with
     * @param {function} options.onNewFile         Called for each new/modified file: async (fileItem) => {}
     */
    constructor(watchFolderPath, options = {}) {
        this.watchFolderPath = watchFolderPath;
        this.intervalMs = options.intervalMs || parseInt(process.env.PIPELINE_POLL_INTERVAL_MS || '900000');
        this.projectName = options.projectName || process.env.WATCH_PROJECT_NAME || 'unknown';
        this.onNewFile = options.onNewFile || (() => {});
        this._timer = null;
        this._running = false;
        this._driveId = null;
        this._siteId = null;
    }

    /** Start polling on the configured interval. */
    start() {
        if (this._running) return;
        this._running = true;
        console.log(`[SharePointPoller] Starting watch on "${this.watchFolderPath}" every ${this.intervalMs / 60000} min`);
        this._scheduleNext();
    }

    stop() {
        this._running = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        console.log('[SharePointPoller] Stopped');
    }

    _scheduleNext() {
        if (!this._running) return;
        this._timer = setTimeout(async () => {
            try { await this.pollOnce(); } catch (err) { console.error('[SharePointPoller] Poll error:', err.message); }
            this._scheduleNext();
        }, this.intervalMs);
    }

    /** Single poll cycle — call directly to trigger an immediate check. */
    async pollOnce() {
        const token = await this._getToken();
        if (!this._siteId) await this._resolveSiteAndDrive(token);

        const { items, nextDeltaLink } = await this._fetchDelta(token);
        if (nextDeltaLink) this._saveDeltaLink(nextDeltaLink);

        const newFiles = items.filter(item =>
            item.file &&
            !item.deleted &&
            SUPPORTED_EXTENSIONS.some(ext => (item.name || '').toLowerCase().endsWith(ext)) &&
            this._isUnderWatchFolder(item)
        );

        console.log(`[SharePointPoller] Poll complete — ${newFiles.length} new/changed file(s) detected`);
        for (const file of newFiles) {
            try {
                await this.onNewFile({
                    id: file.id,
                    name: file.name,
                    size: file.size,
                    lastModifiedDateTime: file.lastModifiedDateTime,
                    webUrl: file.webUrl,
                    parentPath: file.parentReference?.path || '',
                    projectName: this.projectName,
                });
            } catch (err) {
                console.error(`[SharePointPoller] onNewFile error for "${file.name}":`, err.message);
            }
        }
        return newFiles.length;
    }

    _isUnderWatchFolder(item) {
        const parentPath = (item.parentReference?.path || '').toLowerCase();
        const watchSuffix = this.watchFolderPath.toLowerCase().replace(/^\/+|\/+$/g, '');
        return parentPath.includes(watchSuffix) || parentPath.includes('root:') ;
    }

    async _fetchDelta(token) {
        const cached = this._loadDeltaLink();
        let url = cached || await this._buildInitialDeltaUrl(token);

        const items = [];
        let nextDeltaLink = null;

        while (url) {
            const res = await this._graphGet(url, token);
            if (res.value) items.push(...res.value);

            if (res['@odata.deltaLink']) {
                nextDeltaLink = res['@odata.deltaLink'];
                break;
            }
            url = res['@odata.nextLink'] || null;
        }
        return { items, nextDeltaLink };
    }

    async _buildInitialDeltaUrl(token) {
        // Resolve the watch folder's item ID, then call delta on it
        const folderEncoded = encodeURIComponent(this.watchFolderPath.replace(/^\//, ''));
        try {
            const folderItem = await this._graphGet(
                `${GRAPH_BASE}/sites/${this._siteId}/drives/${this._driveId}/root:/${this.watchFolderPath}`,
                token
            );
            return `${GRAPH_BASE}/sites/${this._siteId}/drives/${this._driveId}/items/${folderItem.id}/delta`;
        } catch {
            // Fallback: delta on root, filter by folder path client-side
            return `${GRAPH_BASE}/sites/${this._siteId}/drives/${this._driveId}/root/delta`;
        }
    }

    async _resolveSiteAndDrive(token) {
        const siteUrl = (process.env.SP_SITE_URL || '').replace(/\/$/, '');
        const match = siteUrl.match(/sharepoint\.com(\/sites\/[^/?#]+)/);
        const sitePath = match ? match[1] : '/sites/root';

        const site = await this._graphGet(`${GRAPH_BASE}/sites/hcdinternational.sharepoint.com:${sitePath}`, token);
        this._siteId = site.id;

        const drivesRes = await this._graphGet(`${GRAPH_BASE}/sites/${this._siteId}/drives`, token);
        const defaultDrive = drivesRes.value?.find(d => d.name === 'Documents' || d.driveType === 'documentLibrary') || drivesRes.value?.[0];
        this._driveId = defaultDrive?.id;

        if (!this._driveId) throw new Error('[SharePointPoller] Could not resolve SharePoint drive ID');
        console.log(`[SharePointPoller] Resolved siteId=${this._siteId}, driveId=${this._driveId}`);
    }

    async _getToken() {
        const cred = new ClientSecretCredential(
            process.env.AZURE_TENANT_ID,
            process.env.AZURE_CLIENT_ID,
            process.env.AZURE_CLIENT_SECRET
        );
        const tok = await cred.getToken('https://graph.microsoft.com/.default');
        return tok.token;
    }

    async _graphGet(url, token) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Graph API error ${res.status} for ${url}: ${await res.text()}`);
        return res.json();
    }

    _saveDeltaLink(link) {
        try {
            const data = this._readCache();
            data[this.watchFolderPath] = { deltaLink: link, savedAt: new Date().toISOString() };
            fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
            fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
        } catch (e) { console.warn('[SharePointPoller] Could not save delta link:', e.message); }
    }

    _loadDeltaLink() {
        try {
            const data = this._readCache();
            return data[this.watchFolderPath]?.deltaLink || null;
        } catch { return null; }
    }

    _readCache() {
        try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
    }
}
