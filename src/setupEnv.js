import dotenv from 'dotenv';

// Load environment variables from .env file as early as possible.
// This module is imported at the top of server.js (and anywhere else) to
// ensure that process.env is populated before other modules read from it.

dotenv.config();
