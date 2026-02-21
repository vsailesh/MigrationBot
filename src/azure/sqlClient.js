import sql from 'mssql';

let pool = null;

function getConfig() {
    return {
        server: process.env.AZURE_SQL_SERVER,
        database: process.env.AZURE_SQL_DATABASE,
        user: process.env.AZURE_SQL_USER,
        password: process.env.AZURE_SQL_PASSWORD,
        options: {
            encrypt: true,
            trustServerCertificate: false,
        },
        connectionTimeout: 15000,
        requestTimeout: 60000,
    };
}

async function getPool() {
    if (!pool) {
        const config = getConfig();
        if (!config.server) {
            throw new Error('AZURE_SQL_SERVER is not configured');
        }
        pool = await sql.connect(config);
    }
    return pool;
}

/**
 * Test the SQL Database connection.
 */
export async function testSqlConnection() {
    try {
        const p = await getPool();
        const result = await p.request().query('SELECT 1 AS connected');
        return { connected: true, database: process.env.AZURE_SQL_DATABASE };
    } catch (err) {
        pool = null; // Reset pool on failure
        return { connected: false, error: err.message };
    }
}

/**
 * List all user tables in the database.
 */
export async function listTables() {
    const p = await getPool();
    const result = await p.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, 
      (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS c 
       WHERE c.TABLE_NAME = t.TABLE_NAME AND c.TABLE_SCHEMA = t.TABLE_SCHEMA) AS COLUMN_COUNT
    FROM INFORMATION_SCHEMA.TABLES t
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);
    return result.recordset.map((row) => ({
        schema: row.TABLE_SCHEMA,
        name: row.TABLE_NAME,
        columnCount: row.COLUMN_COUNT,
    }));
}

/**
 * Get column definitions for a table.
 */
export async function getTableColumns(tableName, schema = 'dbo') {
    const p = await getPool();
    const result = await p.request()
        .input('table', sql.VarChar, tableName)
        .input('schema', sql.VarChar, schema)
        .query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, 
             IS_NULLABLE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @table AND TABLE_SCHEMA = @schema
      ORDER BY ORDINAL_POSITION
    `);
    return result.recordset.map((col) => ({
        name: col.COLUMN_NAME,
        type: col.DATA_TYPE,
        maxLength: col.CHARACTER_MAXIMUM_LENGTH,
        nullable: col.IS_NULLABLE === 'YES',
        defaultValue: col.COLUMN_DEFAULT,
    }));
}

/**
 * Create a table from a schema definition.
 * @param {string} tableName 
 * @param {Array<{name: string, sqlType: string}>} columns 
 */
export async function createTable(tableName, columns, schema = 'dbo') {
    const p = await getPool();
    const columnDefs = columns.map((col) =>
        `[${col.name}] ${col.sqlType} ${col.nullable !== false ? 'NULL' : 'NOT NULL'}`
    ).join(',\n  ');

    const ddl = `
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${tableName}' AND TABLE_SCHEMA = '${schema}')
    BEGIN
      CREATE TABLE [${schema}].[${tableName}] (
        [_migration_id] INT IDENTITY(1,1) PRIMARY KEY,
        ${columnDefs}
      )
    END
  `;

    await p.request().query(ddl);
    return { created: true, tableName, schema, columns: columns.length };
}

/**
 * Bulk insert rows into a table.
 * @param {string} tableName 
 * @param {Array<{name: string, sqlType: string}>} columns 
 * @param {Array<Object>} rows 
 */
export async function bulkInsert(tableName, columns, rows, schema = 'dbo') {
    const p = await getPool();
    const table = new sql.Table(`[${schema}].[${tableName}]`);
    table.create = false;

    // Define columns
    for (const col of columns) {
        const sqlType = mapToMssqlType(col.sqlType);
        table.columns.add(col.name, sqlType, { nullable: true });
    }

    // Add rows
    for (const row of rows) {
        const values = columns.map((col) => {
            const val = row[col.name];
            if (val === undefined || val === null || val === '') return null;
            return val;
        });
        table.rows.add(...values);
    }

    const result = await p.request().bulk(table);
    return { rowsInserted: result.rowsAffected };
}

/**
 * Get row count for a table.
 */
export async function getRowCount(tableName, schema = 'dbo') {
    const p = await getPool();
    const result = await p.request().query(
        `SELECT COUNT(*) AS count FROM [${schema}].[${tableName}]`
    );
    return result.recordset[0].count;
}

/**
 * Close the connection pool.
 */
export async function closePool() {
    if (pool) {
        await pool.close();
        pool = null;
    }
}

function mapToMssqlType(sqlTypeStr) {
    const upper = (sqlTypeStr || '').toUpperCase();
    if (upper.includes('INT')) return sql.Int;
    if (upper.includes('BIGINT')) return sql.BigInt;
    if (upper.includes('FLOAT') || upper.includes('DECIMAL') || upper.includes('NUMERIC')) return sql.Float;
    if (upper.includes('BIT') || upper.includes('BOOL')) return sql.Bit;
    if (upper.includes('DATE') || upper.includes('DATETIME')) return sql.DateTime;
    if (upper.includes('TEXT') || upper.includes('MAX')) return sql.NVarChar(sql.MAX);
    if (upper.includes('NVARCHAR')) {
        const match = upper.match(/NVARCHAR\((\d+)\)/);
        return sql.NVarChar(match ? parseInt(match[1]) : 255);
    }
    if (upper.includes('VARCHAR')) {
        const match = upper.match(/VARCHAR\((\d+)\)/);
        return sql.VarChar(match ? parseInt(match[1]) : 255);
    }
    return sql.NVarChar(255);
}
