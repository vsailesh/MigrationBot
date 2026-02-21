// ═══════════════════════════════════════════════════
// MigrationBot — Frontend Application
// ═══════════════════════════════════════════════════

const API = window.location.origin + '/api';
let currentView = 'status';
let currentContainer = null;
let currentFile = null;
let useAdf = true;
let jobPollInterval = null;

// ── Initialization ───────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupModeToggle();
    setupMigrateForm();
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
    } catch (err) {
        console.error('Status check failed:', err);
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
        detail.textContent = status.database || status.factoryName || 'Ready';
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
            preview.innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
          ${data.schema.rowCount} rows • ${data.schema.columns.length} columns • ${data.properties?.format}
        </p>
        <table class="schema-table">
          <thead><tr><th>Column</th><th>Type</th><th>Sample</th></tr></thead>
          <tbody>
            ${data.schema.columns.map((col) => `
              <tr>
                <td><strong>${esc(col.name)}</strong></td>
                <td><span class="type-badge">${esc(col.sqlType)}</span></td>
                <td>${esc(col.sampleValues?.[0] || '—')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${data.ddl ? `<details style="margin-top:12px;"><summary style="font-size:11px;cursor:pointer;color:var(--accent-blue);">View CREATE TABLE DDL</summary><pre style="font-size:11px;margin-top:8px;color:var(--text-secondary);white-space:pre-wrap;">${esc(data.ddl)}</pre></details>` : ''}
      `;
        } else {
            preview.innerHTML = '<div class="empty-hint">Could not detect schema</div>';
        }
    } catch (err) {
        preview.innerHTML = `<div class="empty-hint">Error: ${esc(err.message)}</div>`;
    }
};

// ── Migrate View ─────────────────────────────────
async function loadMigrateContainers() {
    const select = document.getElementById('migrateContainer');
    try {
        const data = await fetchJSON(`${API}/blobs`);
        const options = (data.containers || []).map((c) =>
            `<option value="${esc(c.name)}">${esc(c.name)}</option>`
        ).join('');
        select.innerHTML = '<option value="">Select container...</option>' + options;

        select.addEventListener('change', async () => {
            const blobSelect = document.getElementById('migrateBlob');
            if (!select.value) { blobSelect.innerHTML = '<option value="">Select file...</option>'; return; }
            const blobData = await fetchJSON(`${API}/blobs/${encodeURIComponent(select.value)}`);
            const blobOptions = (blobData.blobs || [])
                .filter((b) => ['CSV', 'JSON', 'JSONL', 'TSV', 'Parquet'].includes(b.format))
                .map((b) => `<option value="${esc(b.name)}">${esc(b.name)} (${b.format}, ${formatBytes(b.size)})</option>`)
                .join('');
            blobSelect.innerHTML = '<option value="">Select file...</option>' + blobOptions;
        });

        document.getElementById('migrateBlob').addEventListener('change', () => {
            const blobName = document.getElementById('migrateBlob').value;
            if (blobName) {
                const tableName = blobName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_');
                document.getElementById('migrateTable').value = tableName;
            }
        });
    } catch (err) {
        console.error('Failed to load containers:', err);
    }
}

function setupMigrateForm() {
    document.getElementById('previewBtn').addEventListener('click', previewPipeline);
    document.getElementById('migrateForm').addEventListener('submit', startMigration);
}

async function previewPipeline() {
    const container = document.getElementById('migrateContainer').value;
    const blob = document.getElementById('migrateBlob').value;
    const table = document.getElementById('migrateTable').value;
    const schema = document.getElementById('migrateSchema').value || 'dbo';

    if (!container || !blob || !table) { alert('Please fill in all fields'); return; }

    const preview = document.getElementById('pipelinePreview');
    const json = document.getElementById('pipelineJson');
    preview.style.display = 'block';
    json.textContent = 'Generating pipeline definition...';

    try {
        const data = await fetchJSON(`${API}/pipelines/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ containerName: container, blobName: blob, tableName: table, schema }),
        });
        json.textContent = JSON.stringify(data.pipelineDefinition?.pipeline || data, null, 2);

        // Show schema preview too
        if (data.schema?.columns?.length) {
            const schemaBox = document.getElementById('migrateSchemaPreview');
            schemaBox.style.display = 'block';
            document.getElementById('migrateSchemaContent').innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${data.schema.rowCount} rows • ${data.schema.columns.length} columns</p>
        <table class="schema-table"><thead><tr><th>Column</th><th>SQL Type</th></tr></thead>
        <tbody>${data.schema.columns.map((c) => `<tr><td>${esc(c.name)}</td><td><span class="type-badge">${esc(c.sqlType)}</span></td></tr>`).join('')}</tbody></table>
      `;
        }
    } catch (err) {
        json.textContent = `Error: ${err.message}`;
    }
}

async function startMigration(e) {
    e.preventDefault();
    const container = document.getElementById('migrateContainer').value;
    const blob = document.getElementById('migrateBlob').value;
    const table = document.getElementById('migrateTable').value;
    const schema = document.getElementById('migrateSchema').value || 'dbo';

    if (!container || !blob || !table) return;

    const btn = document.getElementById('migrateBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Starting...';

    try {
        const data = await fetchJSON(`${API}/migrate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ containerName: container, blobName: blob, tableName: table, schema, useAdf }),
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

function esc(text) {
    if (!text) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
}
