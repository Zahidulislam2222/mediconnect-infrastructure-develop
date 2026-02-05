import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { randomUUID } from "crypto";
import AWSXRay from "aws-xray-sdk-core"; // 🟢 1. Import X-Ray

// 🟢 2. Capture (Wrap) the Clients for X-Ray
const ddbRaw = new DynamoDBClient({});
const ddbWrapped = AWSXRay.captureAWSv3Client(ddbRaw);
const docClient = DynamoDBDocumentClient.from(ddbWrapped);

const snsRaw = new SNSClient({});
const snsClient = AWSXRay.captureAWSv3Client(snsRaw); // 🟢 3. Wrap SNS too

const SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:950110266426:mediconnect-ops-alerts"; // ⚠️ REPLACE WITH YOUR TOPIC ARN

export const handler = async (event) => {
    console.log("EVENT RECEIVED:", JSON.stringify(event));

    // 1. DETERMINE SOURCE
    let payload = event;
    let isApiCall = false;

    if (event.body) {
        try {
            payload = JSON.parse(event.body);
            isApiCall = true;
        } catch (e) {
            console.error("JSON Parse Error", e);
        }
    }

    // 2. EXTRACT DATA
    const heartRate = payload.heartRate || 999; 
    const patientId = payload.patientId || "unknown";
    const isManual = payload.type === 'MANUAL_OVERRIDE';

    // 3. LOGIC: Trigger if High Heart Rate OR Manual Button Press
    if (heartRate > 100 || isManual) {
        const appointmentId = randomUUID();
        const now = new Date().toISOString();
        const message = isManual 
            ? `⚠️ MANUAL PANIC BUTTON PRESSED by Patient ${patientId}. Dispatch Immediately.` 
            : `CRITICAL ALERT: Patient ${patientId} Heart Rate ${heartRate} bpm.`;

        // A. Save to DynamoDB (X-Ray will see this now)
        const params = {
            TableName: "mediconnect-appointments",
            Item: {
                appointmentId: appointmentId,
                patientId: patientId,
                doctorId: "ON-CALL-ER-DOC",
                status: "URGENT",
                type: isManual ? "EMERGENCY_MANUAL" : "EMERGENCY_AUTOMATED",
                startTime: now,
                notes: message,
                createdAt: now
            }
        };

        try {
            // Write to DB
            await docClient.send(new PutCommand(params));
            console.log("✅ Emergency Appointment Booked");

            // 🟢 B. Send SNS Email via Lambda (So X-Ray shows the line)
            // (Make sure to replace SNS_TOPIC_ARN at the top)
            try {
                await snsClient.send(new PublishCommand({
                    TopicArn: SNS_TOPIC_ARN,
                    Message: message,
                    Subject: "MEDICONNECT EMERGENCY ALERT"
                }));
                console.log("✅ SNS Alert Sent");
            } catch (snsError) {
                console.error("⚠️ SNS Fail:", snsError); // Don't crash if SNS fails
            }
            
            // Return Response
            const responseBody = { message: "Emergency Dispatched", id: appointmentId };
            
            if (isApiCall) {
                return {
                    statusCode: 200,
                    headers: { "Access-Control-Allow-Origin": "*" },
                    body: JSON.stringify(responseBody)
                };
            } else {
                return responseBody;
            }

        } catch (err) {
            console.error("❌ Process Failed:", err);
            if (isApiCall) {
                 return { statusCode: 500, body: JSON.stringify({ error: "Failed" }) };
            }
            throw err;
        }
    }
    
    if (isApiCall) {
        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ message: "Vitals Normal." })
        };
    }
};