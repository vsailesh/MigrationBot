import { BlobServiceClient } from '@azure/storage-blob';

let blobServiceClient = null;

function normalizeConnectionString(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/^['"]|['"]$/g, '');
}

function getClient() {
    if (!blobServiceClient) {
        const connectionString = normalizeConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING || '');
        if (!connectionString || !connectionString.includes('DefaultEndpointsProtocol=')) {
            throw new Error(
                'AZURE_STORAGE_CONNECTION_STRING is not configured correctly. Expected a value that starts with "DefaultEndpointsProtocol=https;..." (without surrounding quotes).'
            );
        }
        blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    }
    return blobServiceClient;
}

/**
 * Test the Blob Storage connection.
 */
export async function testBlobConnection() {
    try {
        const client = getClient();
        const iter = client.listContainers();
        await iter.next(); // Just test we can connect
        return { connected: true };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

/**
 * List all containers in the storage account.
 */
export async function listContainers() {
    const client = getClient();
    const containers = [];
    for await (const container of client.listContainers()) {
        containers.push({
            name: container.name,
            lastModified: container.properties.lastModified,
        });
    }
    return containers;
}

/**
 * List blobs in a container, optionally with a prefix.
 */
export async function listBlobs(containerName, prefix = '') {
    const client = getClient();
    const containerClient = client.getContainerClient(containerName);
    const blobs = [];

    const options = prefix ? { prefix } : {};
    for await (const blob of containerClient.listBlobsFlat(options)) {
        blobs.push({
            name: blob.name,
            size: blob.properties.contentLength,
            lastModified: blob.properties.lastModified,
            contentType: blob.properties.contentType,
            format: detectFileFormat(blob.name),
        });
    }

    return blobs;
}

/**
 * Download a blob and return its content as a string (for text-based files).
 */
export async function downloadBlobContent(containerName, blobName, maxBytes = 1024 * 1024) {
    const client = getClient();
    const containerClient = client.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    const downloadResponse = await blobClient.download(0, maxBytes);
    const chunks = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Download a blob as a readable stream.
 */
export async function downloadBlobStream(containerName, blobName) {
    const client = getClient();
    const containerClient = client.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);
    const downloadResponse = await blobClient.download(0);
    return downloadResponse.readableStreamBody;
}

/**
 * Get blob properties (size, content type, etc.).
 */
export async function getBlobProperties(containerName, blobName) {
    const client = getClient();
    const containerClient = client.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);
    const props = await blobClient.getProperties();

    return {
        name: blobName,
        container: containerName,
        size: props.contentLength,
        contentType: props.contentType,
        lastModified: props.lastModified,
        format: detectFileFormat(blobName),
    };
}

/**
 * Get the storage account name from the connection string.
 */
export function getStorageAccountName() {
    const cs = normalizeConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING || '');
    const match = cs.match(/AccountName=([^;]+)/);
    return match ? match[1] : 'unknown';
}

/**
 * Detect file format from the file extension.
 */
function detectFileFormat(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    const formatMap = {
        csv: 'CSV',
        tsv: 'TSV',
        json: 'JSON',
        jsonl: 'JSONL',
        parquet: 'Parquet',
        xlsx: 'Excel',
        xls: 'Excel',
        txt: 'Text',
        xml: 'XML',
    };
    return formatMap[ext] || 'Unknown';
}
