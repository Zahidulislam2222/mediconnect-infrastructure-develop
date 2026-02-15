import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Singleton pool instance
export let pool: Pool | null = null;

export async function initDb() {
    if (pool) return pool;

    const host = process.env.DB_HOST;
    const user = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;
    const dbName = process.env.DB_NAME || 'mediconnect';

    if (!host || !user || !password) {
        console.error("❌ DB Config Missing. Ensure DB_HOST, DB_USER, DB_PASSWORD are set.");
        // We throw here because without DB, Patient-Doctor sync cannot work.
        throw new Error("Database configuration missing");
    }

    console.log(`🔌 Initializing Postgres Connection to: ${host}`);

    pool = new Pool({
        host,
        user,
        password,
        database: dbName,
        port: Number(process.env.DB_PORT) || 5432,
        // Cloud-to-Cloud (GCP/AWS) often requires SSL. 
        // rejectUnauthorized: false is standard for IP-based whitelist connections.
        ssl: host === '127.0.0.1' ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        max: 10
    });

    pool.on('error', (err) => {
        console.error('❌ Unexpected error on idle database client', err);
    });

    return pool;
}

export async function getDbClient(): Promise<PoolClient> {
    if (!pool) await initDb();
    
    let retries = 3;
    while (retries > 0) {
        try {
            return await pool!.connect();
        } catch (error: any) {
            console.warn(`⚠️ DB Retry... (${retries} left): ${error.message}`);
            retries--;
            if (retries === 0) throw error;
            await new Promise(res => setTimeout(res, 2000));
        }
    }
    throw new Error('DB Connection Failed');
}

export const query = async (text: string, params?: any[]) => {
    const client = await getDbClient();
    try {
        return await client.query(text, params);
    } finally {
        client.release();
    }
};