/**
 * AzureDbWriter
 * =============
 * Writes cleaned, grouped data to Azure SQL using two paths:
 *
 *  - 'direct'      : bulkInsert row-by-row via mssql connection pool (fast for small sets)
 *  - 'blob-trigger': upload JSON per table to blob storage → ADF event trigger copies
 *                    to SQL automatically (preferred for large sets, auditable)
 *  - 'both'        : do both (direct write for immediate availability + blob for audit trail)
 *
 * Mode is controlled by AZURE_DB_WRITE_MODE env var (default: 'both').
 *
 * Input: groupedData = { tableName: [{ col: val, ... }], ... }
 * This is the output of DataCleaner in 'json' or 'normalized-json' mode.
 */

import { BlobServiceClient } from '@azure/storage-blob';
import { getPool, createTable } from '../azure/sqlClient.js';
import sql from 'mssql';

const WRITE_MODE = () => process.env.AZURE_DB_WRITE_MODE || 'both';

/**
 * Main entry point.
 * @param {Object} groupedData   { tableName: [rows] }
 * @param {string} projectName   used as blob prefix for audit trail
 * @param {Object} schemaColumns columns definition from project schema
 * @returns {Object}  { tables: { tableName: { rowsWritten, blobPath?, error? } } }
 */
export async function writeGroupedDataToAzureDb(groupedData, projectName, schemaColumns = {}) {
    const mode = WRITE_MODE();
    const results = {};

    for (const [tableName, rows] of Object.entries(groupedData)) {
        if (!Array.isArray(rows) || rows.length === 0) continue;
        results[tableName] = {};

        try {
            if (mode === 'direct' || mode === 'both') {
                const r = await writeDirectToSql(tableName, rows, schemaColumns);
                results[tableName].rowsInserted = r.rowsInserted;
            }
            if (mode === 'blob-trigger' || mode === 'both') {
                const blobPath = await uploadTableJsonToBlob(tableName, rows, projectName);
                results[tableName].blobPath = blobPath;
            }
        } catch (err) {
            results[tableName].error = err.message;
            console.error(`[AzureDbWriter] Failed writing table "${tableName}":`, err.message);
        }
    }
    return results;
}

// ── Direct write via mssql connection pool ────────────────────────────────────

async function writeDirectToSql(tableName, rows, schemaColumns) {
    const pool = await getPool();
    const columns = inferColumns(rows, schemaColumns);

    // Ensure the table exists
    await ensureTable(pool, tableName, columns);

    const table = new sql.Table(`[dbo].[${tableName}]`);
    table.create = false;

    for (const col of columns) {
        table.columns.add(col.name, col.mssqlType, { nullable: true });
    }
    for (const row of rows) {
        table.rows.add(...columns.map(c => coerce(row[c.name], c.type)));
    }

    const result = await pool.request().bulk(table);
    console.log(`[AzureDbWriter] Direct insert: ${result.rowsAffected} rows → [dbo].[${tableName}]`);
    return { rowsInserted: result.rowsAffected };
}

async function ensureTable(pool, tableName, columns) {
    const columnDefs = columns
        .map(c => `[${c.name}] ${c.sqlTypeDef} NULL`)
        .join(',\n    ');

    await pool.request().query(`
        IF NOT EXISTS (
            SELECT 1 FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = '${tableName}'
        )
        BEGIN
            CREATE TABLE [dbo].[${tableName}] (
                [_pipeline_id] BIGINT IDENTITY(1,1) PRIMARY KEY,
                [_ingested_at] DATETIME2 DEFAULT GETUTCDATE(),
                ${columnDefs}
            )
        END
    `);
}

// ── Blob upload for ADF event trigger ─────────────────────────────────────────

async function uploadTableJsonToBlob(tableName, rows, projectName) {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING not set');

    const container = process.env.PIPELINE_BLOB_CONTAINER || process.env.AZURE_CONTAINER || 'uhcncdata';
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const blobPath = `pipeline/${projectName}/${timestamp}/${tableName}.json`;

    const blobClient = BlobServiceClient
        .fromConnectionString(connStr)
        .getContainerClient(container)
        .getBlockBlobClient(blobPath);

    const content = JSON.stringify({ table: tableName, rows, writtenAt: new Date().toISOString() });
    await blobClient.upload(content, Buffer.byteLength(content), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
    });

    console.log(`[AzureDbWriter] Uploaded ${rows.length} rows → blob: ${container}/${blobPath}`);
    // ADF event trigger fires automatically on BlobCreated — no manual invocation needed
    return blobPath;
}

// ── Column inference helpers ───────────────────────────────────────────────────

function inferColumns(rows, schemaColumns) {
    const sampleRow = rows[0] || {};
    return Object.keys(sampleRow).map(name => {
        const schemaDef = schemaColumns[name] || schemaColumns[name?.toUpperCase()] || {};
        const type = schemaDef.type || inferType(sampleRow[name]);
        return {
            name,
            type,
            sqlTypeDef: toSqlTypeDef(type, schemaDef.max_length),
            mssqlType: toMssqlType(type),
        };
    });
}

function inferType(val) {
    if (val instanceof Date) return 'date';
    if (typeof val === 'number') return Number.isInteger(val) ? 'int' : 'float';
    if (typeof val === 'boolean') return 'boolean';
    return 'string';
}

function toSqlTypeDef(type, maxLen) {
    switch (type) {
        case 'int':     return 'INT';
        case 'float':   return 'FLOAT';
        case 'boolean': return 'BIT';
        case 'date':    return 'DATETIME2';
        default:        return `NVARCHAR(${maxLen || 500})`;
    }
}

function toMssqlType(type) {
    switch (type) {
        case 'int':     return sql.Int;
        case 'float':   return sql.Float;
        case 'boolean': return sql.Bit;
        case 'date':    return sql.DateTime2;
        default:        return sql.NVarChar(500);
    }
}

function coerce(val, type) {
    if (val === null || val === undefined || val === '') return null;
    if (type === 'int') return parseInt(val, 10) || null;
    if (type === 'float') return parseFloat(val) || null;
    if (type === 'boolean') return ['true', '1', 'yes', 'y'].includes(String(val).toLowerCase());
    if (type === 'date') { const d = new Date(val); return isNaN(d) ? null : d; }
    return String(val);
}
