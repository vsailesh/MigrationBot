import { parse } from 'csv-parse/sync';

/**
 * Detect the schema of a file from its content.
 * Supports CSV and JSON/JSONL formats.
 * Returns: { columns: [...], rowCount, sampleRows: [...] }
 */
export function detectSchema(content, format = 'CSV') {
    try {
        if (format === 'CSV' || format === 'TSV') {
            return detectCsvSchema(content, format === 'TSV' ? '\t' : ',');
        } else if (format === 'JSON') {
            return detectJsonSchema(content);
        } else if (format === 'JSONL') {
            return detectJsonlSchema(content);
        } else {
            return { columns: [], rowCount: 0, sampleRows: [], error: `Unsupported format: ${format}` };
        }
    } catch (err) {
        return { columns: [], rowCount: 0, sampleRows: [], error: err.message };
    }
}

function detectCsvSchema(content, delimiter = ',') {
    const records = parse(content, {
        columns: true,
        delimiter,
        skip_empty_lines: true,
        trim: true,
        relax_quotes: true,
        relax_column_count: true,
    });

    if (records.length === 0) {
        return { columns: [], rowCount: 0, sampleRows: [] };
    }

    const headers = Object.keys(records[0]);
    const columns = headers.map((header) => {
        const values = records.map((row) => row[header]).filter((v) => v !== '' && v !== undefined && v !== null);
        const detectedType = inferType(values);

        return {
            name: sanitizeColumnName(header),
            originalName: header,
            detectedType: detectedType.jsType,
            sqlType: detectedType.sqlType,
            adfType: detectedType.adfType,
            nullable: values.length < records.length,
            sampleValues: values.slice(0, 3),
        };
    });

    return {
        columns,
        rowCount: records.length,
        sampleRows: records.slice(0, 5),
        format: 'CSV',
    };
}

function detectJsonSchema(content) {
    let data = JSON.parse(content);

    // Handle both array-of-objects and single-object
    if (!Array.isArray(data)) {
        data = [data];
    }

    if (data.length === 0) {
        return { columns: [], rowCount: 0, sampleRows: [] };
    }

    // Collect all keys from all objects
    const allKeys = new Set();
    data.forEach((obj) => {
        if (typeof obj === 'object' && obj !== null) {
            Object.keys(obj).forEach((key) => allKeys.add(key));
        }
    });

    const columns = [...allKeys].map((key) => {
        const values = data
            .map((obj) => obj[key])
            .filter((v) => v !== undefined && v !== null && v !== '');
        const detectedType = inferType(values.map(String));

        return {
            name: sanitizeColumnName(key),
            originalName: key,
            detectedType: detectedType.jsType,
            sqlType: detectedType.sqlType,
            adfType: detectedType.adfType,
            nullable: values.length < data.length,
            sampleValues: values.slice(0, 3).map(String),
        };
    });

    return {
        columns,
        rowCount: data.length,
        sampleRows: data.slice(0, 5),
        format: 'JSON',
    };
}

function detectJsonlSchema(content) {
    const lines = content.split('\n').filter((l) => l.trim());
    const data = lines.map((line) => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (data.length === 0) {
        return { columns: [], rowCount: 0, sampleRows: [] };
    }

    // Same as JSON schema detection from here
    const allKeys = new Set();
    data.forEach((obj) => {
        if (typeof obj === 'object' && obj !== null) {
            Object.keys(obj).forEach((key) => allKeys.add(key));
        }
    });

    const columns = [...allKeys].map((key) => {
        const values = data.map((obj) => obj[key]).filter((v) => v !== undefined && v !== null && v !== '');
        const detectedType = inferType(values.map(String));

        return {
            name: sanitizeColumnName(key),
            originalName: key,
            detectedType: detectedType.jsType,
            sqlType: detectedType.sqlType,
            adfType: detectedType.adfType,
            nullable: values.length < data.length,
            sampleValues: values.slice(0, 3).map(String),
        };
    });

    return {
        columns,
        rowCount: data.length,
        sampleRows: data.slice(0, 5),
        format: 'JSONL',
    };
}

/**
 * Infer the SQL type from sample values.
 */
function inferType(values) {
    if (values.length === 0) return { jsType: 'string', sqlType: 'NVARCHAR(255)', adfType: 'String' };

    const sample = values.slice(0, 100);
    let isInt = true, isFloat = true, isBool = true, isDate = true;

    for (const val of sample) {
        const str = String(val).trim();
        if (str === '') continue;

        // Check integer
        if (isInt && !/^-?\d+$/.test(str)) isInt = false;
        // Check float
        if (isFloat && !/^-?\d+\.?\d*$/.test(str)) isFloat = false;
        // Check boolean
        if (isBool && !['true', 'false', '1', '0', 'yes', 'no'].includes(str.toLowerCase())) isBool = false;
        // Check date
        if (isDate) {
            const d = new Date(str);
            if (isNaN(d.getTime()) || str.length < 8) isDate = false;
        }
    }

    if (isBool) return { jsType: 'boolean', sqlType: 'BIT', adfType: 'Boolean' };
    if (isInt) {
        const maxVal = Math.max(...sample.map((v) => Math.abs(parseInt(v) || 0)));
        if (maxVal > 2147483647) return { jsType: 'bigint', sqlType: 'BIGINT', adfType: 'Int64' };
        return { jsType: 'integer', sqlType: 'INT', adfType: 'Int32' };
    }
    if (isFloat) return { jsType: 'float', sqlType: 'FLOAT', adfType: 'Double' };
    if (isDate) return { jsType: 'date', sqlType: 'DATETIME', adfType: 'DateTime' };

    // String — determine length
    const maxLen = Math.max(...sample.map((v) => String(v).length));
    if (maxLen > 4000) return { jsType: 'string', sqlType: 'NVARCHAR(MAX)', adfType: 'String' };
    const size = Math.max(255, Math.ceil(maxLen * 1.5 / 50) * 50); // Round up to nearest 50
    return { jsType: 'string', sqlType: `NVARCHAR(${size})`, adfType: 'String' };
}

/**
 * Sanitize a column name for SQL compatibility.
 */
function sanitizeColumnName(name) {
    return name
        .replace(/[^\w\s]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/__+/g, '_')
        || 'column';
}

/**
 * Generate SQL CREATE TABLE DDL from detected schema.
 */
export function generateDDL(tableName, columns, schema = 'dbo') {
    const colDefs = columns.map((col) =>
        `  [${col.name}] ${col.sqlType}${col.nullable ? ' NULL' : ' NOT NULL'}`
    ).join(',\n');

    return `CREATE TABLE [${schema}].[${tableName}] (\n  [_migration_id] INT IDENTITY(1,1) PRIMARY KEY,\n${colDefs}\n);`;
}

// -----------------------------------------------------------------------------
// Schema validation helpers
// -----------------------------------------------------------------------------

/**
 * Validate column definitions against the actual blob content. Currently this
 * only checks boolean columns and returns an array of error messages for any
 * values that don't look like a valid boolean. The calling code can present
 * these to the user so they can adjust the schema before running migration.
 */
export function validateColumns(content, format = 'CSV', columns = []) {
    const errors = [];
    const boolCols = columns.filter(c => c.adfType === 'Boolean');
    if (boolCols.length === 0) return errors;

    try {
        if (format === 'CSV' || format === 'TSV') {
            const { parse } = require('csv-parse/sync');
            const records = parse(content, {
                columns: true,
                delimiter: format === 'TSV' ? '\t' : ',',
                skip_empty_lines: true,
                trim: true,
                relax_quotes: true,
                relax_column_count: true,
            });
            const boolSet = new Set(['true','false','1','0','yes','no']);
            records.slice(0,1000).forEach((row, idx) => {
                boolCols.forEach(col => {
                    const key = col.originalName || col.name;
                    const val = row[key];
                    if (val !== undefined && val !== null && String(val).trim() !== '') {
                        const str = String(val).trim().toLowerCase();
                        if (!boolSet.has(str)) {
                            errors.push(`Column ${col.name} has non-boolean value "${val}" at row ${idx+1}`);
                        }
                    }
                });
            });
        } else if (format === 'JSON' || format === 'JSONL') {
            const raw = format === 'JSONL' ?
                content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) :
                JSON.parse(content);
            const data = Array.isArray(raw) ? raw : [raw];
            const boolSet = new Set(['true','false','1','0','yes','no']);
            data.slice(0,1000).forEach((obj, idx) => {
                boolCols.forEach(col => {
                    const key = col.originalName || col.name;
                    const val = obj[key];
                    if (val !== undefined && val !== null && String(val).trim() !== '') {
                        const str = String(val).trim().toLowerCase();
                        if (!boolSet.has(str)) {
                            errors.push(`Column ${col.name} has non-boolean value "${val}" at row ${idx+1}`);
                        }
                    }
                });
            });
        }
    } catch (e) {
        // ignore parse errors
    }
    return errors;
}

