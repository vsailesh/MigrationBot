import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = path.join(__dirname, '../../.cache');
const TOKEN_FILE = path.join(CACHE_DIR, '.auth-tokens.json');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export class TokenCache {
    static saveToken(service, token) {
        try {
            let cache = this.loadCache();
            cache[service] = {
                token,
                timestamp: Date.now(),
                expiresAt: token.expiresOn ? new Date(token.expiresOn).getTime() : Date.now() + (3600 * 1000) // Default 1 hour
            };
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 }); // Readable only by owner
            console.log(`✅ Token cached for ${service}`);
            return true;
        } catch (err) {
            console.error(`❌ Failed to save token cache for ${service}:`, err.message);
            return false;
        }
    }

    static loadToken(service) {
        try {
            const cache = this.loadCache();
            const entry = cache[service];
            
            if (!entry) {
                return null;
            }

            // Check if token is still valid (refresh 5 min before expiry)
            const now = Date.now();
            const expiryBuffer = 5 * 60 * 1000; // 5 minutes
            
            if (now > entry.expiresAt - expiryBuffer) {
                console.log(`⚠️  Token for ${service} expired or expiring soon`);
                return null;
            }

            console.log(`✅ Loaded cached token for ${service}`);
            return entry.token;
        } catch (err) {
            console.error(`⚠️  Failed to load token for ${service}:`, err.message);
            return null;
        }
    }

    static loadCache() {
        try {
            if (!fs.existsSync(TOKEN_FILE)) {
                return {};
            }
            return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        } catch (err) {
            console.warn('⚠️  Failed to load token cache:', err.message);
            return {};
        }
    }

    static clearToken(service) {
        try {
            let cache = this.loadCache();
            delete cache[service];
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
            console.log(`✅ Cleared cached token for ${service}`);
            return true;
        } catch (err) {
            console.error(`❌ Failed to clear token for ${service}:`, err.message);
            return false;
        }
    }

    static clearAll() {
        try {
            if (fs.existsSync(TOKEN_FILE)) {
                fs.unlinkSync(TOKEN_FILE);
            }
            console.log(`✅ Cleared all cached tokens`);
            return true;
        } catch (err) {
            console.error(`❌ Failed to clear all tokens:`, err.message);
            return false;
        }
    }

    static getAllTokens() {
        return this.loadCache();
    }
}


