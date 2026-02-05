import { query, initDb } from './config/db';

async function discover() {
    try {
        await initDb();
        console.log("--- DISCOVERING TABLE SCHEMA ---");

        const res = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'doctors';
        `);

        console.log("The columns in your 'doctors' table are:");
        res.rows.forEach(row => {
            console.log(`- ${row.column_name} (${row.data_type})`);
        });

        process.exit(0);
    } catch (error: any) {
        console.error("Discovery Failed:", error.message);
        process.exit(1);
    }
}

discover();