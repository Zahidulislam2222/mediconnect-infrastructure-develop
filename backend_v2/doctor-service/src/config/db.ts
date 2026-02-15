import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Singleton pool instance
export let pool: Pool | null = null;

export async function initDb() {
    if (pool) return pool;

    // 1. Validation: Ensure critical secrets exist before crashing the app
    const host = process.env.DB_HOST;
    const user = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;
    const dbName = process.env.DB_NAME || 'mediconnect';

    if (!host || !user || !password) {
        // Professional Logging: Critical Alert
        console.error("❌ CRITICAL: Database configuration missing. Check Azure Environment Variables.");
        throw new Error("Database configuration missing");
    }

    console.log(`🔌 Initializing Database Connection to: ${host} (User: ${user})`);

    // 2. Configure Pool with Production Settings
    pool = new Pool({
        host: host,
        user: user,
        password: password,
        database: dbName,
        port: 5432,
        // HIPAA/GDPR Requirement: Encryption in Transit
        ssl: host === '127.0.0.1' ? false : { rejectUnauthorized: false },
        // Connection Resilience Settings
        connectionTimeoutMillis: 5000, // Fail fast (5s) so probes detect issues
        idleTimeoutMillis: 30000,      // Close idle clients to save resources
        max: 20                        // Limit pool size to prevent exhausting DB connections
    });

    // 3. Pool Error Listener (Critical for stability)
    // If a client loses connection (Azure kills idle TCP), this prevents the app from hanging.
    pool.on('error', (err) => {
        console.error('❌ Unexpected error on idle database client', err);
        // Don't exit process here; PG pool handles reconnection for new clients
    });

    return pool;
}

export async function getDbClient(): Promise<PoolClient> {
    if (!pool) await initDb();

    // 4. Retry Logic (Resilience)
    // Azure cold starts can be slow. We retry connection 3 times.
    let retries = 3;
    while (retries > 0) {
        try {
            const client = await pool!.connect();
            return client;
        } catch (error: any) {
            console.warn(`⚠️ DB Connection Attempt Failed. Retrying... (${retries} attempts left). Error: ${error.message}`);
            retries--;
            if (retries === 0) {
                console.error("🔥 Fatal: Could not establish database connection after retries.");
                throw error;
            }
            // Wait 2 seconds before retry
            await new Promise(res => setTimeout(res, 2000));
        }
    }
    throw new Error('Database Connection Failed');
}

// Wrapper for simple queries
export const query = async (text: string, params?: any[]) => {
    const client = await getDbClient();
    try {
        return await client.query(text, params);
    } finally {
        client.release(); // Always release the client back to the pool
    }
};