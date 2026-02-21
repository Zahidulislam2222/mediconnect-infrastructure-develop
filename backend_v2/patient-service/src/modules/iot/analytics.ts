import { BigQuery } from '@google-cloud/bigquery';
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
// 🟢 FIX: Use Shared Regional S3 Factory to prevent GDPR leaks
import { getRegionalS3Client } from "../../config/aws";

let bigquery: BigQuery;

async function getBigQueryClient() {
    if (!bigquery) {
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

export const analyticsHandler = async (event: any, region: string = "us-east-1") => {
    const rowsToInsert: any[] = [];
    
    // 🟢 GDPR COMPLIANT DATASET ROUTING
    const DATASET_ID = region.toUpperCase() === 'EU' ? "mediconnect_analytics_eu" : "mediconnect_analytics";
    const TABLE_ID = "appointments_stream";

    if (event.Records) {
        for (const record of event.Records) {
            if (record.eventName === 'MODIFY' || record.eventName === 'INSERT') {
                const newImage = unmarshall(record.dynamodb.NewImage as any);
                const oldImage = record.dynamodb.OldImage ? unmarshall(record.dynamodb.OldImage as any) : {};

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
        return { message: `Synced ${rowsToInsert.length} rows to BigQuery [${DATASET_ID}]` };

    } catch (error: any) {
        console.error("BigQuery Sync Failed. Sending to DLQ...", error);

        // 🟢 GDPR FIX: Ensure Dead Letter Queue writes to the correct Legal Jurisdiction
        const regionalS3 = getRegionalS3Client(region);
        const DLQ_BUCKET = process.env.DLQ_BUCKET || "mediconnect-data-lake-dlq";
        const targetBucket = region.toUpperCase() === 'EU' ? `${DLQ_BUCKET}-eu` : DLQ_BUCKET;
        const dlqKey = `failed/${Date.now()}.json`;

        await regionalS3.send(new PutObjectCommand({
            Bucket: targetBucket,
            Key: dlqKey,
            Body: JSON.stringify({ error: error.message, rows: rowsToInsert }),
            ContentType: "application/json"
        }));

        return { message: `Failed sync saved to Regional DLQ: ${targetBucket}` };
    }
};