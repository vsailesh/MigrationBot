import { DataFactoryManagementClient } from '@azure/arm-datafactory';
import { ClientSecretCredential } from '@azure/identity';
import { getStorageAccountName } from './blobClient.js';

let adfClient = null;

function getClient() {
    if (!adfClient) {
        const tenantId = process.env.AZURE_TENANT_ID;
        const clientId = process.env.AZURE_CLIENT_ID;
        const clientSecret = process.env.AZURE_CLIENT_SECRET;
        const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;

        if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
            throw new Error('Azure Service Principal credentials (TENANT_ID, CLIENT_ID, CLIENT_SECRET, SUBSCRIPTION_ID) are not configured');
        }

        const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
        adfClient = new DataFactoryManagementClient(credential, subscriptionId);
    }
    return adfClient;
}

function getFactoryParams() {
    return {
        resourceGroupName: process.env.AZURE_RESOURCE_GROUP,
        factoryName: process.env.AZURE_DATA_FACTORY_NAME,
    };
}

// ════════════════════════════════════════════════════
// Connection Test
// ════════════════════════════════════════════════════

export async function testAdfConnection() {
    try {
        const client = getClient();
        const { resourceGroupName, factoryName } = getFactoryParams();
        const factory = await client.factories.get(resourceGroupName, factoryName);
        return {
            connected: true,
            factoryName: factory.name,
            location: factory.location,
            provisioningState: factory.provisioningState,
        };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

// ════════════════════════════════════════════════════
// Linked Services
// ════════════════════════════════════════════════════

/**
 * Create or update an Azure Blob Storage linked service.
 */
export async function createBlobLinkedService(linkedServiceName = 'MigrationBot_BlobStorage') {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    const linkedService = {
        properties: {
            type: 'AzureBlobStorage',
            typeProperties: {
                connectionString: {
                    type: 'SecureString',
                    value: process.env.AZURE_STORAGE_CONNECTION_STRING,
                },
            },
        },
    };

    const result = await client.linkedServices.createOrUpdate(
        resourceGroupName, factoryName, linkedServiceName, linkedService
    );

    console.log(`✅ ADF: Created Blob linked service: ${linkedServiceName}`);
    return { name: result.name, type: 'AzureBlobStorage' };
}

/**
 * Create or update an Azure SQL Database linked service.
 */
export async function createSqlLinkedService(linkedServiceName = 'MigrationBot_AzureSQL') {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    const server = process.env.AZURE_SQL_SERVER;
    const database = process.env.AZURE_SQL_DATABASE;
    const user = process.env.AZURE_SQL_USER;
    const password = process.env.AZURE_SQL_PASSWORD;

    const connectionString = `Server=tcp:${server},1433;Database=${database};User ID=${user};Password=${password};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;`;

    const linkedService = {
        properties: {
            type: 'AzureSqlDatabase',
            typeProperties: {
                connectionString: {
                    type: 'SecureString',
                    value: connectionString,
                },
            },
        },
    };

    const result = await client.linkedServices.createOrUpdate(
        resourceGroupName, factoryName, linkedServiceName, linkedService
    );

    console.log(`✅ ADF: Created SQL linked service: ${linkedServiceName}`);
    return { name: result.name, type: 'AzureSqlDatabase' };
}

// ════════════════════════════════════════════════════
// Datasets
// ════════════════════════════════════════════════════

/**
 * Create a source dataset (Blob CSV/JSON).
 */
export async function createBlobDataset({ datasetName, containerName, fileName, format = 'CSV', columns = [], linkedServiceName = 'MigrationBot_BlobStorage' }) {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    let datasetType, formatProps;

    if (format === 'CSV') {
        datasetType = 'DelimitedText';
        formatProps = {
            type: 'DelimitedTextReadSettings',
            columnDelimiter: ',',
            quoteChar: '"',
            firstRowAsHeader: true,
        };
    } else if (format === 'JSON' || format === 'JSONL') {
        datasetType = 'Json';
        formatProps = {};
    } else if (format === 'Parquet') {
        datasetType = 'Parquet';
        formatProps = {};
    } else {
        datasetType = 'DelimitedText';
        formatProps = {
            columnDelimiter: ',',
            quoteChar: '"',
            firstRowAsHeader: true,
        };
    }

    const dataset = {
        properties: {
            type: datasetType,
            linkedServiceName: {
                type: 'LinkedServiceReference',
                referenceName: linkedServiceName,
            },
            typeProperties: {
                location: {
                    type: 'AzureBlobStorageLocation',
                    container: containerName,
                    fileName: fileName,
                },
                ...(datasetType === 'DelimitedText' ? {
                    columnDelimiter: ',',
                    quoteChar: '"',
                    firstRowAsHeader: true,
                } : {}),
            },
            ...(columns.length > 0 ? {
                schema: columns.map((col) => ({
                    name: col.name,
                    type: col.adfType || 'String',
                })),
            } : {}),
        },
    };

    const result = await client.datasets.createOrUpdate(
        resourceGroupName, factoryName, datasetName, dataset
    );

    console.log(`✅ ADF: Created source dataset: ${datasetName}`);
    return { name: result.name, type: datasetType };
}

/**
 * Create a sink dataset (Azure SQL table).
 */
export async function createSqlDataset({ datasetName, tableName, schema = 'dbo', columns = [], linkedServiceName = 'MigrationBot_AzureSQL' }) {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    const dataset = {
        properties: {
            type: 'AzureSqlTable',
            linkedServiceName: {
                type: 'LinkedServiceReference',
                referenceName: linkedServiceName,
            },
            typeProperties: {
                schema: schema,
                table: tableName,
            },
            ...(columns.length > 0 ? {
                schema: columns.map((col) => ({
                    name: col.name,
                    type: col.adfType || 'String',
                })),
            } : {}),
        },
    };

    const result = await client.datasets.createOrUpdate(
        resourceGroupName, factoryName, datasetName, dataset
    );

    console.log(`✅ ADF: Created sink dataset: ${datasetName}`);
    return { name: result.name, type: 'AzureSqlTable' };
}

// ════════════════════════════════════════════════════
// Pipelines
// ════════════════════════════════════════════════════

/**
 * Create a Copy Activity pipeline.
 */
export async function createCopyPipeline({ pipelineName, sourceDatasetName, sinkDatasetName, columnMapping = [] }) {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    const copyActivity = {
        name: 'CopyBlobToSql',
        type: 'Copy',
        inputs: [{ type: 'DatasetReference', referenceName: sourceDatasetName }],
        outputs: [{ type: 'DatasetReference', referenceName: sinkDatasetName }],
        typeProperties: {
            source: { type: 'DelimitedTextSource', storeSettings: { type: 'AzureBlobStorageReadSettings', recursive: false } },
            sink: { type: 'AzureSqlSink', writeBehavior: 'insert', sqlWriterUseTableLock: false },
            enableStaging: false,
        },
    };

    // Add column mapping if provided
    if (columnMapping.length > 0) {
        copyActivity.typeProperties.translator = {
            type: 'TabularTranslator',
            mappings: columnMapping.map((m) => ({
                source: { name: m.source },
                sink: { name: m.sink || m.source },
            })),
        };
    }

    const pipeline = {
        properties: {
            activities: [copyActivity],
            annotations: ['MigrationBot', 'AutoGenerated'],
        },
    };

    const result = await client.pipelines.createOrUpdate(
        resourceGroupName, factoryName, pipelineName, pipeline
    );

    console.log(`✅ ADF: Created pipeline: ${pipelineName}`);
    return { name: result.name };
}

// ════════════════════════════════════════════════════
// Pipeline Runs
// ════════════════════════════════════════════════════

/**
 * Trigger a pipeline run.
 */
export async function triggerPipelineRun(pipelineName) {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    const result = await client.pipelines.createRun(
        resourceGroupName, factoryName, pipelineName
    );

    console.log(`🚀 ADF: Triggered pipeline run: ${result.runId}`);
    return { runId: result.runId, pipelineName };
}

/**
 * Get the status of a pipeline run.
 */
export async function getPipelineRunStatus(runId) {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    const run = await client.pipelineRuns.get(resourceGroupName, factoryName, runId);

    return {
        runId: run.runId,
        pipelineName: run.pipelineName,
        status: run.status,
        runStart: run.runStart,
        runEnd: run.runEnd,
        durationInMs: run.durationInMs,
        message: run.message,
    };
}

/**
 * Get activity runs for a pipeline run (details of copy operations).
 */
export async function getActivityRuns(runId, pipelineName) {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const result = await client.activityRuns.queryByPipelineRun(
        resourceGroupName, factoryName, runId,
        { lastUpdatedAfter: dayAgo, lastUpdatedBefore: now }
    );

    return (result.value || []).map((activity) => ({
        activityName: activity.activityName,
        activityType: activity.activityType,
        status: activity.status,
        input: activity.input,
        output: activity.output,
        error: activity.error,
        durationInMs: activity.durationInMs,
    }));
}

/**
 * List all pipelines in the data factory.
 */
export async function listPipelines() {
    const client = getClient();
    const { resourceGroupName, factoryName } = getFactoryParams();

    const pipelines = [];
    for await (const pipeline of client.pipelines.listByFactory(resourceGroupName, factoryName)) {
        pipelines.push({
            name: pipeline.name,
            activities: pipeline.activities?.length || 0,
            annotations: pipeline.annotations,
        });
    }
    return pipelines;
}
