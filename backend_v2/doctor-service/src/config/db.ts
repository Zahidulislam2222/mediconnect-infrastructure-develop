import { Pool, PoolClient } from 'pg';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import dotenv from 'dotenv';

dotenv.config();

let pool: Pool | null = null;
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function getSSMParameter(name: string, withDecryption: boolean = false): Promise<string | undefined> {
    try {
        const command = new GetParameterCommand({
            Name: name,
            WithDecryption: withDecryption,
        });
        const response = await ssmClient.send(command);
        return response.Parameter?.Value;
    } catch (error) {
        console.error(`Failed to fetch SSM parameter ${name}:`, error);
        throw error;
    }
}

export async function initDb() {
    if (pool) return pool;

    try {
        const [host, password, user, poolId, clientId] = await Promise.all([
            getSSMParameter('/mediconnect/prod/gcp/sql/public_ip'),
            getSSMParameter('/mediconnect/prod/db/master_password', true),
            getSSMParameter('/mediconnect/prod/gcp/sql/db_user'),
            getSSMParameter('/mediconnect/prod/cognito/user_pool_id', true), // Add true here
            getSSMParameter('/mediconnect/prod/cognito/client_id', true)    // Add true here
        ]);

        // Inject them into the process so the middleware can see them
        process.env.COGNITO_USER_POOL_ID = poolId;
        process.env.COGNITO_CLIENT_ID = clientId;

        if (!host || !password || !user) {
            throw new Error('Failed to retrieve database credentials from SSM');
        }

        console.log(`Connecting to Postgres at ${host}...`);

        pool = new Pool({
            host: host,
            user: user,
            password: password,
            database: 'mediconnect', // Assuming DB name
            port: 5432,
            ssl: host === '127.0.0.1' ? false : { rejectUnauthorized: false }, // Disable SSL for local proxy
            connectionTimeoutMillis: 20000, // 20s timeout to allow wake-up
        });

        // Test connection
        const client = await getDbClient();
        client.release();
        console.log('Database initialized successfully.');

        return pool;
    } catch (error) {
        console.error('Failed to initialize database:', error);
        throw error;
    }
}

export async function getDbClient(): Promise<PoolClient> {
    if (!pool) {
        await initDb();
    }

    // Retry logic for wake-up (6 times, 10s delay)
    let retries = 6;
    while (retries > 0) {
        try {
            if (!pool) throw new Error('Pool not initialized');
            const client = await pool.connect();
            return client;
        } catch (error: any) {
            console.error(`Database connection failed. Retrying... (${retries} attempts left). Error: ${error.message}`);
            retries--;
            if (retries === 0) throw error;
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }

    throw new Error('Failed to connect to database after retries');
}

export const query = async (text: string, params?: any[]) => {
    const client = await getDbClient();
    try {
        return await client.query(text, params);
    } finally {
        client.release();
    }
};
