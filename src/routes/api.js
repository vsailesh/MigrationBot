import express from 'express';
import { testBlobConnection, listContainers, listBlobs, downloadBlobContent, getBlobProperties } from '../azure/blobClient.js';
import { testSqlConnection, listTables, getTableColumns } from '../azure/sqlClient.js';
import { testAdfConnection, listPipelines } from '../azure/adfClient.js';
import { detectSchema, generateDDL } from '../engine/schemaDetector.js';
import { generatePipelineDefinition } from '../engine/pipelineGenerator.js';
import { runMigration } from '../engine/migrationRunner.js';
import { getJobs, getJob } from '../store.js';

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
    });
});

// ════════════════════════════════════════════════════
// Blob Storage
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
        const schemaResult = detectSchema(content, props.format);

        if (schemaResult.error) {
            return res.status(400).json({ error: schemaResult.error });
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
// Migration Jobs
// ════════════════════════════════════════════════════

router.post('/migrate', async (req, res) => {
    try {
        const { containerName, blobName, tableName, schema = 'dbo', useAdf = true } = req.body;
        if (!containerName || !blobName || !tableName) {
            return res.status(400).json({ error: 'containerName, blobName, and tableName required' });
        }

        // Start migration in background
        const resultPromise = runMigration({ containerName, blobName, tableName, schema, useAdf });

        // Return immediately with job ID
        // We need a brief delay to let the job get created
        await new Promise((r) => setTimeout(r, 200));
        const jobs = getJobs();
        const latestJob = jobs[0];

        res.json({ jobId: latestJob?.id, status: 'started', message: 'Migration started. Poll /api/jobs/:id for progress.' });

        // Continue running in background
        resultPromise.catch((err) => console.error('Migration error:', err));
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

export default router;
