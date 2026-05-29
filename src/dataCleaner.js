import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import cron from 'node-cron';
import { BlobServiceClient } from '@azure/storage-blob';
import sql from 'mssql';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * MigrationBot Data Cleaning Engine
 * ================================
 *
 * Integrated data cleaning functionality for the MigrationBot Node.js application.
 * Handles automated cleaning between SharePoint detection and Azure Blob Storage.
 */

class DataCleaningConfig {
    constructor() {
        this.pollingIntervalMinutes = parseInt(process.env.CLEANING_POLLING_INTERVAL_MINUTES || '15');
        this.sharepointSiteUrl = process.env.SHAREPOINT_SITE_URL || 'https://hcdinternational.sharepoint.com/';
        this.azureStorageConnection = process.env.AZURE_STORAGE_CONNECTION_STRING;
        this.containerName = process.env.AZURE_CONTAINER || 'uhcncdata';
        this.sqlConnectionString = process.env.SQL_CONNECTION_STRING;
        this.quarantineFolder = process.env.QUARANTINE_FOLDER || 'failed_data';
        this.retryFolder = process.env.RETRY_FOLDER || 'need_retry';
        this.maxRetries = parseInt(process.env.MAX_RETRIES || '3');
        this.supportedExtensions = ['.xlsx', '.xls', '.csv'];
        this.schemasPath = path.join(__dirname, '..', 'schemas');
        // 'excel' (default) or 'json' — can be overridden per-request via processFile options
        this.outputMode = process.env.CLEANING_OUTPUT_MODE || 'excel';
    }
}

class SchemaManager {
    constructor(config) {
        this.config = config;
        this.schemas = new Map();
        this.loadSchemas();
    }

    loadSchemas() {
        if (!fs.existsSync(this.config.schemasPath)) {
            fs.mkdirSync(this.config.schemasPath, { recursive: true });
            console.log(`Created schema directory: ${this.config.schemasPath}`);
            return;
        }

        const schemaFiles = fs.readdirSync(this.config.schemasPath)
            .filter(file => file.endsWith('.json'));

        for (const schemaFile of schemaFiles) {
            try {
                const schemaPath = path.join(this.config.schemasPath, schemaFile);
                const schemaContent = fs.readFileSync(schemaPath, 'utf8');
                const schema = JSON.parse(schemaContent);
                const projectName = schemaFile.replace('.json', '').toLowerCase();
                this.schemas.set(projectName, schema);
                console.log(`Loaded schema for project: ${projectName}`);
            } catch (error) {
                console.error(`Failed to load schema ${schemaFile}:`, error.message);
            }
        }
    }

    getSchema(projectName) {
        return this.schemas.get(projectName.toLowerCase());
    }

    validateAndStandardizeColumns(data, projectName) {
        const schema = this.getSchema(projectName);
        if (!schema) {
            console.warn(`No schema found for project ${projectName}, skipping validation`);
            return { cleanedData: data, newColumns: [] };
        }

        const standardColumns = schema.columns || {};
        const newColumns = [];
        const missingColumns = [];
        const cleanedData = [];

        // identify missing columns (present in schema but not in file data)
        const firstRow = data[0] || {};
        Object.keys(standardColumns).forEach(col => {
            if (!(col in firstRow)) {
                missingColumns.push(col);
            }
        });
        if (missingColumns.length) {
            console.warn(`Missing columns for ${projectName}: ${missingColumns.join(', ')}`);
        }

        // Check for new columns and standardize data
        for (const row of data) {
            const cleanedRow = {};

            // ensure missing columns are included with default/null
            missingColumns.forEach(col => {
                cleanedRow[col] = schema.transformations?.default_values?.[col] ?? null;
            });

            for (const [colName, colValue] of Object.entries(row)) {
                if (!(colName in standardColumns)) {
                    if (!newColumns.includes(colName)) {
                        newColumns.push(colName);
                        console.log(`New column found in ${projectName}: ${colName}`);
                    }
                }

                // Standardize column names and data types
                if (colName in standardColumns) {
                    const expectedType = standardColumns[colName].type || 'string';
                    cleanedRow[colName] = this.convertColumnType(colValue, expectedType, projectName);
                } else {
                    // Keep new columns as-is
                    cleanedRow[colName] = colValue;
                }
            }

            cleanedData.push(cleanedRow);
        }

        return { cleanedData, newColumns, missingColumns };
    }

    /**
     * Auto-update schema with new columns if auto_schema_update is enabled
     */
    updateSchemaWithNewColumns(projectName, newColumns) {
        if (!newColumns || newColumns.length === 0) return;
        
        const schema = this.getSchema(projectName);
        if (!schema || !schema.auto_schema_update) return;

        const projectPath = projectName.toLowerCase();
        const schemaFilePath = path.join(this.config.schemasPath, `${projectPath}.json`);
        
        try {
            let updated = false;
            // Add new columns to schema
            for (const colName of newColumns) {
                if (!(colName in schema.columns)) {
                    schema.columns[colName] = {
                        type: 'string',
                        description: `Auto-detected column: ${colName}`,
                        required: false,
                        max_length: 1000
                    };
                    updated = true;
                    console.log(`Auto-updated schema for ${projectName}: added column ${colName}`);
                }
            }

            // Write updated schema back to file
            if (updated) {
                fs.writeFileSync(schemaFilePath, JSON.stringify(schema, null, 2), 'utf8');
                console.log(`Schema updated and saved: ${projectPath}`);
                // Also update in-memory schema
                this.schemas.set(projectPath, schema);
            }
        } catch (error) {
            console.warn(`Failed to auto-update schema for ${projectName}:`, error.message);
        }
    }

    convertColumnType(value, expectedType, projectName = null) {
        if (value === null || value === undefined || value === '') {
            return null;
        }

        try {
            switch (expectedType) {
                case 'date':
                    const date = new Date(value);
                    if (isNaN(date.getTime())) {
                        return null;
                    }
                    // Check for invalid/default dates that should be treated as null
                    const isoDate = date.toISOString().split('T')[0];

                    // Get invalid dates from schema if available
                    let invalidDates = ['1970-01-01', '1900-01-01', '0001-01-01']; // defaults
                    if (projectName) {
                        const schema = this.getSchema(projectName);
                        if (schema?.data_quality_rules?.invalid_dates) {
                            invalidDates = schema.data_quality_rules.invalid_dates;
                        }
                    }

                    if (invalidDates.includes(isoDate)) {
                        console.warn(`Treating invalid date "${value}" (${isoDate}) as null for project ${projectName}`);
                        return null;
                    }
                    return isoDate;
                case 'int':
                    const intVal = parseInt(value);
                    return isNaN(intVal) ? null : intVal;
                case 'float':
                    const floatVal = parseFloat(value);
                    return isNaN(floatVal) ? null : floatVal;
                case 'boolean':
                    if (typeof value === 'boolean') return value;
                    if (typeof value === 'string') {
                        return ['true', '1', 'yes', 'y'].includes(value.toLowerCase());
                    }
                    return Boolean(value);
                default: // string
                    return String(value).trim();
            }
        } catch (error) {
            console.warn(`Failed to convert value "${value}" to ${expectedType}:`, error.message);
            return value;
        }
    }
}

class DataCleaner {
    constructor(config) {
        this.config = config;
        this.schemaManager = new SchemaManager(config);
        this.blobServiceClient = BlobServiceClient.fromConnectionString(config.azureStorageConnection);
        this.containerClient = this.blobServiceClient.getContainerClient(config.containerName);
        this.isMonitoring = false;
        this.lastCheckTime = new Date(Date.now() - (config.pollingIntervalMinutes * 60 * 1000));

        // ensure the metadata table exists so later operations don't fail
        this.ensureMetadataTable().catch(err => {
            console.warn('Unable to ensure metadata table exists:', err.message);
        });
    }

    /**
     * Check if a schema is available for the given project
     */
    hasSchema(projectName) {
        return !!this.schemaManager.getSchema(projectName);
    }

    /**
     * Extract project name and year from SharePoint path
     * Expected path: /sites/DataAnalyticsAndInsights/Shared Documents/{Project}/{Year}/...
     */
    /**
     * Normalize a project name string to the canonical key used throughout
     * the application.  Some SharePoint folders use aliases (e.g. CFMD) that
     * should map back to the same project (CareFirst).
     */
    normalizeProjectName(rawName) {
        if (!rawName) return 'unknown';
        const key = String(rawName).trim();
        const lower = key.toLowerCase();

        const aliasMap = {
            'cfmd': 'carefirst',        // SharePoint folder name for CareFirst data
            'care first': 'carefirst',
            'carefirst': 'carefirst',
            'aetna': 'aetna',
            'CareFirst': 'carefirst',
            // add additional aliases as needed
        };

        return aliasMap[lower] || lower;
    }

    detectProjectFromPath(filePath) {
        try {
            const parts = String(filePath).split('/').filter(p => p);
            const sharedDocsIndex = parts.indexOf('Shared Documents');

            if (sharedDocsIndex === -1 || sharedDocsIndex + 1 >= parts.length) {
                return { projectName: 'Unknown', year: 'Unknown' };
            }

            let projectName = parts[sharedDocsIndex + 1];
            const year = parts[sharedDocsIndex + 2] || 'Unknown';

            // apply canonical mapping
            projectName = this.normalizeProjectName(projectName);

            return { projectName, year };
        } catch (error) {
            console.error('Error detecting project from path:', error);
            return { projectName: 'Unknown', year: 'Unknown' };
        }
    }

    /**
     * Read Excel file and convert to array of objects
     */
    readExcelFile(buffer) {
        try {
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            return XLSX.utils.sheet_to_json(worksheet);
        } catch (error) {
            throw new Error(`Failed to read Excel file: ${error.message}`);
        }
    }

    /**
     * Read CSV file and convert to array of objects
     */
    readCsvFile(buffer) {
        try {
            const csvText = buffer.toString('utf8');
            // Simple CSV parsing - for more complex CSV, consider using csv-parse library
            const lines = csvText.split('\n').filter(line => line.trim());
            if (lines.length === 0) return [];

            const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
            const data = [];

            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
                if (values.length === headers.length) {
                    const row = {};
                    headers.forEach((header, index) => {
                        row[header] = values[index];
                    });
                    data.push(row);
                }
            }

            return data;
        } catch (error) {
            throw new Error(`Failed to read CSV file: ${error.message}`);
        }
    }

    /**
     * Clean file data based on project schema
     */
    cleanFileData(data, projectName, fileExtension) {
        // Apply project-specific cleaning
        const { cleanedData, newColumns, missingColumns } = this.schemaManager.validateAndStandardizeColumns(data, projectName);

        return { cleanedData, newColumns, missingColumns };
    }

    /**
     * Convert cleaned data back to buffer for upload
     */
    convertToBuffer(data, fileExtension) {
        if (fileExtension === '.csv') {
            if (data.length === 0) return Buffer.from('');

            const headers = Object.keys(data[0]);
            const csvLines = [headers.join(',')];

            for (const row of data) {
                const values = headers.map(header => {
                    const value = row[header];
                    if (value === null || value === undefined) return '';
                    const strValue = String(value);
                    // Escape commas and quotes in CSV
                    if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
                        return `"${strValue.replace(/"/g, '""')}"`;
                    }
                    return strValue;
                });
                csvLines.push(values.join(','));
            }

            return Buffer.from(csvLines.join('\n'), 'utf8');
        } else {
            // Excel format
            const worksheet = XLSX.utils.json_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
            return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        }
    }

    /**
     * Ensure the SQL metadata table exists; create it if missing.
     */
    async ensureMetadataTable() {
        try {
            let pool;
            if (this.config.sqlConnectionString) {
                pool = await sql.connect(this.config.sqlConnectionString);
            } else {
                // fall back to the shared sqlClient pool which uses AZURE_SQL_* env vars
                const { getPool } = await import('./azure/sqlClient.js');
                pool = await getPool();
            }
            await pool.request().query(`
                IF OBJECT_ID('dbo.FileProcessingMetadata','U') IS NULL
                BEGIN
                    CREATE TABLE dbo.FileProcessingMetadata (
                        FileID nvarchar(255) NOT NULL,
                        FileName nvarchar(255) NULL,
                        ProjectName nvarchar(100) NULL,
                        Year nvarchar(10) NULL,
                        SharePointPath nvarchar(4000) NULL,
                        BlobPath nvarchar(4000) NULL,
                        OriginalSize bigint NULL,
                        CleanedSize bigint NULL,
                        RowCount int NULL,
                        ColumnCount int NULL,
                        ProcessingStatus nvarchar(50) NULL,
                        ErrorMessage nvarchar(MAX) NULL,
                        NewColumnsFound nvarchar(MAX) NULL,
                        MissingColumns nvarchar(MAX) NULL,
                        ProcessingStartTime datetime2 NOT NULL,
                        ProcessingEndTime datetime2 NULL
                    );
                END
            `);
            console.log('Ensured metadata table exists');
        } catch (err) {
            console.warn('Error ensuring metadata table:', err.message);
        }
    }

    /**
     * Convert a column name (UPPER_SNAKE, PascalCase, kebab-case, "space separated") to camelCase.
     * Used so JSON output keys match destination DB column naming conventions.
     */
    toCamelCase(str) {
        if (/[-_\s]/.test(str)) {
            // Has explicit separators — split on them, lowercase each part,
            // then capitalise the first letter of every part except the first.
            return str
                .split(/[-_\s]+/)
                .map((part, i) => {
                    const lower = part.toLowerCase();
                    return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
                })
                .join('');
        }
        // No separators (PascalCase / already camelCase) — just lowercase the first character.
        return str.charAt(0).toLowerCase() + str.slice(1);
    }

    /**
     * Group cleaned rows by their schema-defined targetTable.
     *
     * Each column in a row is placed into the table named by schema.columns[col].targetTable.
     * Columns without a targetTable go into the special "_unmapped" key so nothing is silently lost.
     * Column names are converted to camelCase for the JSON output.
     *
     * @param {Object[]} cleanedRows - Array of cleaned row objects from the pipeline
     * @param {Object}   schema      - The project schema (with columns[].targetTable)
     * @returns {Object}             - { tableName: [ { camelCaseCol: value, … }, … ], … }
     */
    groupByTable(cleanedRows, schema) {
        const columnDefs = schema?.columns || {};
        const grouped = {};

        for (const row of cleanedRows) {
            // Accumulate each column's camelCase value into its target table bucket for this row.
            const rowByTable = {};

            for (const [colName, colValue] of Object.entries(row)) {
                const targetTable = columnDefs[colName]?.targetTable || '_unmapped';
                if (!rowByTable[targetTable]) rowByTable[targetTable] = {};
                rowByTable[targetTable][this.toCamelCase(colName)] = colValue;
            }

            // Append this row's partial objects to the correct table arrays.
            for (const [tableName, partialRow] of Object.entries(rowByTable)) {
                if (!grouped[tableName]) grouped[tableName] = [];
                grouped[tableName].push(partialRow);
            }
        }

        return grouped;
    }

    /**
     * Normalize cleaned rows into three relational JSON outputs:
     *   members   — one record per member_id; absorbs demographics, address, plan, PBG, activity
     *   providers — one record per provider_tin (deduplicated, latest non-null wins)
     *   gaps      — one record per member_id (latest non-null wins; gap closure Y→N is captured)
     *
     * Merge strategy — "latest non-null wins":
     *   - insert_date (ISO string) is used to determine recency; ISO lexicographic order = chronological.
     *   - For rows with no insert_date, file order is the tiebreaker (last row = latest).
     *   - A non-null value from a newer row always overwrites the existing value.
     *   - A null value never overwrites an existing non-null value regardless of recency.
     *   This correctly handles gap closure (Y→N), provider address updates, and backfill files.
     *
     * Returns { members, providers, gaps, dateRange: { min, max } }.
     * dateRange drives the date-stamped blob filename in the caller.
     */
    normalizeToThreeFiles(cleanedRows, schema) {
        const normConfig = schema?.normalization;
        if (!normConfig?.tables) {
            throw new Error('Schema missing normalization.tables config; cannot produce normalized JSON');
        }

        const tblCfg = normConfig.tables;
        const membersMap   = new Map();
        const providersMap = new Map();
        const gapsMap      = new Map();

        const memberPkCol   = tblCfg.members?.primary_key          || 'MEMBER_ID';
        const memberFbCol   = tblCfg.members?.fallback_primary_key  || 'SRC_MEMBER_ID';
        const provPkCol     = tblCfg.providers?.primary_key         || 'PROVIDER_TIN';
        const INSERT_DATE   = 'insert_date';
        const memberCols    = tblCfg.members?.source_columns        || [];
        const provCols      = tblCfg.providers?.source_columns      || [];
        const gapCols       = tblCfg.gaps?.source_columns           || [];

        // ISO string compare is chronologically correct; null dates lose to dated rows.
        // When both are null, returns true so file-order (last row) acts as tiebreaker.
        const isNewerOrEqual = (rowDate, existingDate) => {
            if (!rowDate && !existingDate) return true;
            if (!rowDate)      return false;
            if (!existingDate) return true;
            return rowDate >= existingDate;
        };

        // Apply latest-non-null-wins merge from `row` into `existing` for the given column list.
        // Only runs when the incoming row is newer than or equal to the existing record.
        const mergeLatest = (existing, row, cols) => {
            const rowDate = row[INSERT_DATE] || null;
            if (!isNewerOrEqual(rowDate, existing._insertDate)) return;
            for (const col of cols) {
                const key = this.toCamelCase(col);
                const val = row[col] !== undefined ? row[col] : null;
                if (val != null) existing[key] = val;
            }
            // Advance the tracked date only when the incoming date is strictly newer
            if (rowDate && (!existing._insertDate || rowDate > existing._insertDate)) {
                existing._insertDate = rowDate;
            }
        };

        let minInsertDate = null;
        let maxInsertDate = null;

        for (const row of cleanedRows) {
            const memberId    = row[memberPkCol] || row[memberFbCol] || null;
            const providerTin = row[provPkCol] || null;
            const insertDate  = row[INSERT_DATE] || null;

            // Track the date span of this entire batch for blob naming
            if (insertDate) {
                if (!minInsertDate || insertDate < minInsertDate) minInsertDate = insertDate;
                if (!maxInsertDate || insertDate > maxInsertDate) maxInsertDate = insertDate;
            }

            // ── MEMBERS ──────────────────────────────────────────────────────
            if (memberId) {
                if (!membersMap.has(memberId)) {
                    const record = { _insertDate: insertDate };
                    for (const col of memberCols) {
                        record[this.toCamelCase(col)] = row[col] !== undefined ? row[col] : null;
                    }
                    if (!('providerTin' in record)) record.providerTin = providerTin;
                    membersMap.set(memberId, record);
                } else {
                    const existing = membersMap.get(memberId);
                    mergeLatest(existing, row, memberCols);
                    if (!existing.providerTin && providerTin) existing.providerTin = providerTin;
                }
            }

            // ── PROVIDERS (latest non-null per TIN) ──────────────────────────
            if (providerTin) {
                if (!providersMap.has(providerTin)) {
                    const record = { _insertDate: insertDate };
                    for (const col of provCols) {
                        record[this.toCamelCase(col)] = row[col] !== undefined ? row[col] : null;
                    }
                    providersMap.set(providerTin, record);
                } else {
                    mergeLatest(providersMap.get(providerTin), row, provCols);
                }
            }

            // ── GAPS (latest non-null per member; captures gap closure Y→N) ──
            if (memberId) {
                if (!gapsMap.has(memberId)) {
                    const record = { _insertDate: insertDate };
                    for (const col of gapCols) {
                        record[this.toCamelCase(col)] = row[col] !== undefined ? row[col] : null;
                    }
                    if (!('providerTin' in record)) record.providerTin = providerTin;
                    gapsMap.set(memberId, record);
                } else {
                    const existing = gapsMap.get(memberId);
                    mergeLatest(existing, row, gapCols);
                    if (!existing.providerTin && providerTin) existing.providerTin = providerTin;
                }
            }
        }

        // Strip the internal _insertDate sentinel before returning
        const stripInternal = arr => arr.map(({ _insertDate, ...rest }) => rest);

        return {
            members:   stripInternal(Array.from(membersMap.values())),
            providers: stripInternal(Array.from(providersMap.values())),
            gaps:      stripInternal(Array.from(gapsMap.values())),
            dateRange: { min: minInsertDate, max: maxInsertDate }
        };
    }

    /**
     * Upload cleaned data to Azure Blob Storage
     */
    async uploadToBlob(blobPath, buffer) {
        try {
            const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);
            let blobContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            if (blobPath.endsWith('.csv'))  blobContentType = 'text/csv';
            if (blobPath.endsWith('.json')) blobContentType = 'application/json';
            await blockBlobClient.upload(buffer, buffer.length, {
                blobHTTPHeaders: { blobContentType }
            });
            console.log(`Uploaded cleaned file to blob: ${blobPath}`);
            return blobPath;
        } catch (error) {
            throw new Error(`Failed to upload to blob ${blobPath}: ${error.message}`);
        }
    }

    /**
     * Store processing metadata in database
     */
    async storeMetadata(metadata) {
        try {
            const pool = await sql.connect(this.config.sqlConnectionString);

            const query = `
                INSERT INTO FileProcessingMetadata (
                    FileID, FileName, ProjectName, Year, SharePointPath, BlobPath,
                    OriginalSize, CleanedSize, [RowCount], [ColumnCount], ProcessingStatus,
                    ErrorMessage, NewColumnsFound, MissingColumns, ProcessingStartTime, ProcessingEndTime
                ) VALUES (
                    @fileId, @fileName, @projectName, @year, @sharepointPath, @blobPath,
                    @originalSize, @cleanedSize, @rowCount, @columnCount, @processingStatus,
                    @errorMessage, @newColumnsFound, @missingColumns, @processingStartTime, @processingEndTime
                )
            `;

            await pool.request()
                .input('fileId', sql.NVarChar, metadata.fileId)
                .input('fileName', sql.NVarChar, metadata.fileName)
                .input('projectName', sql.NVarChar, metadata.projectName)
                .input('year', sql.NVarChar, metadata.year)
                .input('sharepointPath', sql.NVarChar, metadata.sharepointPath)
                .input('blobPath', sql.NVarChar, metadata.blobPath || null)
                .input('originalSize', sql.BigInt, metadata.originalSize)
                .input('cleanedSize', sql.BigInt, metadata.cleanedSize || null)
                .input('rowCount', sql.Int, metadata.rowCount || null)
                .input('columnCount', sql.Int, metadata.columnCount || null)
                .input('processingStatus', sql.NVarChar, metadata.processingStatus)
                .input('errorMessage', sql.NVarChar, metadata.errorMessage || null)
                .input('newColumnsFound', sql.NVarChar, JSON.stringify(metadata.newColumnsFound || []))
                .input('missingColumns', sql.NVarChar, JSON.stringify(metadata.missingColumns || []))
                .input('processingStartTime', sql.DateTime2, metadata.processingStartTime)
                .input('processingEndTime', sql.DateTime2, metadata.processingEndTime || null)
                .query(query);

            console.log(`Stored metadata for file: ${metadata.fileName}`);
        } catch (error) {
            console.error('Failed to store metadata:', error);
            throw error;
        }
    }

    /**
     * Process a single file through the cleaning pipeline
     * This method expects file content as a buffer (simulating what would come from SharePoint)
     *
     * @param {Object|string} fileInfo  - File metadata object (or legacy: path string)
     * @param {Buffer|string} fileBuffer - File content buffer (or legacy: project name string)
     * @param {Object}        options   - Optional overrides
     * @param {string}        options.outputMode - 'excel' (default) or 'json'
     */
    async processFile(fileInfo, fileBuffer, options = {}) {
        // allow legacy call signature: (filePath, projectName)
        if (typeof fileInfo === 'string' && typeof fileBuffer === 'string') {
            const filePath = fileInfo;
            const projectKey = fileBuffer;
            // read the file from disk
            try {
                fileBuffer = fs.readFileSync(filePath);
            } catch (err) {
                throw new Error(`Unable to read file at path ${filePath}: ${err.message}`);
            }
            fileInfo = {
                id: path.basename(filePath),
                name: path.basename(filePath),
                sharepointPath: `Shared Documents/${projectKey}`
            };
        }

        const startTime = new Date();
        const { projectName, year } = this.detectProjectFromPath(fileInfo.sharepointPath);

        // Create metadata record
        const metadata = {
            fileId: fileInfo.id,
            fileName: fileInfo.name,
            projectName,
            year,
            sharepointPath: fileInfo.sharepointPath,
            blobPath: null,
            originalSize: fileBuffer.length,
            cleanedSize: null,
            rowCount: null,
            columnCount: null,
            processingStatus: 'Processing',
            errorMessage: null,
            newColumnsFound: [],
            missingColumns: [],
            processingStartTime: startTime,
            processingEndTime: null
        };

        try {
            console.log(`Processing file: ${fileInfo.name} for project: ${projectName}`);

            // Determine file type and read data
            const fileExtension = path.extname(fileInfo.name).toLowerCase();
            let data;

            if (['.xlsx', '.xls'].includes(fileExtension)) {
                data = this.readExcelFile(fileBuffer);
            } else if (fileExtension === '.csv') {
                data = this.readCsvFile(fileBuffer);
            } else {
                throw new Error(`Unsupported file type: ${fileExtension}`);
            }

            // Apply cleaning
            const { cleanedData, newColumns, missingColumns } = this.cleanFileData(data, projectName, fileExtension);

            // Auto-update schema with new columns if enabled
            if (newColumns && newColumns.length > 0) {
                this.schemaManager.updateSchemaWithNewColumns(projectName, newColumns);
            }

            // Update metadata
            metadata.rowCount = cleanedData.length;
            metadata.columnCount = cleanedData.length > 0 ? Object.keys(cleanedData[0]).length : 0;
            metadata.newColumnsFound = newColumns;
            metadata.missingColumns = missingColumns;

            if (missingColumns && missingColumns.length) {
                console.warn(`File ${fileInfo.name} missing expected columns: ${missingColumns.join(', ')}`);
            }

            // Determine output mode: per-request option > env var > default 'excel'
            const outputMode = options.outputMode || this.config.outputMode || 'excel';

            let blobPath;
            let groupedData = null;

            if (outputMode === 'json') {
                // --- JSON path: group by targetTable and upload as .json ---
                const schema = this.schemaManager.getSchema(projectName);
                groupedData = this.groupByTable(cleanedData, schema);

                const baseName = path.basename(fileInfo.name, path.extname(fileInfo.name));
                const uploadedBlobPaths = [];

                // Option to upload one file per destination table instead of a single aggregated JSON
                if (options.separateTableFiles) {
                    metadata.cleanedSize = 0;
                    for (const [tableName, rows] of Object.entries(groupedData)) {
                        const tableBuffer = Buffer.from(JSON.stringify(rows, null, 2), 'utf8');
                        metadata.cleanedSize += tableBuffer.length;
                        const tableBlobPath = `cleaned/${projectName.toLowerCase()}/${year}/${baseName}_${tableName}_cleaned.json`;
                        await this.uploadToBlob(tableBlobPath, tableBuffer);
                        uploadedBlobPaths.push(tableBlobPath);
                    }

                    // Preserve legacy single-string blobPath by storing JSON array string
                    blobPath = JSON.stringify(uploadedBlobPaths);
                    metadata.uploadedBlobPaths = uploadedBlobPaths;
                } else {
                    const jsonBuffer = Buffer.from(JSON.stringify(groupedData, null, 2), 'utf8');
                    metadata.cleanedSize = jsonBuffer.length;

                    blobPath = `cleaned/${projectName.toLowerCase()}/${year}/${baseName}_cleaned.json`;
                    await this.uploadToBlob(blobPath, jsonBuffer);

                    // Keep a unified list for callers
                    metadata.uploadedBlobPaths = [blobPath];
                }
            } else if (outputMode === 'normalized-json') {
                // --- Normalized JSON: aetna_members_YYYYMMDD.json (or _YYYYMMDD_to_YYYYMMDD.json) ---
                const schema = this.schemaManager.getSchema(projectName);
                const normalized = this.normalizeToThreeFiles(cleanedData, schema);

                // Build date suffix from insert_date values in the data; fall back to today
                const fmtDate = d => d ? d.replace(/-/g, '') : null;
                const minFmt  = fmtDate(normalized.dateRange.min);
                const maxFmt  = fmtDate(normalized.dateRange.max);
                const todayFmt = new Date().toISOString().split('T')[0].replace(/-/g, '');
                const dateSuffix = !minFmt         ? todayFmt
                    : minFmt === maxFmt ? minFmt
                    : `${minFmt}_to_${maxFmt}`;

                const proj = projectName.toLowerCase();
                const { dateRange, ...tableGroups } = normalized;
                const uploadedBlobPaths = [];
                metadata.cleanedSize = 0;

                for (const [tableName, records] of Object.entries(tableGroups)) {
                    const tableBuffer = Buffer.from(JSON.stringify(records, null, 2), 'utf8');
                    metadata.cleanedSize += tableBuffer.length;
                    // Fixed predictable name: {project}_{table}_{dateSuffix}.json
                    const tableBlobPath = `cleaned/${proj}/${year}/${proj}_${tableName}_${dateSuffix}.json`;
                    await this.uploadToBlob(tableBlobPath, tableBuffer);
                    uploadedBlobPaths.push(tableBlobPath);
                }

                blobPath = JSON.stringify(uploadedBlobPaths);
                metadata.uploadedBlobPaths = uploadedBlobPaths;
                groupedData = normalized;

            } else {
                // --- Excel/CSV path (existing behaviour) ---
                const cleanedBuffer = this.convertToBuffer(cleanedData, fileExtension);
                metadata.cleanedSize = cleanedBuffer.length;

                blobPath = `cleaned/${projectName.toLowerCase()}/${year}/${fileInfo.name}`;
                await this.uploadToBlob(blobPath, cleanedBuffer);

                metadata.uploadedBlobPaths = [blobPath];
            }

            metadata.blobPath = blobPath;

            // Mark as successful
            metadata.processingStatus = 'Success';
            metadata.processingEndTime = new Date();

            // Store metadata — non-fatal: a SQL failure must not roll back a successful blob upload
            try {
                await this.storeMetadata(metadata);
            } catch (metaError) {
                console.warn(`Failed to store success metadata for ${fileInfo.name}:`, metaError.message);
            }

            console.log(`Successfully processed file: ${fileInfo.name}`);
            return { success: true, metadata, groupedData };

        } catch (error) {
            console.error(`Failed to process file ${fileInfo.name}:`, error);

            // Update metadata with error
            metadata.processingStatus = 'Failed';
            metadata.errorMessage = error.message;
            metadata.processingEndTime = new Date();

            try {
                await this.storeMetadata(metadata);
            } catch (metaError) {
                console.warn('Failed to store error metadata:', metaError.message);
            }

            return { success: false, error: error.message, metadata };
        }
    }

    /**
     * Start automated monitoring (placeholder - would integrate with SharePoint monitoring)
     */
    startMonitoring() {
        if (this.isMonitoring) {
            console.log('Monitoring already running');
            return;
        }

        console.log(`Starting automated cleaning monitoring with ${this.config.pollingIntervalMinutes} minute intervals`);
        this.isMonitoring = true;

        // Schedule monitoring task
        const cronExpression = `*/${this.config.pollingIntervalMinutes} * * * *`; // Every N minutes
        cron.schedule(cronExpression, async () => {
            try {
                await this.performMonitoringScan();
            } catch (error) {
                console.error('Error in monitoring scan:', error);
            }
        });

        console.log('Cleaning monitoring started');
    }

    /**
     * Stop automated monitoring
     */
    stopMonitoring() {
        this.isMonitoring = false;
        console.log('Cleaning monitoring stopped');
    }

    /**
     * Perform a monitoring scan (placeholder for SharePoint integration)
     */
    async performMonitoringScan() {
        console.log('Performing cleaning monitoring scan...');
        // This would integrate with SharePoint to check for new files
        // For now, it's a placeholder
        this.lastCheckTime = new Date();
        console.log('Monitoring scan completed');
    }

    /**
     * Manual trigger for cleaning scan
     */
    async triggerCleaningScan() {
        console.log('Manual cleaning scan triggered');
        await this.performMonitoringScan();
        return { message: 'Cleaning scan completed' };
    }

    /**
     * Get current cleaning system status
     */
    async getStatus() {
        return {
            status: this.isMonitoring ? 'running' : 'stopped',
            last_scan: this.lastCheckTime?.toISOString() || null,
            monitoring_enabled: this.isMonitoring,
            polling_interval_minutes: this.config.pollingIntervalMinutes,
            files_processed_today: this.filesProcessedToday || 0,
            pending_files: 0,
            failed_files: 0
        };
    }

    /**
     * Get processing statistics
     */
    async getProcessingStats() {
        // In a real implementation, this would query the SQL Server metadata table
        // For now, return summary statistics
        return {
            summary: {
                total_files_processed: this.totalFilesProcessed || 0,
                successful: this.successfulFiles || 0,
                failed: this.failedFiles || 0,
                success_rate: this.totalFilesProcessed ? 
                    ((this.successfulFiles || 0) / this.totalFilesProcessed * 100).toFixed(2) + '%' : 'N/A'
            },
            projects: Array.from(this.schemas.keys()).map(project => ({
                name: project,
                files_processed: 0,
                last_processed: null
            }))
        };
    }

    /**
     * Trigger manual cleaning scan
     */
    async triggerManualScan() {
        try {
            await this.performMonitoringScan();
            return {
                message: 'Cleaning scan initiated successfully',
                scan_id: Date.now().toString(),
                status: 'completed',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                message: 'Cleaning scan triggered but encountered errors',
                error: error.message,
                status: 'error'
            };
        }
    }

    /**
     * Get list of failed files
     */
    async getFailedFiles() {
        // Prefer querying the metadata table if a SQL connection is available
        if (this.config.sqlConnectionString) {
            try {
                const pool = await sql.connect(this.config.sqlConnectionString);
                const result = await pool.request()
                    .query(`
                        SELECT FileID, FileName, ProjectName, BlobPath, ErrorMessage,
                               MissingColumns, ProcessingStartTime
                        FROM FileProcessingMetadata
                        WHERE ProcessingStatus = 'Failed'
                        ORDER BY ProcessingStartTime DESC
                    `);

                return result.recordset.map(row => ({
                    fileId: row.FileID,
                    filename: row.FileName,
                    project: row.ProjectName,
                    blobPath: row.BlobPath,
                    error_message: row.ErrorMessage,
                    missing_columns: row.MissingColumns ? JSON.parse(row.MissingColumns) : [],
                    failed_at: row.ProcessingStartTime,
                    retry_count: 0 // not tracked yet
                }));
            } catch (err) {
                console.warn('Failed to query metadata for failed files, falling back to quarantine folder:', err.message);
            }
        }

        // fallback: check quarantine folder
        const failedFiles = [];
        if (fs.existsSync(this.config.quarantineFolder)) {
            const files = fs.readdirSync(this.config.quarantineFolder);
            for (const file of files) {
                const filePath = path.join(this.config.quarantineFolder, file);
                const stats = fs.statSync(filePath);
                failedFiles.push({
                    filename: file,
                    path: filePath,
                    size_bytes: stats.size,
                    failed_at: stats.mtime.toISOString(),
                    error_message: 'See quarantine folder',
                    retry_count: 0
                });
            }
        }
        return failedFiles;
    }

    /**
     * Get available projects and their schemas
     */
    async getAvailableProjects() {
        const projects = [];
        
        for (const [projectName, schema] of this.schemas.entries()) {
            projects.push({
                name: projectName.charAt(0).toUpperCase() + projectName.slice(1),
                key: projectName,
                schema_file: `schemas/${projectName}.json`,
                column_count: Object.keys(schema.columns || {}).length,
                required_fields: (schema.requiredFields || []).length,
                data_quality_rules: (schema.dataQualityRules || []).length,
                last_updated: new Date().toISOString()
            });
        }
        
        return projects;
    }

    /**
     * Get schema details for a specific project
     */
    async getProjectSchema(projectName) {
        return this.schemas.getSchema(projectName);
    }

    /**
     * Retry processing a failed file
     */
    async retryFailedFile(fileId) {
        try {
            // In a real implementation, this would find the file in quarantine and reprocess it
            return {
                message: `File ${fileId} queued for retry`,
                fileId,
                status: 'queued',
                retry_count: 1,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                message: 'Failed to queue file for retry',
                error: error.message,
                status: 'error'
            };
        }
    }

    /**
     * Get recent processing logs
     */
    async getProcessingLogs(limit = 50) {
        // Attempt to read from metadata table when SQL is available
        if (this.config.sqlConnectionString) {
            try {
                const pool = await sql.connect(this.config.sqlConnectionString);
                const result = await pool.request()
                    .input('limit', sql.Int, limit)
                    .query(`
                        SELECT TOP (@limit)
                            FileID, FileName, ProjectName, ProcessingStatus,
                            ErrorMessage, NewColumnsFound, MissingColumns,
                            ProcessingStartTime, ProcessingEndTime
                        FROM FileProcessingMetadata
                        ORDER BY ProcessingStartTime DESC
                    `);

                const logs = result.recordset.map(row => ({
                    fileId: row.FileID,
                    fileName: row.FileName,
                    project: row.ProjectName,
                    status: row.ProcessingStatus,
                    errorMessage: row.ErrorMessage,
                    new_columns: row.NewColumnsFound ? JSON.parse(row.NewColumnsFound) : [],
                    missing_columns: row.MissingColumns ? JSON.parse(row.MissingColumns) : [],
                    processingStartTime: row.ProcessingStartTime,
                    processingEndTime: row.ProcessingEndTime
                }));

                return {
                    logs,
                    total_available: logs.length,
                    limit_used: limit
                };
            } catch (err) {
                console.warn('Failed to query processing logs:', err.message);
            }
        }

        // fallback placeholder
        const logs = [];
        return {
            logs: logs.slice(0, limit),
            total_available: logs.length,
            limit_used: limit
        };
    }

}

// Export singleton instance
const config = new DataCleaningConfig();
const dataCleaner = new DataCleaner(config);

export { DataCleaner, dataCleaner, DataCleaningConfig };
export default dataCleaner;