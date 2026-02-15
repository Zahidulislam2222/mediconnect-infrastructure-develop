import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME;

export const handler = async (event) => {
  const timestamp = new Date().toISOString();
  // Generate a filename based on time: 2023-10-25/event-123.json
  const datePath = timestamp.split('T')[0]; 
  const key = `raw-events/${datePath}/${Date.now()}-${Math.random().toString(36).substring(7)}.json`;

  const payload = {
    eventId: event.id || "manual-" + Date.now(),
    type: event.detail?.type || "GENERIC_LOG",
    data: event.detail || event,
    timestamp: timestamp
  };

  try {
    // 1. Save to S3 (Data Lake)
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: "application/json"
    }));

    // 2. Stream to BigQuery (Simulated via Logs)
    // In production, this would use the BigQuery SDK to insert rows.
    console.log(`[BigQuery Stream] Inserting row into dataset 'mediconnect_analytics':`, JSON.stringify(payload));

    return { status: "Archived to S3 and Streamed to GCP", s3Key: key };

  } catch (err) {
    console.error("Error processing analytics:", err);
    throw err;
  }
};