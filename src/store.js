import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'jobs.json');

let jobs = [];

// Load from disk on startup
function loadFromDisk() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            jobs = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
            console.log(`💾 Loaded ${jobs.length} migration jobs from disk`);
        }
    } catch (err) {
        console.warn(`⚠️  Failed to load jobs: ${err.message}`);
    }
}

function saveToDisk() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STORE_FILE, JSON.stringify(jobs, null, 2));
    } catch (err) {
        console.warn(`⚠️  Failed to save jobs: ${err.message}`);
    }
}

loadFromDisk();

/**
 * Add a new migration job.
 */
export function addJob(job) {
    const fullJob = {
        ...job,
        createdAt: new Date().toISOString(),
        logs: [],
    };
    jobs.unshift(fullJob);
    saveToDisk();
    return fullJob;
}

/**
 * Update a job by ID.
 */
export function updateJob(jobId, updates) {
    const job = jobs.find((j) => j.id === jobId);
    if (job) {
        Object.assign(job, updates, { updatedAt: new Date().toISOString() });
        saveToDisk();
    }
    return job;
}

/**
 * Add a log entry to a job.
 */
export function addLog(jobId, level, message) {
    const job = jobs.find((j) => j.id === jobId);
    if (job) {
        job.logs = job.logs || [];
        job.logs.push({
            timestamp: new Date().toISOString(),
            level,
            message,
        });
        // Keep last 100 logs per job
        if (job.logs.length > 100) job.logs = job.logs.slice(-100);
        saveToDisk();
    }
    // Also log to console
    const icon = level === 'error' ? '❌' : level === 'success' ? '✅' : 'ℹ️';
    console.log(`${icon} [${jobId}] ${message}`);
}

/**
 * Get all jobs.
 */
export function getJobs() {
    return jobs.map((j) => ({
        id: j.id,
        containerName: j.containerName,
        blobName: j.blobName,
        tableName: j.tableName,
        status: j.status,
        step: j.step,
        fileFormat: j.fileFormat,
        fileSize: j.fileSize,
        rowCount: j.rowCount,
        rowsInserted: j.rowsInserted,
        pipelineName: j.pipelineName,
        useAdf: j.useAdf,
        error: j.error,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
    }));
}

/**
 * Get a single job with full details.
 */
export function getJob(jobId) {
    return jobs.find((j) => j.id === jobId) || null;
}
