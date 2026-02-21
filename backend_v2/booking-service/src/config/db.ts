import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '5432'),
    ssl: { rejectUnauthorized: false },
    max: 1, // 🟢 ADDED (Prevents 10k user crash)
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 5000 // 🟢 ADDED Comma here
});

export const query = (text: string, params?: any[]) => pool.query(text, params);