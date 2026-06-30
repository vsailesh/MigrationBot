/**
 * SharePointPoller
 * ================
 * Uses the Microsoft Graph API Delta query to detect new or modified files
 * across all project folders under Shared Documents.
 *
 * Folder → project key resolution:
 *   Shared Documents/
 *     Aetna/       → aetna
 *     CareFirst/   → carefirst
 *     HCSC/        → hcsc  (skipped if no schema)
 *     ...
 *
 * The Delta link persists to .cache/sp-delta.json keyed by driveId so
 * restarts resume exactly where they left off — only new/changed files
 * are returned on every subsequent call.
 *
 * Known hard site/drive IDs are cached from the first resolve so we
 * don't repeat the Graph discovery call on every poll.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ClientSecretCredential } from '@azure/identity';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '../../.cache/sp-delta.json');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Resolved from the DataAnalyticsAndInsights site (discovered in setup)
const KNOWN_SITE_ID  = 'ac180a1d-b756-491d-8670-4357766a4a99';
const KNOWN_DRIVE_ID = 'b!HQoYrFa3HUmGcENXdmpKmeuzxd7mR2REsp4ZlwucKQ1C7QHFBL3FQpz6cOD0JEJB';

const SUPPORTED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

// Folder name → project key normalisation.
// Checked case-insensitively. If a folder name isn't listed here the poller
// falls back to lower-casing the folder name (so "Aetna" → "aetna").
// Add entries here for ambiguous names (e.g. "Care First" → "carefirst").
const FOLDER_PROJECT_MAP = {
    'aetna'          : 'aetna',
    'carefirst'      : 'carefirst',
    'care first'     : 'carefirst',
    'cfmd'           : 'carefirst',
    'hcsc'           : 'hcsc',
    'hcsc- care gap files': 'hcsc',
    'medstar'        : 'medstar',
    'uhc dc'         : 'uhcdc',
    'uhc md'         : 'uhcmd',
    'uhc nc'         : 'uhcnc',
};

export class SharePointPoller {
    /**
     * @param {object}   options
     * @param {number}   options.intervalMs   Poll interval in ms (default: 15 min)
     * @param {string[]} options.allowProjects Whitelist of project keys to process;
     *                                         if empty/absent, all folders with a schema are processed
     * @param {function} options.hasSchema     (projectKey) → boolean — provided by FileIngestionPipeline
     * @param {function} options.onNewFile     async (fileItem) → void
     */
    constructor(options = {}) {
        this.intervalMs    = options.intervalMs || parseInt(process.env.PIPELINE_POLL_INTERVAL_MS || '900000');
        this.allowProjects = options.allowProjects || [];          // [] = allow all with schema
        this.hasSchema     = options.hasSchema || (() => false);
        this.onNewFile     = options.onNewFile || (() => {});
        this._timer        = null;
        this._running      = false;
        this._siteId       = KNOWN_SITE_ID;
        this._driveId      = KNOWN_DRIVE_ID;
    }

    start() {
        if (this._running) return;
        this._running = true;
        console.log(`[SharePointPoller] Watching Shared Documents every ${this.intervalMs / 60000} min`);
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

    /** Single poll cycle. Returns count of files dispatched to onNewFile. */
    async pollOnce() {
        const token = await this._getToken();
        const { items, nextDeltaLink } = await this._fetchDelta(token);
        if (nextDeltaLink) this._saveDeltaLink(nextDeltaLink);

        let dispatched = 0;
        for (const item of items) {
            if (!item.file || item.deleted) continue;
            const ext = (item.name || '').split('.').pop().toLowerCase();
            if (!SUPPORTED_EXTENSIONS.includes('.' + ext)) continue;

            const projectKey = this._projectFromItem(item);
            if (!projectKey) continue;                             // not under a project folder
            if (!this._isAllowed(projectKey)) {
                // No schema registered for this project yet — skip silently
                continue;
            }

            dispatched++;
            try {
                await this.onNewFile({
                    id:                   item.id,
                    name:                 item.name,
                    size:                 item.size,
                    lastModifiedDateTime: item.lastModifiedDateTime,
                    webUrl:               item.webUrl,
                    parentPath:           item.parentReference?.path || '',
                    projectKey,
                });
            } catch (err) {
                console.error(`[SharePointPoller] onNewFile error for "${item.name}":`, err.message);
            }
        }
        console.log(`[SharePointPoller] Poll complete — ${dispatched} file(s) dispatched across all project folders`);
        return dispatched;
    }

    // ── Project detection ──────────────────────────────────────────────────────

    /**
     * Extract the top-level project folder name from a file's parentReference.path.
     *
     * Graph API parentReference.path for a file at:
     *   Shared Documents/Aetna/2026/file.xlsx
     * will be:
     *   /drives/<driveId>/root:/Aetna/2026
     *
     * We grab the first path component after "root:/" → "Aetna" → normalise → "aetna"
     */
    _projectFromItem(item) {
        const rawPath = item.parentReference?.path || '';
        // Strip the /drives/.../root: prefix
        const afterRoot = rawPath.replace(/^\/drives\/[^/]+\/root:\//, '');
        if (!afterRoot) return null;                               // file is at the drive root — ignore

        const topFolder = afterRoot.split('/')[0];
        if (!topFolder) return null;

        return FOLDER_PROJECT_MAP[topFolder.toLowerCase()] || topFolder.toLowerCase();
    }

    _isAllowed(projectKey) {
        if (this.allowProjects.length > 0) {
            return this.allowProjects.includes(projectKey);
        }
        return this.hasSchema(projectKey);
    }

    // ── Delta fetch ────────────────────────────────────────────────────────────

    async _fetchDelta(token) {
        let url = this._loadDeltaLink()
            || `${GRAPH_BASE}/sites/${this._siteId}/drives/${this._driveId}/root/delta`;

        const items = [];
        let nextDeltaLink = null;

        while (url) {
            const res = await this._graphGet(url, token);
            if (res.value) items.push(...res.value);

            if (res['@odata.deltaLink']) { nextDeltaLink = res['@odata.deltaLink']; break; }
            url = res['@odata.nextLink'] || null;
        }
        return { items, nextDeltaLink };
    }

    // ── Auth & HTTP ────────────────────────────────────────────────────────────

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
        if (!res.ok) throw new Error(`Graph API ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
        return res.json();
    }

    // ── Delta link persistence ─────────────────────────────────────────────────

    _saveDeltaLink(link) {
        try {
            const data = this._readCache();
            data[this._driveId] = { deltaLink: link, savedAt: new Date().toISOString() };
            fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
            fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
        } catch (e) { console.warn('[SharePointPoller] Could not save delta link:', e.message); }
    }

    _loadDeltaLink() {
        try {
            const data = this._readCache();
            return data[this._driveId]?.deltaLink || null;
        } catch { return null; }
    }

    _readCache() {
        try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
    }
}
