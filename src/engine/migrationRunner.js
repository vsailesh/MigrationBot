import { v4 as uuidv4 } from 'uuid';
import { downloadBlobContent, getBlobProperties } from '../azure/blobClient.js';
import { createTable, getRowCount } from '../azure/sqlClient.js';
import {
    createBlobLinkedService, createSqlLinkedService,
    createBlobDataset, createSqlDataset,
    createCopyPipeline, triggerPipelineRun, getPipelineRunStatus, getActivityRuns,
} from '../azure/adfClient.js';
import { detectSchema } from './schemaDetector.js';
import { generatePipelineDefinition } from './pipelineGenerator.js';
import { addJob, updateJob, addLog } from '../store.js';

/**
 * Run a full migration: blob file → detect schema → create table → create ADF pipeline → execute.
 */
export async function runMigration({ containerName, blobName, tableName, schema = 'dbo', useAdf = true }) {
    const jobId = uuidv4().slice(0, 8);
    const job = addJob({
        id: jobId,
        containerName,
        blobName,
        tableName,
        schema,
        useAdf,
        status: 'starting',
    });

    try {
        // ─── Step 1: Get blob info ─────────────────
        addLog(jobId, 'info', `Starting migration: ${containerName}/${blobName} → [${schema}].[${tableName}]`);
        updateJob(jobId, { status: 'analyzing', step: 'Fetching blob properties' });

        const blobProps = await getBlobProperties(containerName, blobName);
        addLog(jobId, 'info', `File: ${blobProps.format}, ${formatBytes(blobProps.size)}`);
        updateJob(jobId, { fileSize: blobProps.size, fileFormat: blobProps.format });

        // ─── Step 2: Detect schema ─────────────────
        updateJob(jobId, { step: 'Detecting schema' });
        addLog(jobId, 'info', 'Downloading file for schema detection...');

        const content = await downloadBlobContent(containerName, blobName);
        const schemaResult = detectSchema(content, blobProps.format);

        if (schemaResult.error) {
            throw new Error(`Schema detection failed: ${schemaResult.error}`);
        }

        addLog(jobId, 'success', `Detected ${schemaResult.columns.length} columns, ${schemaResult.rowCount} rows`);
        updateJob(jobId, {
            status: 'schema_detected',
            columns: schemaResult.columns,
            rowCount: schemaResult.rowCount,
            step: 'Schema detected',
        });

        // ─── Step 3: Create SQL table ──────────────
        updateJob(jobId, { step: 'Creating SQL table' });
        addLog(jobId, 'info', `Creating table [${schema}].[${tableName}]...`);

        await createTable(tableName, schemaResult.columns, schema);
        addLog(jobId, 'success', `Table [${schema}].[${tableName}] created`);
        updateJob(jobId, { status: 'table_created' });

        if (!useAdf) {
            // ─── Direct insert mode (skip ADF) ───────
            updateJob(jobId, { step: 'Direct bulk insert', status: 'migrating' });
            addLog(jobId, 'info', 'Using direct bulk insert (ADF bypassed)...');

            const { bulkInsert } = await import('../azure/sqlClient.js');
            let rows;
            if (blobProps.format === 'CSV' || blobProps.format === 'TSV') {
                const { parse } = await import('csv-parse/sync');
                rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_quotes: true, relax_column_count: true });
            } else {
                rows = JSON.parse(content);
                if (!Array.isArray(rows)) rows = [rows];
            }

            const result = await bulkInsert(tableName, schemaResult.columns, rows, schema);
            addLog(jobId, 'success', `Inserted ${result.rowsInserted} rows`);
            updateJob(jobId, { status: 'completed', rowsInserted: result.rowsInserted, step: 'Done' });

        } else {
            // ─── ADF Pipeline mode ──────────────────
            // Step 4: Generate pipeline definition
            updateJob(jobId, { step: 'Generating ADF pipeline', status: 'creating_pipeline' });
            addLog(jobId, 'info', 'Generating ADF pipeline definition...');

            const pipelineDef = generatePipelineDefinition({
                jobId, containerName, blobName, tableName,
                columns: schemaResult.columns, format: blobProps.format, schema,
            });

            updateJob(jobId, { pipelineName: pipelineDef.pipelineName, pipelineDefinition: pipelineDef });

            // Step 5: Create linked services
            addLog(jobId, 'info', 'Creating linked services...');
            await createBlobLinkedService(pipelineDef.blobLinkedService);
            addLog(jobId, 'success', `Linked service: ${pipelineDef.blobLinkedService}`);
            await createSqlLinkedService(pipelineDef.sqlLinkedService);
            addLog(jobId, 'success', `Linked service: ${pipelineDef.sqlLinkedService}`);

            // Step 6: Create datasets
            updateJob(jobId, { step: 'Creating datasets' });
            addLog(jobId, 'info', 'Creating datasets...');
            await createBlobDataset({
                datasetName: pipelineDef.sourceDatasetName,
                containerName, fileName: blobName,
                format: blobProps.format,
                columns: schemaResult.columns,
            });
            addLog(jobId, 'success', `Source dataset: ${pipelineDef.sourceDatasetName}`);
            await createSqlDataset({
                datasetName: pipelineDef.sinkDatasetName,
                tableName, schema,
                columns: schemaResult.columns,
            });
            addLog(jobId, 'success', `Sink dataset: ${pipelineDef.sinkDatasetName}`);

            // Step 7: Create pipeline
            updateJob(jobId, { step: 'Deploying pipeline' });
            addLog(jobId, 'info', `Creating pipeline: ${pipelineDef.pipelineName}`);
            await createCopyPipeline({
                pipelineName: pipelineDef.pipelineName,
                sourceDatasetName: pipelineDef.sourceDatasetName,
                sinkDatasetName: pipelineDef.sinkDatasetName,
                columnMapping: pipelineDef.columnMappings,
            });
            addLog(jobId, 'success', `Pipeline created: ${pipelineDef.pipelineName}`);

            // Step 8: Trigger run
            updateJob(jobId, { step: 'Running pipeline', status: 'running' });
            addLog(jobId, 'info', 'Triggering pipeline run...');
            const runResult = await triggerPipelineRun(pipelineDef.pipelineName);
            addLog(jobId, 'success', `Pipeline run started: ${runResult.runId}`);
            updateJob(jobId, { runId: runResult.runId });

            // Step 9: Poll for completion
            addLog(jobId, 'info', 'Monitoring pipeline progress...');
            const finalStatus = await pollPipelineRun(jobId, runResult.runId, pipelineDef.pipelineName);

            if (finalStatus.status === 'Succeeded') {
                // Step 10: Verify row count
                updateJob(jobId, { step: 'Verifying data' });
                const rowCountResult = await getRowCount(tableName, schema);
                addLog(jobId, 'success', `✅ Migration complete! ${rowCountResult} rows in [${schema}].[${tableName}]`);
                updateJob(jobId, {
                    status: 'completed',
                    rowsInserted: rowCountResult,
                    step: 'Done',
                    completedAt: new Date().toISOString(),
                });
            } else {
                throw new Error(`Pipeline run failed: ${finalStatus.message || finalStatus.status}`);
            }
        }

        return { jobId, status: 'completed' };
    } catch (err) {
        addLog(jobId, 'error', `Migration failed: ${err.message}`);
        updateJob(jobId, { status: 'failed', error: err.message, step: 'Failed' });
        return { jobId, status: 'failed', error: err.message };
    }
}

/**
 * Poll a pipeline run until completion.
 */
async function pollPipelineRun(jobId, runId, pipelineName, maxWaitMs = 600000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < maxWaitMs) {
        await sleep(pollInterval);

        const status = await getPipelineRunStatus(runId);
        addLog(jobId, 'info', `Pipeline status: ${status.status}`);
        updateJob(jobId, { pipelineStatus: status.status });

        if (['Succeeded', 'Failed', 'Cancelled'].includes(status.status)) {
            // Get activity details
            try {
                const activities = await getActivityRuns(runId, pipelineName);
                updateJob(jobId, { activityRuns: activities });
                activities.forEach((a) => {
                    addLog(jobId, a.status === 'Succeeded' ? 'success' : 'error',
                        `Activity: ${a.activityName} — ${a.status}${a.error ? ': ' + JSON.stringify(a.error) : ''}`
                    );
                });
            } catch { /* ignore */ }
            return status;
        }
    }

    throw new Error('Pipeline run timed out after 10 minutes');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}
