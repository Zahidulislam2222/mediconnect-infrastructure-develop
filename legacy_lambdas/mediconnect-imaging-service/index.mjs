import { Storage } from "@google-cloud/storage";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"; 
import { MongoClient } from "mongodb"; 
import { v4 as uuidv4 } from "uuid";

// --- 1. Initialize Clients ---
const s3Client = new S3Client({ region: "us-east-1" });
const bedrockClient = new BedrockRuntimeClient({ region: "us-east-1" });

// Google Clients
let gcpStorage = null;
let vision = null;
const GCP_BUCKET_NAME = "mediconnect-medical-images";

try {
    if (process.env.GCP_SA_KEY) {
        const credentials = JSON.parse(process.env.GCP_SA_KEY);
        gcpStorage = new Storage({ projectId: credentials.project_id, credentials });
        vision = new ImageAnnotatorClient({ projectId: credentials.project_id, credentials });
    }
} catch (e) { console.warn("GCP Init Failed:", e); }

// Database Config (MongoDB)
const MONGO_URI = process.env.MONGO_URI; 
const DB_NAME = "mediconnect";
const COLLECTION_NAME = "imaging_reports";

// Model Config
const BEDROCK_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0";

// --- 🔒 CORS HEADERS (ADDED) ---
const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST"
};

export const handler = async (event) => {
    let client;
    try {
        let imageBuffer;
        let patientId = "unknown";
        let sourceKey = "direct-upload";

        // --- STEP 1: Determine Input Source (S3 Trigger vs. Direct Test) ---
        if (event.Records && event.Records[0].eventSource === 'aws:s3') {
            // Case A: Triggered by S3 Upload (Real World)
            const bucket = event.Records[0].s3.bucket.name;
            const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
            sourceKey = key;

            // Download image from S3
            const s3Response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const byteArray = await s3Response.Body.transformToByteArray();
            imageBuffer = Buffer.from(byteArray);

            // Try to extract patientID from filename (e.g., "patient-123/image.jpg")
            const parts = key.split('/');
            if (parts.length > 1) patientId = parts[0];

        } else if (event.body) {
            // Case B: Triggered by API/Test Event (Direct Base64)
            const body = JSON.parse(event.body);
            if (!body.imageBase64) throw new Error("No image data found");
            imageBuffer = Buffer.from(body.imageBase64, 'base64');
            patientId = body.patientId || "manual-test";
        } else {
            // Fallback for simple JSON event
            if (!event.imageBase64) throw new Error("Invalid Event Structure");
            imageBuffer = Buffer.from(event.imageBase64, 'base64');
            patientId = event.patientId || "manual-test";
        }

        // --- STEP 2: Google Vision (Validation - Replaces Rekognition) ---
        let visionLabels = [];
        if (vision) {
            const [result] = await vision.labelDetection({ image: { content: imageBuffer } });
            visionLabels = result.labelAnnotations ? result.labelAnnotations.map(l => l.description) : [];
        }

        // --- STEP 3: AWS Bedrock (Diagnosis) ---
        let medicalAnalysis = "Analysis Failed";
        try {
            const prompt = "Analyze this medical image. Identify the body part, check for fractures or abnormalities. Provide a risk assessment.";
            const command = new InvokeModelCommand({
                modelId: BEDROCK_MODEL_ID,
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify({
                    anthropic_version: "bedrock-2023-05-31",
                    max_tokens: 300,
                    messages: [{
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBuffer.toString('base64') } }
                        ]
                    }]
                })
            });
            const response = await bedrockClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            medicalAnalysis = responseBody.content[0].text;
        } catch (err) {
            console.error("Bedrock Error:", err);
            medicalAnalysis = "AI Error: " + err.message;
        }

        // --- STEP 4: Save to Google Cloud Storage (Backup) ---
        let gcpPath = "Skipped";
        if (gcpStorage) {
            const fileName = `${patientId}/${uuidv4()}.jpg`;
            const bucket = gcpStorage.bucket(GCP_BUCKET_NAME);
            await bucket.file(fileName).save(imageBuffer);
            gcpPath = `gs://${GCP_BUCKET_NAME}/${fileName}`;
        }

        // --- STEP 5: Save Report to MongoDB (Database) ---
        const report = {
            patientId,
            timestamp: new Date(),
            s3Source: sourceKey,
            gcpBackup: gcpPath,
            visionTags: visionLabels,
            diagnosis: medicalAnalysis
        };

        if (MONGO_URI) {
            client = new MongoClient(MONGO_URI);
            await client.connect();
            const db = client.db(DB_NAME);
            await db.collection(COLLECTION_NAME).insertOne(report);
            console.log("Report saved to MongoDB");
        } else {
            console.warn("MONGO_URI not set. Report NOT saved to DB.");
        }

        // --- SUCCESS RETURN WITH CORS ---
        return {
            statusCode: 200,
            headers: headers, // <--- ADDED
            body: JSON.stringify({ message: "Success", report })
        };

    } catch (error) {
        console.error("Handler Error:", error);
        // --- ERROR RETURN WITH CORS ---
        return { 
            statusCode: 500, 
            headers: headers, // <--- ADDED
            body: JSON.stringify({ error: error.message }) 
        };
    } finally {
        if (client) await client.close();
    }
};