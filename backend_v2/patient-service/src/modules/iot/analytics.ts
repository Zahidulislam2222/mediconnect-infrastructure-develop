import { BigQuery } from '@google-cloud/bigquery';
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSSMParameter } from "../../config/aws";

// Initialize S3 for DLQ
const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const DLQ_BUCKET = process.env.DLQ_BUCKET || "mediconnect-data-lake-dlq";

let bigquery: BigQuery;

async function getBigQueryClient() {
    if (!bigquery) {
        // Fetch credentials from SSM if not in Env
        const projectId = process.env.GCP_PROJECT_ID;
        const clientEmail = process.env.GCP_CLIENT_EMAIL;
        const privateKey = process.env.GCP_PRIVATE_KEY;

        bigquery = new BigQuery({
            projectId,
            credentials: {
                client_email: clientEmail,
                private_key: privateKey?.replace(/\\n/g, '\n'),
            }
        });
    }
    return bigquery;
}

const DATASET_ID = "mediconnect_analytics";
const TABLE_ID = "appointments_stream";

export const analyticsHandler = async (event: any) => {
    const rowsToInsert: any[] = [];

    // Parse DynamoDB Stream Records
    if (event.Records) {
        for (const record of event.Records) {
            // We only care about COMPLETED appointments or new inserts?
            // User requirement: "Whenever an appointment is marked 'COMPLETED', trigger"
            // So we check Modify events where status changed to COMPLETED.
            if (record.eventName === 'MODIFY' || record.eventName === 'INSERT') {
                const newImage = unmarshall(record.dynamodb.NewImage);
                const oldImage = record.dynamodb.OldImage ? unmarshall(record.dynamodb.OldImage) : {};

                if (newImage.status === 'COMPLETED' && oldImage.status !== 'COMPLETED') {
                    rowsToInsert.push({
                        appointment_id: newImage.appointmentId,
                        patient_id: newImage.patientId,
                        doctor_id: newImage.doctorId,
                        timestamp: new Date().toISOString(),
                        notes: newImage.notes,
                        cost: newImage.cost || 0
                    });
                }
            }
        }
    }

    if (rowsToInsert.length === 0) return { message: "No relevant events" };

    try {
        const bq = await getBigQueryClient();
        await bq.dataset(DATASET_ID).table(TABLE_ID).insert(rowsToInsert);
        return { message: `Synced ${rowsToInsert.length} rows to BigQuery` };

    } catch (error: any) {
        console.error("BigQuery Sync Failed. Sending to DLQ...", error);

        // Dead Letter Queue (S3)
        const dlqKey = `failed/${Date.now()}.json`;
        await s3Client.send(new PutObjectCommand({
            Bucket: DLQ_BUCKET,
            Key: dlqKey,
            Body: JSON.stringify({ error: error.message, rows: rowsToInsert }),
            ContentType: "application/json"
        }));

        return { message: "Failed sync saved to DLQ" };
    }
};
