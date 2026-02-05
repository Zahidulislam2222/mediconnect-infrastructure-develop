import { BigQuery } from '@google-cloud/bigquery';
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"; // NEW

// 1. Setup Clients
const s3 = new S3Client({ region: "us-east-1" });
const bigquery = new BigQuery({
    projectId: process.env.GCP_PROJECT_ID,
    credentials: {
        client_email: process.env.GCP_CLIENT_EMAIL,
        private_key: process.env.GCP_PRIVATE_KEY ? process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n') : "",
    },
});

const DATASET_ID = process.env.GCP_DATASET_ID;
const TABLE_ID = process.env.GCP_TABLE_ID;
// Define a bucket for failed events (You can reuse your existing logging bucket)
const DLQ_BUCKET = "mediconnect-datalake-950110266426";

export const handler = async (event) => {
    let rowsToInsert = [];
    try {
        // 2. Loop through DynamoDB Stream Records
        for (const record of event.Records) {
            if (record.eventName === 'INSERT') {
                const item = unmarshall(record.dynamodb.NewImage);
                rowsToInsert.push(item);
            }
        }

        if (rowsToInsert.length > 0) {
            // 3. Try Sending to Google BigQuery
            await bigquery
                .dataset(DATASET_ID)
                .table(TABLE_ID)
                .insert(rowsToInsert);

            console.log(`✅ Success: Inserted ${rowsToInsert.length} rows into BigQuery`);
        }

        return { statusCode: 200, body: "Analytics Synced" };

    } catch (error) {
        console.error("❌ CRITICAL: BigQuery Failed. Engaging Dead Letter Mechanism.", error);

        // 4. DEAD LETTER LOGIC (Stop Faking Reliability)
        // If Google fails, we MUST save this data to S3 so we don't lose it.
        if (rowsToInsert.length > 0) {
            const dlqKey = `failed-inserts/${new Date().toISOString()}-${Math.random().toString(36).substr(2, 5)}.json`;

            try {
                await s3.send(new PutObjectCommand({
                    Bucket: DLQ_BUCKET,
                    Key: dlqKey,
                    Body: JSON.stringify({ error: error.message, data: rowsToInsert }),
                    ContentType: "application/json"
                }));
                console.log(`⚠️ Data saved to S3 DLQ: ${dlqKey}`);
            } catch (s3Error) {
                console.error("💀 CATASTROPHIC FAILURE: Could not save to DLQ.", s3Error);
                // In a real enterprise, this triggers a PagerDuty alert immediately
            }
        }

        // We return 200 to DynamoDB so it thinks we succeeded (because we saved to S3).
        // If we return 500, DynamoDB will retry and block the shard.
        return { statusCode: 200, body: "Saved to DLQ" };
    }
};