import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Create a connection pool (reusable connections)
export const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '5432'),
    ssl: { rejectUnauthorized: false } // Required for AWS/GCP DBs
});

// Export a helper function to run queries
export const query = (text: string, params?: any[]) => pool.query(text, params);