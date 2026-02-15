import { PubSub } from "@google-cloud/pubsub";

const GCP_TOPIC_NAME = "iot-health-sync";
let pubsub = null;

try {
    if (process.env.GCP_SA_KEY) {
        const credentials = JSON.parse(process.env.GCP_SA_KEY);
        // FIX: Read project_id directly from the key file
        pubsub = new PubSub({ projectId: credentials.project_id, credentials });
    }
} catch (e) { console.warn("GCP Init Failed", e); }

export const handler = async (event) => {
    console.log("Received:", JSON.stringify(event));

    if (pubsub) {
        try {
            // FIX: Ensure timestamp is a String for DynamoDB compatibility
            if (typeof event.timestamp === 'number') event.timestamp = event.timestamp.toString();

            const dataBuffer = Buffer.from(JSON.stringify(event));
            await pubsub.topic(GCP_TOPIC_NAME).publishMessage({ data: dataBuffer });
            console.log("✅ Synced to Google Pub/Sub");
            return { statusCode: 200, body: "Synced" };
        } catch (error) {
            console.error("GCP Error:", error);
            // Return 200 to stop IoT Core from retrying endlessly
            return { statusCode: 200, error: error.message };
        }
    } else {
        return { statusCode: 200, body: "Skipped (No Creds)" };
    }
};