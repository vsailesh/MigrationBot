// load environment variables as early as possible
import './src/setupEnv.js';

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './src/routes/api.js';
import dataCleaner from './src/dataCleaner.js';

// make sure metadata table is created before we do anything else
await dataCleaner.ensureMetadataTable().catch(err => {
    console.warn('startup: metadata table check failed', err.message);
});

console.log('AZURE_ADF_RESOURCE_GROUP:', process.env.AZURE_ADF_RESOURCE_GROUP);
console.log('AZURE_RESOURCE_GROUP:', process.env.AZURE_RESOURCE_GROUP);
console.log('Data Cleaning Service initialized');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// global error logging to catch crashes
process.on('uncaughtException', err => {
    console.error('uncaughtException:', err);
});
process.on('unhandledRejection', err => {
    console.error('unhandledRejection:', err);
});

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, 'frontend')));

// API routes
app.use('/api', apiRoutes);

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(PORT, () => {
    // Start data cleaning monitoring if enabled
    if (process.env.ENABLE_CLEANING_MONITORING === 'true') {
        dataCleaner.startMonitoring();
        console.log('📊 Data cleaning monitoring enabled');
    }

    console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║   🤖 MigrationBot — Azure Data Factory Agent     ║
║                                                  ║
║   Dashboard: http://localhost:${PORT}               ║
║   API:       http://localhost:${PORT}/api/status    ║
║   Cleaning:  http://localhost:${PORT}/api/cleaning/status ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);
});
