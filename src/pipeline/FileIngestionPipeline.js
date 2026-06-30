/**
 * FileIngestionPipeline
 * =====================
 * End-to-end orchestrator for the SFTP → SharePoint → Clean → Fan-out workflow.
 *
 * Lifecycle per detected file:
 *  1. Guard: skip if already processed (idempotency via FileProcessingMetadata)
 *  2. Download buffer from SharePoint using Graph API
 *  3. Clean via DataCleaner (normalized-json mode by default)
 *  4. Fan-out in parallel (Promise.allSettled):
 *       • AzureDbWriter — JSON per table → blob (ADF trigger) + optional direct bulkInsert
 *       • SalesforceWriter — Composite or Bulk API v2 upsert
 *  5. Record final status (success / partial / failed) in FileProcessingMetadata
 *
 * Usage (programmatic):
 *   const pipeline = new FileIngestionPipeline();
 *   pipeline.start();   // begins polling SharePoint
 *   pipeline.stop();
 *   await pipeline.triggerFile(fileItem);  // manual one-shot
 *
 * Usage (via API):
 *   POST /api/pipeline/trigger   { fileName?, projectName? }
 *   GET  /api/pipeline/status
 *   GET  /api/pipeline/runs
 */

import { getSiteId, downloadItemContent } from '../azure/sharepointClient.js';
import DataCleaner from '../dataCleaner.js';
import { writeGroupedDataToAzureDb } from './AzureDbWriter.js';
import { upsertSalesforceRecords } from '../SalesforceClient.js';
import { SharePointPoller } from './SharePointPoller.js';
import { getPool } from '../azure/sqlClient.js';
import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── In-memory run history (last 200 runs, ring-buffer) ────────────────────────
const MAX_RUNS = 200;
const _runs = [];
let _runSeq = 0;

function recordRun(entry) {
    if (_runs.length >= MAX_RUNS) _runs.shift();
    _runs.push(entry);
}

// ── Pipeline class ─────────────────────────────────────────────────────────────

export class FileIngestionPipeline {
    constructor(options = {}) {
        this.watchFolder  = options.watchFolder  || process.env.WATCH_SP_FOLDER || 'Shared Documents/SFTP-Incoming';
        this.projectName  = options.projectName  || process.env.WATCH_PROJECT_NAME || 'aetna';
        this.outputMode   = options.outputMode   || process.env.PIPELINE_OUTPUT_MODE || 'normalized-json';
        this._poller      = null;
        this._processing  = new Set();  // in-flight file IDs (prevent duplicate concurrent runs)
    }

    /** Begin watching the configured SharePoint folder. */
    start() {
        if (this._poller) return;
        this._poller = new SharePointPoller(this.watchFolder, {
            projectName: this.projectName,
            onNewFile: (fileItem) => this.processFile(fileItem),
        });
        this._poller.start();
        console.log(`[Pipeline] Started — watching "${this.watchFolder}" for project "${this.projectName}"`);
    }

    stop() {
        this._poller?.stop();
        this._poller = null;
        console.log('[Pipeline] Stopped');
    }

    /** Force an immediate poll cycle (used by /api/pipeline/scan). */
    async scan() {
        if (!this._poller) {
            this._poller = new SharePointPoller(this.watchFolder, {
                projectName: this.projectName,
                onNewFile: (fileItem) => this.processFile(fileItem),
            });
        }
        return this._poller.pollOnce();
    }

    /** Manually trigger processing of a specific file item (used by API or tests). */
    async triggerFile(fileItem) {
        return this.processFile(fileItem);
    }

    // ── Core pipeline ──────────────────────────────────────────────────────────

    async processFile(fileItem) {
        const runId = `run-${++_runSeq}-${Date.now()}`;
        const run = {
            runId,
            fileId: fileItem.id,
            fileName: fileItem.name,
            projectName: fileItem.projectName || this.projectName,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            status: 'running',
            steps: {},
        };
        recordRun(run);

        if (this._processing.has(fileItem.id)) {
            run.status = 'skipped';
            run.steps.guard = 'duplicate in-flight — skipped';
            return run;
        }
        this._processing.add(fileItem.id);

        try {
            // Step 1: idempotency guard
            const alreadyDone = await this._isAlreadyProcessed(fileItem);
            if (alreadyDone) {
                run.status = 'skipped';
                run.steps.guard = 'already processed successfully — skipped';
                console.log(`[Pipeline] Skipping already-processed file: ${fileItem.name}`);
                return run;
            }
            run.steps.guard = 'ok';

            // Step 2: download from SharePoint
            console.log(`[Pipeline] Downloading: ${fileItem.name}`);
            const { buffer, siteId } = await this._downloadFile(fileItem);
            run.steps.download = `${buffer.length} bytes`;

            // Step 3: clean
            console.log(`[Pipeline] Cleaning: ${fileItem.name} (mode=${this.outputMode})`);
            const cleanResult = await this._cleanFile(buffer, fileItem);
            run.steps.clean = {
                rows: cleanResult.metadata?.rowCount,
                newColumns: cleanResult.metadata?.newColumnsFound?.length,
                mode: this.outputMode,
            };

            // Step 4: fan-out in parallel
            const groupedData = cleanResult.groupedData || {};
            const schema = DataCleaner.schemaManager?.getSchema(fileItem.projectName || this.projectName);
            const schemaColumns = schema?.columns || {};

            const [dbResult, sfResult] = await Promise.allSettled([
                writeGroupedDataToAzureDb(groupedData, fileItem.projectName || this.projectName, schemaColumns),
                this._writeToSalesforce(groupedData, fileItem, schemaColumns),
            ]);

            run.steps.azureDb = dbResult.status === 'fulfilled'
                ? dbResult.value
                : { error: dbResult.reason?.message };

            run.steps.salesforce = sfResult.status === 'fulfilled'
                ? sfResult.value
                : { error: sfResult.reason?.message };

            const anyFailed = dbResult.status === 'rejected' || sfResult.status === 'rejected';
            run.status = anyFailed ? 'partial' : 'success';

            // Step 5: record outcome in FileProcessingMetadata
            await this._recordOutcome(fileItem, cleanResult.metadata, run);

        } catch (err) {
            run.status = 'failed';
            run.steps.error = err.message;
            console.error(`[Pipeline] Run ${runId} failed for "${fileItem.name}":`, err.message);
            await this._recordOutcome(fileItem, null, run).catch(() => {});
        } finally {
            run.finishedAt = new Date().toISOString();
            this._processing.delete(fileItem.id);
        }

        console.log(`[Pipeline] Run ${runId} finished — status: ${run.status}`);
        return run;
    }

    // ── Step implementations ───────────────────────────────────────────────────

    async _downloadFile(fileItem) {
        const siteId = await getSiteId();
        const buffer = await downloadItemContent(siteId, fileItem.id);
        return { buffer, siteId };
    }

    async _cleanFile(buffer, fileItem) {
        const fileInfoForCleaner = {
            id: fileItem.id,
            name: fileItem.name,
            sharepointPath: fileItem.parentPath
                ? `${fileItem.parentPath}/${fileItem.name}`.replace(/^.*root:/, 'Shared Documents')
                : `Shared Documents/${fileItem.projectName || this.projectName}/${fileItem.name}`,
        };
        return DataCleaner.processFile(fileInfoForCleaner, buffer, { outputMode: this.outputMode });
    }

    async _writeToSalesforce(groupedData, fileItem, schemaColumns) {
        const sfEnabled = process.env.PIPELINE_SF_ENABLED !== 'false';
        if (!sfEnabled) return { skipped: true, reason: 'PIPELINE_SF_ENABLED=false' };

        const objectName    = process.env.SF_TARGET_OBJECT || fileItem.sfObject;
        const externalIdFld = process.env.SF_EXTERNAL_ID_FIELD || fileItem.sfExternalId;
        if (!objectName || !externalIdFld) {
            return { skipped: true, reason: 'SF_TARGET_OBJECT or SF_EXTERNAL_ID_FIELD not configured' };
        }

        // Use schema-defined field mappings if available; otherwise pass through as-is
        const results = {};
        for (const [tableName, rows] of Object.entries(groupedData)) {
            if (!rows?.length) continue;
            const mappedRows = applyFieldMappings(rows, tableName, schemaColumns);
            try {
                results[tableName] = await upsertSalesforceRecords(objectName, mappedRows, externalIdFld);
            } catch (err) {
                results[tableName] = { error: err.message };
            }
        }
        return results;
    }

    // ── Idempotency & metadata ─────────────────────────────────────────────────

    async _isAlreadyProcessed(fileItem) {
        try {
            const pool = await getPool();
            const res = await pool.request()
                .input('fileId', sql.NVarChar, fileItem.id)
                .query(`
                    SELECT TOP 1 ProcessingStatus FROM dbo.FileProcessingMetadata
                    WHERE FileID = @fileId AND ProcessingStatus = 'Success'
                `);
            return res.recordset.length > 0;
        } catch { return false; }
    }

    async _recordOutcome(fileItem, cleanMeta, run) {
        try {
            const pool = await getPool();
            await pool.request()
                .input('fileId',     sql.NVarChar,  fileItem.id)
                .input('fileName',   sql.NVarChar,  fileItem.name)
                .input('project',    sql.NVarChar,  fileItem.projectName || this.projectName)
                .input('spPath',     sql.NVarChar,  fileItem.parentPath || '')
                .input('status',     sql.NVarChar,  run.status)
                .input('runId',      sql.NVarChar,  run.runId)
                .input('sfStatus',   sql.NVarChar,  JSON.stringify(run.steps.salesforce || {}))
                .input('dbStatus',   sql.NVarChar,  JSON.stringify(run.steps.azureDb   || {}))
                .input('errMsg',     sql.NVarChar,  run.steps.error || null)
                .input('rowCount',   sql.Int,       cleanMeta?.rowCount || null)
                .input('startTime',  sql.DateTime2, new Date(run.startedAt))
                .input('endTime',    sql.DateTime2, new Date())
                .query(`
                    IF EXISTS (SELECT 1 FROM dbo.FileProcessingMetadata WHERE FileID = @fileId AND RunID = @runId)
                        UPDATE dbo.FileProcessingMetadata
                        SET ProcessingStatus=@status, SalesforceStatus=@sfStatus, AzureDbStatus=@dbStatus,
                            ErrorMessage=@errMsg, RecordRowCount=@rowCount, ProcessingEndTime=@endTime
                        WHERE FileID=@fileId AND RunID=@runId
                    ELSE
                        INSERT INTO dbo.FileProcessingMetadata
                            (FileID,FileName,ProjectName,SharePointPath,ProcessingStatus,RunID,
                             SalesforceStatus,AzureDbStatus,ErrorMessage,RecordRowCount,
                             ProcessingStartTime,ProcessingEndTime)
                        VALUES
                            (@fileId,@fileName,@project,@spPath,@status,@runId,
                             @sfStatus,@dbStatus,@errMsg,@rowCount,
                             @startTime,@endTime)
                `);
        } catch (err) {
            console.warn('[Pipeline] Could not record outcome to FileProcessingMetadata:', err.message);
        }
    }

    // ── Status ─────────────────────────────────────────────────────────────────

    getStatus() {
        return {
            running: !!this._poller,
            watchFolder: this.watchFolder,
            projectName: this.projectName,
            outputMode: this.outputMode,
            inFlight: [...this._processing],
            recentRuns: _runs.slice(-10).reverse(),
        };
    }

    getRuns(limit = 50) {
        return _runs.slice(-limit).reverse();
    }
}

// ── Singleton export ────────────────────────────────────────────────────────────

export const pipeline = new FileIngestionPipeline();

// ── Field mapping helper ────────────────────────────────────────────────────────

function applyFieldMappings(rows, tableName, schemaColumns) {
    // Look for salesforce.fieldMappings in schema columns metadata
    // Schema columns can include a salesforce section: { "fieldMappings": { "MEMBER_ID": "MemberID__c" } }
    const mappings = {};
    for (const [colName, colDef] of Object.entries(schemaColumns)) {
        if (colDef.salesforce?.fieldName && colDef.targetTable === tableName) {
            mappings[colName] = colDef.salesforce.fieldName;
        }
    }

    if (Object.keys(mappings).length === 0) return rows;  // no mapping defined, pass through

    return rows.map(row => {
        const out = {};
        for (const [src, dst] of Object.entries(mappings)) {
            if (src in row) out[dst] = row[src];
        }
        // also keep unmapped fields as-is so nothing is silently lost
        for (const [k, v] of Object.entries(row)) {
            if (!(k in mappings)) out[k] = v;
        }
        return out;
    });
}
