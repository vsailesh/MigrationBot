import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './src/routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

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
    console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║   🤖 MigrationBot — Azure Data Factory Agent     ║
║                                                  ║
║   Dashboard: http://localhost:${PORT}               ║
║   API:       http://localhost:${PORT}/api/status    ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);
});
