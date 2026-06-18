// ═══════════════════════════════════════════════════
// MigrationBot — Frontend Application
// ═══════════════════════════════════════════════════

const API = window.location.origin + '/api';
let currentView = 'status';
let currentContainer = null;
let currentFile = null;
let useAdf = true;
let jobPollInterval = null;

// schema preview/edit state
let currentPreviewColumns = null;        // used in explorer preview
let migratePreviewColumns = null;       // used in migrate form preview

// mapping for editable types
const TYPE_OPTIONS = [
    { adf: 'String', sql: 'NVARCHAR(255)' },
    { adf: 'Boolean', sql: 'BIT' },
    { adf: 'Int32', sql: 'INT' },
    { adf: 'Int64', sql: 'BIGINT' },
    { adf: 'Double', sql: 'FLOAT' },
    { adf: 'DateTime', sql: 'DATETIME' },
];

function adfToSql(adf) {
    const opt = TYPE_OPTIONS.find(o => o.adf === adf);
    return opt ? opt.sql : 'NVARCHAR(255)';
}

function generateDDLClient(tableName, columns, schema = 'dbo') {
    const colDefs = columns.map((col) =>
        `  [${col.name}] ${col.sqlType || adfToSql(col.adfType)}${col.nullable ? ' NULL' : ' NOT NULL'}`
    ).join(',\n');
    return `CREATE TABLE [${schema}].[${tableName}] (\n  [_migration_id] INT IDENTITY(1,1) PRIMARY KEY,\n${colDefs}\n);`;
}

function renderSchemaEditor(containerId, columns, options = { allowEdit: false }) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!columns || columns.length === 0) {
        container.innerHTML = '<div class="empty-hint">No schema detected</div>';
        return;
    }
    const rows = columns.map((col, idx) => {
        const typeValue = col.adfType || 'String';
        let typeCell;
        if (options.allowEdit) {
            const opts = TYPE_OPTIONS.map(o =>
                `<option value="${o.adf}"${o.adf===typeValue?' selected':''}>${o.adf}</option>`
            ).join('');
            typeCell = `<select data-index="${idx}" class="type-select">${opts}</select>`;
        } else {
            typeCell = `<span class="type-badge">${esc(col.sqlType || adfToSql(typeValue))}</span>`;
        }
        const sample = esc(col.sampleValues?.[0] || '—');
        return `<tr><td><strong>${esc(col.name)}</strong></td><td>${typeCell}</td><td>${sample}</td></tr>`;
    }).join('');
    container.innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
          ${columns.length} columns
        </p>
        <table class="schema-table">
          <thead><tr><th>Column</th><th>Type</th><th>Sample</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
    `;
    if (options.allowEdit) {
        const boolSet = new Set(['true','false','1','0','yes','no']);
        container.querySelectorAll('select.type-select').forEach(sel => {
            sel.addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                const newType = e.target.value;
                columns[idx].adfType = newType;
                columns[idx].sqlType = adfToSql(newType);
                // keep the preview schema state updated
                if (containerId === 'previewContent') {
                    currentPreviewColumns = columns;
                } else if (containerId === 'migrateSchemaContent') {
                    migratePreviewColumns = columns;
                    // refresh pipeline preview to reflect new types
                    setTimeout(() => {
                        if (typeof previewPipeline === 'function') previewPipeline();
                    }, 300);
                }
                // simple sample validation for boolean choices
                if (newType === 'Boolean') {
                    const sampleVal = columns[idx].sampleValues?.[0];
                    if (sampleVal !== undefined && sampleVal !== null && String(sampleVal).trim() !== '') {
                        const str = String(sampleVal).trim().toLowerCase();
                        if (!boolSet.has(str)) {
                            alert(`Warning: sample value "${sampleVal}" for column ${columns[idx].name} may not be a valid boolean.`);
                        }
                    }
                }
            });
        });
    }
}


// ── Initialization ───────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupModeToggle();
    setupMigrateForm();
    setupAuthLogout();
    setupCleaningDashboard();
    checkConnections();
});

function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            currentView = btn.dataset.view;
            document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
            document.getElementById(currentView + 'View').classList.add('active');

            if (currentView === 'explorer') loadContainers();
            if (currentView === 'sharepoint') loadSharePointRoot();
            if (currentView === 'cleaning') loadCleaningDashboard();
            if (currentView === 'migrate') loadMigrateContainers();
            if (currentView === 'jobs') loadJobs();
        });
    });
}

function setupModeToggle() {
    document.getElementById('modeAdf').addEventListener('click', () => {
        useAdf = true;
        document.getElementById('modeAdf').classList.add('active');
        document.getElementById('modeDirect').classList.remove('active');
        document.getElementById('modeHint').textContent = 'Creates a full ADF pipeline (linked services, datasets, copy activity)';
    });
    document.getElementById('modeDirect').addEventListener('click', () => {
        useAdf = false;
        document.getElementById('modeDirect').classList.add('active');
        document.getElementById('modeAdf').classList.remove('active');
        document.getElementById('modeHint').textContent = 'Directly bulk inserts data — faster for small files, no ADF pipeline created';
    });
}

// ── Connection Status ────────────────────────────
async function checkConnections() {
    try {
        const status = await fetchJSON(`${API}/status`);
        updateConnectionDot('dotBlob', 'blobStatus', status.blob, 'Azure Blob Storage');
        updateConnectionDot('dotSql', 'sqlStatus', status.sql, 'Azure SQL Database');
        updateConnectionDot('dotAdf', 'adfStatus', status.adf, 'Azure Data Factory');
        
        // Load authentication status
        await loadAuthStatus();
    } catch (err) {
        console.error('Status check failed:', err);
    }
}

async function loadAuthStatus() {
    try {
        const authData = await fetchJSON(`${API}/auth/status`);
        const authInfo = document.getElementById('authInfo');
        const authHint = document.getElementById('authHint');
        
        if (!authData.cached_tokens || Object.keys(authData.cached_tokens).length === 0) {
            authInfo.innerHTML = '<p style="color: var(--text-secondary);">No cached authentication tokens. You will be prompted to login on next server restart.</p>';
            authHint.style.display = 'none';
            return;
        }
        
        let html = '';
        let tokensToExpire = [];
        
        for (const [service, info] of Object.entries(authData.cached_tokens)) {
            const expiresIn = info.expiresIn || 0;
            const expiresInMinutes = Math.floor(expiresIn / 60);
            const status = expiresIn > 300 ? '✅' : '⚠️';
            
            html += `
                <div class="token-item">
                    <div>
                        <div class="token-label">${service.toUpperCase()}</div>
                        <div class="token-value">${status} Cached</div>
                    </div>
                    <div>
                        <div class="token-label">Expires In</div>
                        <div class="token-value">${expiresInMinutes} minutes</div>
                    </div>
                </div>
            `;
            
            if (expiresIn <= 300) {
                tokensToExpire.push(`${service} (${expiresInMinutes} min)`);
            }
        }
        
        authInfo.innerHTML = html;
        
        if (tokensToExpire.length > 0) {
            authHint.innerHTML = `⚠️ Token${tokensToExpire.length > 1 ? 's' : ''} expiring soon: ${tokensToExpire.join(', ')}`;
            authHint.style.display = 'block';
        } else {
            authHint.style.display = 'none';
        }
    } catch (err) {
        console.error('Failed to load auth status:', err);
        const authInfo = document.getElementById('authInfo');
        authInfo.innerHTML = '<p style="color: var(--text-secondary);">Unable to load authentication status.</p>';
    }
}

function setupAuthLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    const loginMfaBtn = document.getElementById('loginMfaBtn');
    const authHint = document.getElementById('authHint');

    if (loginMfaBtn) {
        loginMfaBtn.addEventListener('click', async () => {
            try {
                loginMfaBtn.disabled = true;
                loginMfaBtn.textContent = '⏳ Signing in...';
                if (authHint) {
                    authHint.textContent = 'Starting Microsoft sign-in flow...';
                    authHint.style.display = 'block';
                    authHint.style.color = 'var(--text-muted)';
                }

                const response = await fetch(`${API}/auth/login`, { method: 'POST' });
                const data = await response.json();

                if (!response.ok || !data.ok) {
                    throw new Error(data.error || 'Unable to start sign-in flow');
                }

                const message = data.message || 'Sign-in flow started successfully.';
                if (authHint) {
                    authHint.innerHTML = message.replace(/\n/g, '<br>');
                    authHint.style.display = 'block';
                    authHint.style.color = 'var(--text-muted)';
                }

                await loadAuthStatus();
                await checkConnections();
            } catch (err) {
                if (authHint) {
                    authHint.textContent = '❌ ' + err.message;
                    authHint.style.display = 'block';
                    authHint.style.color = 'var(--status-error)';
                } else {
                    alert('Failed to start sign-in flow: ' + err.message);
                }
            } finally {
                loginMfaBtn.disabled = false;
                loginMfaBtn.textContent = '🔐 Sign in with MFA';
            }
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            if (confirm('Clear all cached authentication tokens? You will need to re-login on next server restart.')) {
                try {
                    const response = await fetch(`${API}/auth/logout?service=all`, { method: 'POST' });
                    const data = await response.json();
                    
                    const authHint = document.getElementById('authHint');
                    authHint.textContent = '✅ ' + data.message;
                    authHint.style.display = 'block';
                    authHint.style.color = 'var(--status-ok)';
                    
                    // Reload auth status after 2 seconds
                    setTimeout(() => {
                        loadAuthStatus();
                        authHint.style.color = 'var(--text-muted)';
                    }, 2000);
                } catch (err) {
                    alert('Failed to clear tokens: ' + err.message);
                }
            }
        });
    }
}

function updateConnectionDot(dotId, cardId, status, name) {
    const dotEl = document.getElementById(dotId);
    const cardEl = document.getElementById(cardId);
    const indicator = cardEl.querySelector('.status-indicator');
    const detail = cardEl.querySelector('.status-detail');

    if (status.connected) {
        dotEl.className = 'dot-item connected';
        indicator.className = 'status-indicator connected';
        indicator.textContent = '● Connected';
        // show some identifying detail: database for SQL, factory and RG for ADF
        if (status.database) {
            detail.textContent = status.database;
        } else if (status.factoryName) {
            detail.textContent = status.factoryName + (status.resourceGroup ? ` (${status.resourceGroup})` : '');
        } else {
            detail.textContent = 'Ready';
        }
    } else {
        dotEl.className = 'dot-item disconnected';
        indicator.className = 'status-indicator disconnected';
        indicator.textContent = '● Disconnected';
        detail.textContent = status.error || 'Check .env configuration';
    }
}

// ── Blob Explorer ────────────────────────────────
async function loadContainers() {
    const list = document.getElementById('containerList');
    try {
        const data = await fetchJSON(`${API}/blobs`);
        if (!data.containers?.length) {
            list.innerHTML = '<div class="empty-hint">No containers found</div>';
            return;
        }
        list.innerHTML = data.containers.map((c) =>
            `<div class="container-item" onclick="selectContainer('${esc(c.name)}')" data-name="${esc(c.name)}">📦 ${esc(c.name)}</div>`
        ).join('');
    } catch (err) {
        list.innerHTML = `<div class="empty-hint">Error: ${esc(err.message)}</div>`;
    }
}

window.selectContainer = async function (name) {
    currentContainer = name;
    document.querySelectorAll('.container-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.name === name);
    });
    document.getElementById('explorerPath').textContent = name + '/';

    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '<div class="loading-small">Loading files...</div>';

    try {
        const data = await fetchJSON(`${API}/blobs/${encodeURIComponent(name)}`);
        if (!data.blobs?.length) {
            fileList.innerHTML = '<div class="empty-hint">No files in this container</div>';
            return;
        }
        fileList.innerHTML = data.blobs.map((b) => `
      <div class="file-item" onclick="selectFile('${esc(name)}', '${esc(b.name)}')" data-name="${esc(b.name)}">
        <span class="file-icon">${getFileIcon(b.format)}</span>
        <span class="file-name">${esc(b.name)}</span>
        <span class="file-format">${esc(b.format)}</span>
        <span class="file-meta">${formatBytes(b.size)}</span>
      </div>
    `).join('');
    } catch (err) {
        fileList.innerHTML = `<div class="empty-hint">Error: ${esc(err.message)}</div>`;
    }
};

window.selectFile = async function (container, file) {
    currentFile = file;
    document.querySelectorAll('.file-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.name === file);
    });

    const preview = document.getElementById('previewContent');
    preview.innerHTML = '<div class="loading-small">Analyzing schema...</div>';

    try {
        const data = await fetchJSON(`${API}/blobs/${encodeURIComponent(container)}/preview?file=${encodeURIComponent(file)}`);
        if (data.schema?.columns?.length) {
            currentPreviewColumns = data.schema.columns.map(c => ({ ...c }));
            preview.innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
          ${data.schema.rowCount} rows • ${data.schema.columns.length} columns • ${data.properties?.format}
        </p>
        <div id="previewSchemaContainer"></div>
        ${data.ddl ? `<details style="margin-top:12px;"><summary style="font-size:11px;cursor:pointer;color:var(--accent-blue);">View CREATE TABLE DDL</summary><pre id="previewDdl" style="font-size:11px;margin-top:8px;color:var(--text-secondary);white-space:pre-wrap;">${esc(data.ddl)}</pre></details>` : ''}
      `;
            // render editable schema
            renderSchemaEditor('previewSchemaContainer', currentPreviewColumns, { allowEdit: true });
            // update DDL on any changes
            document.getElementById('previewSchemaContainer').addEventListener('change', () => {
                const ddlEl = document.getElementById('previewDdl');
                if (ddlEl) ddlEl.textContent = generateDDLClient(file.replace(/\.[^.]+$/, ''), currentPreviewColumns, 'dbo');
            });
        } else {
            preview.innerHTML = '<div class="empty-hint">Could not detect schema</div>';
        }
    } catch (err) {
        preview.innerHTML = `<div class="empty-hint">Error: ${esc(err.message)}</div>`;
    }
};

// ── Migrate View ─────────────────────────────────
async function loadMigrateContainers() {
    const containerSelect = document.getElementById('migrateContainer');
    const tableSelect = document.getElementById('migrateTable');
    const schemaSelect = document.getElementById('migrateSchema');
    const pipelineSelect = document.getElementById('migratePipeline');
    
    try {
        const data = await fetchJSON(`${API}/blobs`);
        const options = (data.containers || []).map((c) =>
            `<option value="${esc(c.name)}">${esc(c.name)}</option>`
        ).join('');
        containerSelect.innerHTML = '<option value="">Select container...</option>' + options;

        const pipelineData = await fetchJSON(`${API}/pipelines`);
        const pipelineOptions = (pipelineData.pipelines || []).map((p) =>
            `<option value="${esc(p.name)}">${esc(p.name)}</option>`
        ).join('');
        pipelineSelect.innerHTML = '<option value="">(use generated)</option>' + pipelineOptions;

        const schemaData = await fetchJSON(`${API}/sql/schemas`);
        const schemaOptions = (schemaData.schemas || ['dbo']).map((s) =>
            `<option value="${esc(s)}">${esc(s)}</option>`
        ).join('');
        schemaSelect.innerHTML = schemaOptions;

        const tableData = await fetchJSON(`${API}/sql/tables`);
        const tableOptions = (tableData.tables || []).map((t) =>
            `<option value="${esc(t.name)}">${esc(t.name)}</option>`
        ).join('');
        tableSelect.innerHTML = '<option value="">Select existing table...</option><option value="__new__">-- Create new table --</option>' + tableOptions;
        tableSelect.addEventListener('change', updateTableField);
        updateTableField();

        containerSelect.addEventListener('change', async () => {
            const blobSelect = document.getElementById('migrateBlob');
            if (!containerSelect.value) { blobSelect.innerHTML = '<option value="">Select files...</option>'; return; }
            const blobData = await fetchJSON(`${API}/blobs/${encodeURIComponent(containerSelect.value)}`);
            const blobOptions = (blobData.blobs || [])
                .filter((b) => ['CSV', 'JSON', 'JSONL', 'TSV', 'Parquet'].includes(b.format))
                .map((b) => `<option value="${esc(b.name)}">${esc(b.name)} (${b.format}, ${formatBytes(b.size)})</option>`)
                .join('');
            blobSelect.innerHTML = '<option value="">Select files...</option>' + blobOptions;
            blobSelect.multiple = true;
        });

        document.getElementById('migrateBlob').addEventListener('change', () => {
            const blobSelect = document.getElementById('migrateBlob');
            const selected = Array.from(blobSelect.selectedOptions).map(o => o.value);
            if (selected.length === 1) {
                const tableName = selected[0].replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_');
                tableSelect.value = '__new__';
                tableSelect.dataset.tableName = tableName;
                updateTableField();
            }
            // clear any previous preview columns/DDL
            migratePreviewColumns = null;
            document.getElementById('migrateSchemaPreview').style.display = 'none';
            document.getElementById('pipelinePreview').style.display = 'none';
        });
    } catch (err) {
        console.error('Failed to load containers:', err);
    }
}

// ── SharePoint Explorer ─────────────────────────
// state for current SharePoint folder
let currentSPPath = '';

// enhanced folder navigation for SharePoint explorer
async function loadSPFolder(spPath) {
    currentSPPath = spPath;
    document.getElementById('spPath').textContent = spPath;

    const folderList = document.getElementById('spFolderList');
    const fileList = document.getElementById('spFileList');
    folderList.innerHTML = '<div class="loading-small">Loading folders...</div>';
    fileList.innerHTML = '<div class="loading-small">Loading files...</div>';

    try {
        const res = await fetchJSON(`${API}/sharepoint/list?path=${encodeURIComponent(spPath)}`);
        const items = res.items || [];

        // back link
        const parts = spPath.split('/');
        if (parts.length > 1) {
            const parent = parts.slice(0, -1).join('/');
            folderList.innerHTML = `<div class="container-item" onclick="loadSPFolder('${esc(parent)}')"> ..</div>`;
        } else {
            folderList.innerHTML = '';
        }

        const folderHtml = items.map(it => {
            if (it.folder) {
                const childPath = `${spPath}/${it.name}`;
                return `<div class="container-item" onclick="loadSPFolder('${esc(childPath)}')"> ${esc(it.name)}</div>`;
            }
            return '';
        }).join('');
        folderList.innerHTML += folderHtml || '<div class="empty-hint">No folders</div>';

        if (spPath === 'Shared Documents') {
            const containers = await fetchJSON(`${API}/blobs`);
            const select = document.getElementById('spTargetContainer');
            select.innerHTML = '<option value="">Select target container...</option>' + (containers.containers || []).map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
        }

        if (!items.some(i => i.file)) {
            fileList.innerHTML = '<div class="empty-hint">No files in this folder</div>';
        } else {
            fileList.innerHTML = items.map((it) => {
                if (it.folder) return `<div class="file-item"><span class="file-icon"></span> <span class="file-name">${esc(it.name)}</span></div>`;
                return `
      <div class="file-item sp-file-row">
        <input type="checkbox" class="sp-file-checkbox" data-id="${esc(it.id)}" data-name="${esc(it.name)}" />
        <span class="file-icon"></span>
        <span class="file-name">${esc(it.name)}</span>
      </div>`;
            }).join('');
        }

        const cleanBox = document.getElementById('spUseCleaning');
        if (cleanBox) {
            const base = spPath.split('/')[1] || '';
            cleanBox.checked = (/^aetna$/i).test(base);
        }

        document.getElementById('spSelectAll').addEventListener('click', () => {
            document.querySelectorAll('.sp-file-checkbox').forEach(cb => cb.checked = true);
        });
        document.getElementById('spClearAll').addEventListener('click', () => {
            document.querySelectorAll('.sp-file-checkbox').forEach(cb => cb.checked = false);
        });
        document.getElementById('spMigrateBtn').addEventListener('click', migrateSelectedSP);
    } catch (err) {
        folderList.innerHTML = `<div class="empty-hint">Error: ${esc(err.message)}</div>`;
        fileList.innerHTML = `<div class="empty-hint">Error: ${esc(err.message)}</div>`;
    }
}

// helper wrapper
async function loadSharePointRoot() {
    await loadSPFolder('Shared Documents');
}

window.selectSPFolder = loadSPFolder;

async function migrateSelectedSP() {
    const checked = Array.from(document.querySelectorAll('.sp-file-checkbox:checked'));
    if (!checked.length) return alert('No files selected');
    const items = checked.map(cb => ({ id: cb.dataset.id, name: cb.dataset.name }));
    const container = document.getElementById('spTargetContainer').value;
    if (!container) return alert('Select a target container first');
    const clean = document.getElementById('spUseCleaning').checked;

    const btn = document.getElementById('spMigrateBtn');
    btn.disabled = true; btn.textContent = '⏳ Migrating...';

    try {
        const body = { items, containerName: container, prefix: '' };
        if (clean) {
            body.clean = true;
            body.folderPath = currentSPPath; // include path so cleaner can detect project
        }
        const res = await fetchJSON(`${API}/sharepoint/migrate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        btn.textContent = '✅ Done';
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Migrate Selected'; }, 1500);

        // Show results in preview panel
        const preview = document.getElementById('spPreviewContent');
        preview.innerHTML = `<pre style="font-size:12px;white-space:pre-wrap;color:var(--text-secondary);">${esc(JSON.stringify(res.result || res, null, 2))}</pre>`;
    } catch (err) {
        btn.disabled = false; btn.textContent = 'Migrate Selected';
        alert('Migration failed: ' + err.message);
    }
}

function setupMigrateForm() {
    document.getElementById('previewBtn').addEventListener('click', previewPipeline);
    document.getElementById('migrateForm').addEventListener('submit', startMigration);
}

function getTableName() {
    const sel = document.getElementById('migrateTable');
    const newInput = document.getElementById('migrateTableNew');
    if (!sel) return '';
    if (sel.value === '__new__') {
        return newInput ? newInput.value.trim() : '';
    }
    return sel.value;
}

function updateTableField() {
    const sel = document.getElementById('migrateTable');
    const newInput = document.getElementById('migrateTableNew');
    if (!sel || !newInput) return;
    if (sel.value === '__new__') {
        newInput.style.display = 'block';
        newInput.required = true;
        // if we stored an auto-suggest name, populate it
        if (sel.dataset.tableName) {
            newInput.value = sel.dataset.tableName;
            delete sel.dataset.tableName;
        }
    } else {
        newInput.style.display = 'none';
        newInput.required = false;
    }
}

async function previewPipeline() {
    const container = document.getElementById('migrateContainer').value;
    const blobSelect = document.getElementById('migrateBlob');
    const blobs = Array.from(blobSelect.selectedOptions).map(o => o.value);
    const blob = blobs[0];
    const table = getTableName();
    const schema = document.getElementById('migrateSchema').value || 'dbo';

    if (!container || blobs.length === 0 || !table) { alert('Please fill in all fields'); return; }

    const preview = document.getElementById('pipelinePreview');
    const json = document.getElementById('pipelineJson');
    preview.style.display = 'block';
    json.textContent = 'Generating pipeline definition...';

    try {
        const payload = { containerName: container, blobName: blob, tableName: table, schema };
        const pipelineChoice = document.getElementById('migratePipeline')?.value;
        if (pipelineChoice) payload.pipelineName = pipelineChoice;
        if (migratePreviewColumns) {
            payload.columns = migratePreviewColumns;
        }
        const data = await fetchJSON(`${API}/pipelines/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        json.textContent = JSON.stringify(data.pipelineDefinition?.pipeline || data, null, 2);

        // Show schema preview too
        if (data.schema?.columns?.length) {
            migratePreviewColumns = data.schema.columns.map(c => ({ ...c }));
            const schemaBox = document.getElementById('migrateSchemaPreview');
            schemaBox.style.display = 'block';
            // render editable table
            renderSchemaEditor('migrateSchemaContent', migratePreviewColumns, { allowEdit: true });
            // optionally show row count
            const info = schemaBox.querySelector('p');
            if (info) info.textContent = `${data.schema.rowCount} rows • ${data.schema.columns.length} columns`;
        }
    } catch (err) {
        json.textContent = `Error: ${err.message}`;
    }
}

async function startMigration(e) {
    e.preventDefault();
    const container = document.getElementById('migrateContainer').value;
    const blobSelect = document.getElementById('migrateBlob');
    const blobs = Array.from(blobSelect.selectedOptions).map(o => o.value);
    const table = getTableName();
    const schema = document.getElementById('migrateSchema').value || 'dbo';

    if (!container || blobs.length === 0 || !table) return;

    const btn = document.getElementById('migrateBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Starting...';

    try {
        const payload = {
            containerName: container,
            tableName: table,
            schema,
            useAdf,
        };
        const pipelineChoice = document.getElementById('migratePipeline')?.value;
        if (pipelineChoice) payload.pipelineName = pipelineChoice;
        if (blobs.length === 1) {
            payload.blobName = blobs[0];
        } else {
            payload.blobNames = blobs;
        }
        if (migratePreviewColumns) {
            payload.columns = migratePreviewColumns;
        }
        const data = await fetchJSON(`${API}/migrate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        btn.textContent = '✅ Started!';
        setTimeout(() => { btn.disabled = false; btn.textContent = '🚀 Start Migration'; }, 2000);

        // Switch to jobs view
        document.querySelector('[data-view="jobs"]').click();
        if (data.jobId) loadJobDetail(data.jobId);
    } catch (err) {
        btn.disabled = false;
        btn.textContent = '🚀 Start Migration';
        alert(`Migration failed: ${err.message}`);
    }
}

// ── Jobs View ────────────────────────────────────
async function loadJobs() {
    const list = document.getElementById('jobsList');
    try {
        const data = await fetchJSON(`${API}/jobs`);
        const jobs = data.jobs || [];
        document.getElementById('jobBadge').textContent = jobs.length;

        if (!jobs.length) {
            list.innerHTML = '<div class="empty-hint">No migration jobs yet. Start one from the Migrate tab.</div>';
            return;
        }

        list.innerHTML = jobs.map((job) => `
      <div class="job-card" onclick="loadJobDetail('${esc(job.id)}')">
        <div class="job-status-dot ${esc(job.status)}"></div>
        <div class="job-info">
          <h4>${esc(job.blobName)}</h4>
          <p>${esc(job.containerName)} → [${esc(job.tableName)}]</p>
        </div>
        <span class="job-step">${esc(job.step || job.status)}</span>
        <span class="job-rows">${job.rowsInserted ? job.rowsInserted + ' rows' : ''}</span>
        <span class="job-meta">${timeAgo(job.createdAt)}</span>
      </div>
    `).join('');

        // Auto-refresh if any jobs are running
        const hasRunning = jobs.some((j) => !['completed', 'failed'].includes(j.status));
        if (hasRunning) {
            if (!jobPollInterval) jobPollInterval = setInterval(loadJobs, 3000);
        } else {
            if (jobPollInterval) { clearInterval(jobPollInterval); jobPollInterval = null; }
        }
    } catch (err) {
        list.innerHTML = `<div class="empty-hint">Error: ${esc(err.message)}</div>`;
    }
}

window.loadJobDetail = async function (jobId) {
    const panel = document.getElementById('jobDetailPanel');
    panel.style.display = 'block';

    try {
        const job = await fetchJSON(`${API}/jobs/${jobId}`);
        document.getElementById('jobDetailContent').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;">
        <div><strong>Job ID:</strong> ${esc(job.id)}</div>
        <div><strong>Status:</strong> <span class="job-step">${esc(job.step || job.status)}</span></div>
        <div><strong>Source:</strong> ${esc(job.containerName)}/${esc(job.blobName)}</div>
        <div><strong>Target:</strong> [${esc(job.schema || 'dbo')}].[${esc(job.tableName)}]</div>
        <div><strong>Format:</strong> ${esc(job.fileFormat || '—')}</div>
        <div><strong>Mode:</strong> ${job.useAdf ? 'ADF Pipeline' : 'Direct Insert'}</div>
        ${job.pipelineName ? `<div><strong>Pipeline:</strong> ${esc(job.pipelineName)}</div>` : ''}
        ${job.rowsInserted ? `<div><strong>Rows:</strong> <span style="color:var(--accent-emerald);font-weight:700;">${job.rowsInserted}</span></div>` : ''}
      </div>
    `;

        const logEntries = document.getElementById('logEntries');
        if (job.logs?.length) {
            logEntries.innerHTML = job.logs.map((log) => `
        <div class="log-entry ${log.level}">
          <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
          <span class="log-msg">${esc(log.message)}</span>
        </div>
      `).join('');
            logEntries.scrollTop = logEntries.scrollHeight;
        }

        // Auto-refresh if still running
        if (!['completed', 'failed'].includes(job.status)) {
            setTimeout(() => loadJobDetail(jobId), 2000);
        }
    } catch (err) {
        document.getElementById('jobDetailContent').innerHTML = `<div class="empty-hint">Error: ${esc(err.message)}</div>`;
    }
};

// ── Utilities ────────────────────────────────────
async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, opts);
    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return res.json();
}

function getFileIcon(format) {
    const icons = { CSV: '📊', TSV: '📊', JSON: '📋', JSONL: '📋', Parquet: '📦', Excel: '📗', XML: '📄', Text: '📝' };
    return icons[format] || '📄';
}

function formatBytes(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}

// ── Cleaning Dashboard ──────────────────────────────

async function loadCleaningDashboard() {
    await Promise.all([
        loadCleaningStatus(),
        loadCleaningStats(),
        loadFailedFiles()
    ]);
}

async function loadCleaningStatus() {
    try {
        const response = await fetch(`${API}/cleaning/status`);
        const data = await response.json();

        document.getElementById('cleaningStatus').textContent = data.status || 'Unknown';
        document.getElementById('lastScanTime').textContent = data.last_scan ?
            new Date(data.last_scan).toLocaleString() : 'Never';
        document.getElementById('filesProcessedToday').textContent = data.files_processed_today || 0;
        document.getElementById('pendingFiles').textContent = data.pending_files || 0;
        document.getElementById('failedFiles').textContent = data.failed_files || 0;
    } catch (error) {
        console.error('Failed to load cleaning status:', error);
        document.getElementById('cleaningStatus').textContent = 'Error';
    }
}

async function loadCleaningStats() {
    try {
        const response = await fetch(`${API}/cleaning/stats`);
        const data = await response.json();

        renderProjectStats(data.statistics || []);
    } catch (error) {
        console.error('Failed to load cleaning stats:', error);
        document.getElementById('projectsTable').innerHTML =
            '<div class="empty-hint">Failed to load statistics</div>';
    }
}

function renderProjectStats(stats) {
    const container = document.getElementById('projectsTable');

    if (!stats || stats.length === 0) {
        container.innerHTML = '<div class="empty-hint">No processing statistics available</div>';
        return;
    }

    // Group by project
    const projectStats = {};
    stats.forEach(stat => {
        const project = stat.ProjectName;
        if (!projectStats[project]) {
            projectStats[project] = { success: 0, failed: 0, avgTime: 0 };
        }
        if (stat.ProcessingStatus === 'Success') {
            projectStats[project].success = stat.Count;
            projectStats[project].avgTime = stat.AvgProcessingTimeMs || 0;
        } else if (stat.ProcessingStatus === 'Failed') {
            projectStats[project].failed = stat.Count;
        }
    });

    const html = Object.entries(projectStats).map(([project, stats]) => `
        <div class="project-stat-item">
            <div class="project-name">${esc(project)}</div>
            <div class="stat-number">${stats.success + stats.failed}</div>
            <div class="stat-label">Total Processed</div>
        </div>
        <div class="project-stat-item">
            <div class="project-name">Success Rate</div>
            <div class="stat-number">${stats.success + stats.failed > 0 ?
                Math.round((stats.success / (stats.success + stats.failed)) * 100) : 0}%</div>
            <div class="stat-label">Success</div>
        </div>
        <div class="project-stat-item">
            <div class="project-name">Failed</div>
            <div class="stat-number error">${stats.failed}</div>
            <div class="stat-label">Files</div>
        </div>
        <div class="project-stat-item">
            <div class="project-name">Avg Time</div>
            <div class="stat-number">${stats.avgTime > 0 ? Math.round(stats.avgTime / 1000) : 0}s</div>
            <div class="stat-label">Processing</div>
        </div>
    `).join('');

    container.innerHTML = html;
}

async function loadFailedFiles() {
    try {
        const response = await fetch(`${API}/cleaning/failed-files`);
        const data = await response.json();

        renderFailedFiles(data.failed_files || []);
    } catch (error) {
        console.error('Failed to load failed files:', error);
        document.getElementById('failedFilesTable').innerHTML =
            '<div class="empty-hint">Failed to load failed files</div>';
    }
}

function renderFailedFiles(failedFiles) {
    const container = document.getElementById('failedFilesTable');

    if (!failedFiles || failedFiles.length === 0) {
        container.innerHTML = '<div class="empty-hint">No failed files to display</div>';
        return;
    }

    const html = failedFiles.map(file => {
        const missingHtml = file.missing_columns && file.missing_columns.length
            ? `<div class="missing-columns">Missing: ${esc(file.missing_columns.join(', '))}</div>`
            : '';
        return `
        <div class="failed-file-item">
            <div class="file-name">${esc(file.FileName || file.filename)}</div>
            <div class="project-badge">${esc(file.ProjectName || file.project)}</div>
            <div class="error-message" title="${esc(file.ErrorMessage || file.error_message)}">${esc(file.ErrorMessage || file.error_message)}</div>
            ${missingHtml}
            <div class="timestamp">${new Date(file.ProcessingStartTime || file.failed_at).toLocaleString()}</div>
        </div>
    `;
    }).join('');

    container.innerHTML = html;
}

// Setup cleaning dashboard event listeners
function setupCleaningDashboard() {
    // Trigger scan button
    document.getElementById('triggerScanBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('triggerScanBtn');
        const originalText = btn.textContent;
        btn.textContent = '🔄 Scanning...';
        btn.disabled = true;

        try {
            const response = await fetch(`${API}/cleaning/scan`, { method: 'POST' });
            const data = await response.json();

            if (response.ok) {
                showToast('Cleaning scan initiated successfully', 'success');
                // Refresh status after a short delay
                setTimeout(loadCleaningStatus, 2000);
            } else {
                showToast(`Failed to start scan: ${data.error}`, 'error');
            }
        } catch (error) {
            showToast(`Error starting scan: ${error.message}`, 'error');
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    });

    // Refresh stats button
    document.getElementById('refreshStatsBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('refreshStatsBtn');
        const originalText = btn.textContent;
        btn.textContent = '📊 Refreshing...';
        btn.disabled = true;

        try {
            await loadCleaningDashboard();
            showToast('Statistics refreshed', 'success');
        } catch (error) {
            showToast(`Failed to refresh: ${error.message}`, 'error');
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    });
}

function esc(text) {
    if (!text) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
}

