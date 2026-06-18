import express from 'express';
import fs from 'fs';
import path from 'path';
import { testBlobConnection, listContainers, listBlobs, downloadBlobContent, getBlobProperties } from '../azure/blobClient.js';
import { testSqlConnection, listTables, getTableColumns } from '../azure/sqlClient.js';
import { testAdfConnection, listPipelines, createBlobEventTrigger, startTrigger, stopTrigger, triggerPipelineRun } from '../azure/adfClient.js';
import { testSharePointConnection, syncSharePointFolder, getSiteId, downloadItemContent, getBlobContainerClient, uploadBufferToBlob } from '../azure/sharepointClient.js';
import { listSharePointFolder, migrateSelectedItems, debugSite } from '../azure/sharepointClient.js';
import { detectSchema, generateDDL, validateColumns } from '../engine/schemaDetector.js';
import { generatePipelineDefinition } from '../engine/pipelineGenerator.js';
import { runMigration } from '../engine/migrationRunner.js';
import { getJobs, getJob } from '../store.js';
import { TokenCache } from '../azure/tokenCache.js';
import { loginWithDeviceCode } from '../azure/sqlClient.js';
import DataCleaner from '../dataCleaner.js';
import aetnaService from '../cleaners/aetna_cleaning.js';
import carefirstService from '../cleaners/cfmd_cleaning.js';
const router = express.Router();

// ════════════════════════════════════════════════════
// Connection Status
// ════════════════════════════════════════════════════

router.get('/status', async (req, res) => {
    const [blob, sql, adf] = await Promise.allSettled([
        testBlobConnection(),
        testSqlConnection(),
        testAdfConnection(),
    ]);

    res.json({
        blob: blob.status === 'fulfilled' ? blob.value : { connected: false, error: blob.reason?.message },
        sql: sql.status === 'fulfilled' ? sql.value : { connected: false, error: sql.reason?.message },
        adf: adf.status === 'fulfilled' ? adf.value : { connected: false, error: adf.reason?.message },
        sharepoint: await (async () => {
            try {
                return await testSharePointConnection();
            } catch (e) { return { connected: false, error: e?.message } }
        })(),
    });
});

// ════════════════════════════════════════════════════
// Authentication Management
// ════════════════════════════════════════════════════

/**
 * GET /api/auth/status — Show cached authentication tokens
 */
router.get('/auth/status', (req, res) => {
    const tokens = TokenCache.getAllTokens();
    const status = {};
    
    Object.keys(tokens).forEach(service => {
        const entry = tokens[service];
        status[service] = {
            cached: true,
            expiresIn: Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000)),
            cachedAt: new Date(entry.timestamp).toISOString()
        };
    });
    
    res.json({ cached_tokens: status });
});

/**
 * POST /api/auth/login — Trigger MFA/device-code login flow from the UI
 */
router.post('/auth/login', async (req, res) => {
    try {
        const result = await loginWithDeviceCode();
        res.json({
            ok: true,
            service: 'sql',
            message: result.message,
            details: result,
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /api/auth/logout — Clear cached authentication tokens
 * Query param: ?service=sql (or 'all' to clear all)
 */
router.post('/auth/logout', (req, res) => {
    const service = (req.query.service || 'all').toLowerCase();
    
    try {
        if (service === 'all') {
            TokenCache.clearAll();
            res.json({ message: 'All authentication tokens cleared. You will need to re-authenticate on next server restart.' });
        } else {
            TokenCache.clearToken(service);
            res.json({ message: `Authentication token for ${service} cleared. You will need to re-authenticate on next server restart.` });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear tokens: ' + err.message });
    }
});

    // ════════════════════════════════════════════════════
    // SharePoint: list and migrate selected files
    // ════════════════════════════════════════════════════

    router.get('/sharepoint/list', async (req, res) => {
        try {
            const path = req.query.path || 'Shared Documents';
            const items = await listSharePointFolder(path);
            res.json({ path, items });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/sharepoint/migrate', async (req, res) => {
        try {
            const { items, containerName, prefix = '', clean = false, folderPath = '' } = req.body;
            if (!items || !Array.isArray(items) || !containerName) {
                return res.status(400).json({ error: 'items (array) and containerName are required' });
            }

            // When clean=true we'll run the DataCleaner pipeline instead of a simple upload.
            // The caller may also provide the current SharePoint folderPath which helps the
            // cleaner determine project name (e.g. "Shared Documents/Aetna").
            const siteId = await getSiteId();
            const containerClient = getBlobContainerClient();
            const migrated = [];
            const cleaned = [];

            // determine project from folderPath (Shared Documents/{project}/...)
            let projectName = '';
            if (folderPath) {
                const segs = folderPath.split('/').filter(s => s && s.toLowerCase() !== 'shared documents');
                if (segs.length > 0) projectName = segs[0].toLowerCase();
            }

            for (const it of items) {
                if (!it || !it.id || !it.name) continue;
                try {
                    const content = await downloadItemContent(siteId, it.id);

                    // Clean if requested AND a schema exists for this project
                    if (clean && DataCleaner.hasSchema(projectName)) {
                        const fileInfo = {
                            id: it.id,
                            name: it.name,
                            sharepointPath: folderPath ? `${folderPath}/${it.name}` : it.name
                        };
                        const cleanRes = await DataCleaner.processFile(fileInfo, content);
                        cleaned.push({ name: it.name, result: cleanRes });
                    } else {
                        const blobPath = `${prefix}/${it.name}`.replace(/^\//, '');
                        await uploadBufferToBlob(containerClient, blobPath, content);
                        migrated.push({ name: it.name, blobPath });
                    }
                } catch (err) {
                    const record = { name: it.name, error: err.message };
                    if (clean && DataCleaner.hasSchema(projectName)) cleaned.push(record);
                    else migrated.push(record);
                }
            }

            res.json({ ok: true, migrated, cleaned });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

// Debug endpoint to inspect site and drive metadata
router.get('/sharepoint/debug', async (req, res) => {
    try {
        const dbg = await debugSite();
        res.json(dbg);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════
// Blob Container & File Operations
// ════════════════════════════════════════════════════

router.get('/blobs', async (req, res) => {
    try {
        const containers = await listContainers();
        res.json({ containers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/blobs/:container', async (req, res) => {
    try {
        const blobs = await listBlobs(req.params.container, req.query.prefix);
        res.json({ container: req.params.container, blobs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/blobs/:container/preview', async (req, res) => {
    try {
        const { file } = req.query;
        if (!file) return res.status(400).json({ error: 'file query param required' });

        const props = await getBlobProperties(req.params.container, file);
        const content = await downloadBlobContent(req.params.container, file, 512 * 1024); // 512KB preview
        const schema = detectSchema(content, props.format);
        const ddl = schema.columns.length > 0 ? generateDDL(file.replace(/\.[^.]+$/, ''), schema.columns) : null;

        res.json({ properties: props, schema, ddl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════
// SQL Database
// ════════════════════════════════════════════════════

router.get('/sql/tables', async (req, res) => {
    try {
        const tables = await listTables();
        res.json({ tables });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sql/tables/:name/columns', async (req, res) => {
    try {
        const columns = await getTableColumns(req.params.name, req.query.schema || 'dbo');
        res.json({ table: req.params.name, columns });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sql/schemas', async (req, res) => {
    try {
        const schemas = ['dbo', 'staging', 'archive'];
        res.json({ schemas });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════
// Pipeline Generation (Preview)
// ════════════════════════════════════════════════════

router.post('/pipelines/generate', async (req, res) => {
    try {
        const { containerName, blobName, tableName, schema = 'dbo' } = req.body;
        if (!containerName || !blobName || !tableName) {
            return res.status(400).json({ error: 'containerName, blobName, and tableName required' });
        }

        const props = await getBlobProperties(containerName, blobName);
        const content = await downloadBlobContent(containerName, blobName, 512 * 1024);
        let schemaResult;

        if (req.body.columns && Array.isArray(req.body.columns)) {
            // user provided column overrides from frontend
            schemaResult = { columns: req.body.columns };
            // validate against the sample data
            const errors = validateColumns(content, props.format, schemaResult.columns);
            if (errors.length) {
                return res.status(400).json({ error: errors.join('; ') });
            }
        } else {
            schemaResult = detectSchema(content, props.format);
            if (schemaResult.error) {
                return res.status(400).json({ error: schemaResult.error });
            }
        }

        const pipelineDef = generatePipelineDefinition({
            jobId: 'preview',
            containerName, blobName, tableName,
            columns: schemaResult.columns,
            format: props.format,
            schema,
        });

        const ddl = generateDDL(tableName, schemaResult.columns, schema);

        res.json({ schema: schemaResult, pipelineDefinition: pipelineDef, ddl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/pipelines', async (req, res) => {
    try {
        const pipelines = await listPipelines();
        res.json({ pipelines });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════
// ADF Triggers
// ════════════════════════════════════════════════════

router.post('/triggers/create', async (req, res) => {
    try {
        const { triggerName, pipelineName, containerName, folderPath, fileName, parameters } = req.body;
        if (!triggerName || !pipelineName || !containerName || !folderPath || !fileName) {
            return res.status(400).json({ error: 'triggerName, pipelineName, containerName, folderPath, and fileName are required' });
        }

        const result = await createBlobEventTrigger({
            triggerName,
            pipelineName,
            containerName,
            folderPath,
            fileName,
            parameters: parameters || {}
        });

        // Start the trigger after creation
        await startTrigger(triggerName);

        res.json({ 
            success: true, 
            trigger: result, 
            message: `Trigger '${triggerName}' created and started successfully` 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/pipelines/trigger', async (req, res) => {
    try {
        const { pipelineName, parameters } = req.body;
        if (!pipelineName) {
            return res.status(400).json({ error: 'pipelineName is required' });
        }

        const result = await triggerPipelineRun(pipelineName, parameters || {});
        res.json({ 
            success: true, 
            run: result, 
            message: `Pipeline '${pipelineName}' triggered successfully` 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════
// Migration Jobs
// ════════════════════════════════════════════════════

router.post('/migrate', async (req, res) => {
    try {
        const {
            containerName,
            blobName,
            blobNames,
            tableName,
            schema = 'dbo',
            useAdf = true,
            columns: overrideColumns,
        } = req.body;

        // normalize list of blobs
        const blobs = Array.isArray(blobNames)
            ? blobNames
            : blobName
                ? [blobName]
                : [];

        if (!containerName || blobs.length === 0 || !tableName) {
            return res.status(400).json({ error: 'containerName, blobName(s), and tableName required' });
        }

        // start a migration for each blob
        const startedJobs = [];
        for (const b of blobs) {
            const params = { containerName, blobName: b, tableName, schema, useAdf };
            if (overrideColumns && Array.isArray(overrideColumns)) {
                params.columns = overrideColumns;
            }
            const promise = runMigration(params);
            startedJobs.push(promise);
            // fire and forget; errors logged below
            promise.catch((err) => console.error(`Migration error for ${b}:`, err));
        }

        // give jobs a moment to be recorded
        await new Promise((r) => setTimeout(r, 200));
        const jobs = getJobs();
        const recent = jobs.slice(0, blobs.length).map(j => j.id);

        res.json({ jobIds: recent, status: 'started', message: `Started ${blobs.length} migration job(s).` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/jobs', (req, res) => {
    res.json({ jobs: getJobs() });
});

router.get('/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// ════════════════════════════════════════════════════
// Data Cleaning System Integration
// ════════════════════════════════════════════════════

/**
 * GET /api/cleaning/status — Get cleaning system status
 */
router.get('/cleaning/status', async (req, res) => {
    try {
        const status = await DataCleaner.getStatus();
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/stats — Get processing statistics
 */
router.get('/cleaning/stats', async (req, res) => {
    try {
        const stats = await DataCleaner.getProcessingStats();
        res.json({
            statistics: stats,
            generated_at: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cleaning/scan — Trigger manual cleaning scan
 */
router.post('/cleaning/scan', async (req, res) => {
    try {
        const result = await DataCleaner.triggerManualScan();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/failed-files — Get list of failed files
 */
router.get('/cleaning/failed-files', async (req, res) => {
    try {
        const failedFiles = await DataCleaner.getFailedFiles();
        res.json({
            failed_files: failedFiles,
            total_count: failedFiles.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/projects — Get available projects and their schemas
 */
router.get('/cleaning/projects', async (req, res) => {
    try {
        const projects = await DataCleaner.getAvailableProjects();
        res.json({ projects });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/projects/:name/schema — Get schema details for a specific project
 */
router.get('/cleaning/projects/:name/schema', async (req, res) => {
    try {
        const schema = await DataCleaner.getProjectSchema(req.params.name);
        if (!schema) {
            return res.status(404).json({ error: 'Project schema not found' });
        }
        res.json({ project: req.params.name, schema });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cleaning/retry/:fileId — Retry processing a failed file
 */
router.post('/cleaning/retry/:fileId', async (req, res) => {
    try {
        const result = await DataCleaner.retryFailedFile(req.params.fileId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/logs — Get recent processing logs
 */
router.get('/cleaning/logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const logs = await DataCleaner.getProcessingLogs(limit);
        res.json({ logs });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ════════════════════════════════════════════════════
// Project-Specific Cleaning Endpoints
// ════════════════════════════════════════════════════

/**
 * POST /api/cleaning/aetna/process — Process file(s) for Aetna project
 * Body: { filePath: string } or { directory: string }
 */
router.post('/cleaning/aetna/process', async (req, res) => {
    try {
        const { filePath, directory } = req.body;
        
        if (!filePath && !directory) {
            return res.status(400).json({ error: 'filePath or directory required' });
        }

        let result;
        if (directory) {
            result = await aetnaService.processDirectory(directory);
        } else {
            result = await aetnaService.processFile(filePath);
        }

        res.json({
            project: 'aetna',
            result: Array.isArray(result) ? result : [result],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/aetna/schema — Get Aetna schema details
 */
router.get('/cleaning/aetna/schema', async (req, res) => {
    try {
        const schema = await aetnaService.getSchemaInfo();
        res.json(schema);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/aetna/stats — Get Aetna project statistics
 */
router.get('/cleaning/aetna/stats', async (req, res) => {
    try {
        const stats = aetnaService.getStatistics();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/cleaning/carefirst/process — Process file(s) for CareFirst project
 * Body: { filePath: string } or { directory: string }
 */
router.post('/cleaning/carefirst/process', async (req, res) => {
    try {
        const { filePath, directory } = req.body;
        
        if (!filePath && !directory) {
            return res.status(400).json({ error: 'filePath or directory required' });
        }

        let result;
        if (directory) {
            result = await carefirstService.processDirectory(directory);
        } else {
            result = await carefirstService.processFile(filePath);
        }

        res.json({
            project: 'carefirst',
            result: Array.isArray(result) ? result : [result],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/carefirst/schema — Get CareFirst schema details
 */
router.get('/cleaning/carefirst/schema', async (req, res) => {
    try {
        const schema = await carefirstService.getSchemaInfo();
        res.json(schema);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/carefirst/stats — Get CareFirst project statistics
 */
router.get('/cleaning/carefirst/stats', async (req, res) => {
    try {
        const stats = carefirstService.getStatistics();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ════════════════════════════════════════════════════
// JSON Table-Mapped Output Endpoint
// ════════════════════════════════════════════════════

/**
 * POST /api/cleaning/:project/process-to-json
 *
 * Run the cleaning pipeline for the given project and return cleaned data
 * grouped by destination SQL table as structured JSON, bypassing Excel output.
 *
 * Supported projects: aetna, carefirst (alias: cfmd)
 *
 * Body:
 *   { "filePath": "...", "directory": "...", "outputMode": "json" }
 *
 * Response:
 *   {
 *     "project": "aetna",
 *     "outputMode": "json",
 *     "tables": ["aetnaMemberTbl", "aetnaProviderTbl", ...],
 *     "result": { ...grouped JSON... },
 *     "timestamp": "..."
 *   }
 *
 * Notes:
 *   - outputMode defaults to 'json' for this endpoint; pass "excel" to override.
 *   - The per-request outputMode takes precedence over CLEANING_OUTPUT_MODE env var.
 *   - When a directory is supplied, 'result' contains an array of per-file objects,
 *     each with its own tableGroups.
 */


/**
 * POST /api/cleaning/:project/process-to-json-separate
 *
 * Run the cleaning pipeline for the given project and upload one JSON file per
 * destination table. This preserves existing behaviour but adds the option to
 * generate separate per-table JSON files (uploaded to blob storage) and returns
 * the list of uploaded blob paths.
 *
 * Body:
 *   { "filePath": "...", "directory": "...", "outputMode": "json" }
 *
 * Response (single file):
 *   { project, outputMode, tables, uploaded: ["blobPath1","blobPath2"], result: { ...grouped JSON... } }
 *
 */
router.post('/cleaning/:project/process-to-json-separate', async (req, res) => {
    try {
        const project = req.params.project.toLowerCase();
        const { filePath, directory, outputMode = 'json' } = req.body;

        if (!filePath && !directory) {
            return res.status(400).json({ error: 'filePath or directory required' });
        }

        // Supported projects
        const supported = ['aetna', 'carefirst', 'cfmd'];
        if (!supported.includes(project)) {
            return res.status(404).json({ error: `Unknown project "${project}". Supported: ${supported.join(', ')}` });
        }

        const options = { outputMode, separateTableFiles: true };

        if (directory) {
            // Process directory by invoking DataCleaner.processFile for each file
            if (!fs.existsSync(directory)) return res.status(400).json({ error: 'directory not found' });
            const files = fs.readdirSync(directory)
                .filter(f => /\.(xlsx|xls|csv)$/i.test(f))
                .map(f => path.join(directory, f));

            const results = [];
            for (const file of files) {
                try {
                    const buffer = fs.readFileSync(file);
                    const fileInfo = { id: path.basename(file), name: path.basename(file), sharepointPath: `Shared Documents/${project}` };
                    const result = await DataCleaner.processFile(fileInfo, buffer, options);

                    results.push({
                        file: path.basename(file),
                        success: result.success,
                        rowsProcessed: result.metadata?.rowCount || null,
                        uploadedBlobPaths: result.metadata?.uploadedBlobPaths || result.uploadedBlobPaths || [] ,
                        error: result.error || null
                    });
                } catch (err) {
                    results.push({ file: path.basename(file), success: false, error: err.message });
                }
            }

            const tables = [...new Set(results.flatMap(r => (r.uploadedBlobPaths || []).map(p => {
                const m = p.match(/_([^_]+)_cleaned\.json$/);
                return m ? m[1] : null;
            }).filter(Boolean)) )];

            return res.json({ project, outputMode, tables, result: results, timestamp: new Date().toISOString() });
        }

        // Single-file mode
        const buffer = fs.readFileSync(filePath);
        const fileInfo = { id: path.basename(filePath), name: path.basename(filePath), sharepointPath: `Shared Documents/${project}` };
        const result = await DataCleaner.processFile(fileInfo, buffer, options);

        if (!result.success) {
            return res.status(500).json({ project, outputMode, error: result.error, timestamp: new Date().toISOString() });
        }

        const tables = Object.keys(result.groupedData || {});
        const uploaded = result.metadata?.uploadedBlobPaths || result.uploadedBlobPaths || [];

        return res.json({ project, outputMode, tables, uploaded, result: result.groupedData, timestamp: new Date().toISOString() });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/cleaning/:project/process-to-json', async (req, res) => {
    try {
        const project = req.params.project.toLowerCase();
        const { filePath, directory, outputMode = 'json' } = req.body;

        if (!filePath && !directory) {
            return res.status(400).json({ error: 'filePath or directory required' });
        }

        // Resolve to the correct project service
        let service;
        switch (project) {
            case 'aetna':
                service = aetnaService;
                break;
            case 'carefirst':
            case 'cfmd':
                service = carefirstService;
                break;
            default:
                return res.status(404).json({
                    error: `Unknown project "${project}". Supported: aetna, carefirst, cfmd`
                });
        }

        const options = { outputMode };

        if (directory) {
            // Directory mode — return array of per-file results
            const results = await service.processDirectory(directory, options);
            const tables = [...new Set(
                results.flatMap(r => Object.keys(r.tableGroups || {}))
            )];

            return res.json({
                project,
                outputMode,
                tables,
                result: results.map(r => ({
                    file: r.file,
                    success: r.success,
                    rowsProcessed: r.rowsProcessed,
                    uploadedTo: r.uploadedTo,
                    tableGroups: r.tableGroups,
                    error: r.error
                })),
                timestamp: new Date().toISOString()
            });
        }

        // Single-file mode
        const result = await service.processFile(filePath, options);

        if (!result.success) {
            return res.status(500).json({
                project,
                outputMode,
                error: result.error,
                timestamp: new Date().toISOString()
            });
        }

        const tables = Object.keys(result.tableGroups || {});

        return res.json({
            project,
            outputMode,
            tables,
            result: result.tableGroups,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;


