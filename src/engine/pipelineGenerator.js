/**
 * Generates ADF pipeline JSON definitions for blob → SQL copy operations.
 */
export function generatePipelineDefinition({ jobId, containerName, blobName, tableName, columns, format = 'CSV', schema = 'dbo' }) {
    const safeName = sanitizeName(blobName);
    const sourceDatasetName = `DS_Blob_${safeName}_${jobId}`;
    const sinkDatasetName = `DS_Sql_${tableName}_${jobId}`;
    const pipelineName = `PL_Migrate_${safeName}_${jobId}`;
    const blobLinkedService = 'MigrationBot_BlobStorage';
    const sqlLinkedService = 'MigrationBot_AzureSQL';

    // Source dataset definition
    const sourceDataset = buildSourceDataset(sourceDatasetName, blobLinkedService, containerName, blobName, format, columns);

    // Sink dataset definition
    const sinkDataset = buildSinkDataset(sinkDatasetName, sqlLinkedService, tableName, schema, columns);

    // Pipeline with copy activity
    const pipeline = {
        name: pipelineName,
        properties: {
            activities: [
                {
                    name: `Copy_${safeName}_to_${tableName}`,
                    type: 'Copy',
                    inputs: [{ type: 'DatasetReference', referenceName: sourceDatasetName }],
                    outputs: [{ type: 'DatasetReference', referenceName: sinkDatasetName }],
                    typeProperties: {
                        source: buildSourceSettings(format),
                        sink: {
                            type: 'AzureSqlSink',
                            writeBehavior: 'insert',
                            sqlWriterUseTableLock: false,
                            tableOption: 'autoCreate',
                        },
                        translator: {
                            type: 'TabularTranslator',
                            mappings: columns.map((col) => ({
                                source: { name: col.originalName || col.name, type: col.adfType || 'String' },
                                sink: { name: col.name, type: col.adfType || 'String' },
                            })),
                        },
                        enableStaging: false,
                    },
                },
            ],
            annotations: ['MigrationBot', `Job:${jobId}`],
        },
    };

    return {
        pipelineName,
        sourceDatasetName,
        sinkDatasetName,
        blobLinkedService,
        sqlLinkedService,
        sourceDataset,
        sinkDataset,
        pipeline,
        columnMappings: columns.map((col) => ({
            source: col.originalName || col.name,
            sink: col.name,
            type: col.sqlType,
        })),
    };
}

function buildSourceDataset(name, linkedServiceName, containerName, blobName, format, columns) {
    const base = {
        name,
        properties: {
            linkedServiceName: { type: 'LinkedServiceReference', referenceName: linkedServiceName },
            schema: columns.map((col) => ({ name: col.originalName || col.name, type: col.adfType || 'String' })),
        },
    };

    if (format === 'CSV' || format === 'TSV') {
        base.properties.type = 'DelimitedText';
        base.properties.typeProperties = {
            location: { type: 'AzureBlobStorageLocation', container: containerName, fileName: blobName },
            columnDelimiter: format === 'TSV' ? '\t' : ',',
            quoteChar: '"',
            firstRowAsHeader: true,
        };
    } else if (format === 'JSON' || format === 'JSONL') {
        base.properties.type = 'Json';
        base.properties.typeProperties = {
            location: { type: 'AzureBlobStorageLocation', container: containerName, fileName: blobName },
        };
    } else if (format === 'Parquet') {
        base.properties.type = 'Parquet';
        base.properties.typeProperties = {
            location: { type: 'AzureBlobStorageLocation', container: containerName, fileName: blobName },
        };
    }

    return base;
}

function buildSinkDataset(name, linkedServiceName, tableName, schema, columns) {
    return {
        name,
        properties: {
            type: 'AzureSqlTable',
            linkedServiceName: { type: 'LinkedServiceReference', referenceName: linkedServiceName },
            typeProperties: { schema, table: tableName },
            schema: columns.map((col) => ({ name: col.name, type: col.adfType || 'String' })),
        },
    };
}

function buildSourceSettings(format) {
    if (format === 'CSV' || format === 'TSV') {
        return {
            type: 'DelimitedTextSource',
            storeSettings: { type: 'AzureBlobStorageReadSettings', recursive: false },
            formatSettings: { type: 'DelimitedTextReadSettings' },
        };
    } else if (format === 'JSON' || format === 'JSONL') {
        return {
            type: 'JsonSource',
            storeSettings: { type: 'AzureBlobStorageReadSettings', recursive: false },
            formatSettings: { type: 'JsonReadSettings' },
        };
    } else if (format === 'Parquet') {
        return {
            type: 'ParquetSource',
            storeSettings: { type: 'AzureBlobStorageReadSettings', recursive: false },
        };
    }
    return { type: 'BlobSource' };
}

function sanitizeName(name) {
    return name.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}
