import { docClient, ssmClient } from "../config/aws";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import AWSXRay from "aws-xray-sdk-core";
import { v4 as uuidv4 } from "uuid";

// Wrap SNS for X-Ray
const snsRaw = new SNSClient({ region: process.env.AWS_REGION || "us-east-1" });
const snsClient = AWSXRay.captureAWSv3Client(snsRaw);

const TABLE_APPOINTMENTS = "mediconnect-appointments";
// Note: SNS Topic ARN should come from SSM/Env
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN || "arn:aws:sns:us-east-1:950110266426:mediconnect-ops-alerts";

export const emergencyHandler = async (body: any) => {
    const { patientId, heartRate, type } = body;

    if (heartRate > 100 || type === 'MANUAL_OVERRIDE') {
        const appointmentId = uuidv4();
        const now = new Date().toISOString();
        const message = type === 'MANUAL_OVERRIDE'
            ? `⚠️ MANUAL PANIC BUTTON PRESSED by Patient ${patientId}`
            : `CRITICAL ALERT: Patient ${patientId} Heart Rate ${heartRate} bpm.`;

        // 1. Create Emergency Appointment (DynamoDB)
        // X-Ray will trace this call via docClient (already wrapped in config)
        await docClient.send(new PutCommand({
            TableName: TABLE_APPOINTMENTS,
            Item: {
                appointmentId,
                patientId,
                doctorId: "ON-CALL-ER-DOC",
                status: "URGENT",
                type: type === 'MANUAL_OVERRIDE' ? "EMERGENCY_MANUAL" : "EMERGENCY_AUTOMATED",
                startTime: now,
                notes: message,
                createdAt: now
            }
        }));

        // 2. Dispatch SNS Alert
        await snsClient.send(new PublishCommand({
            TopicArn: SNS_TOPIC_ARN,
            Message: message,
            Subject: "MEDICONNECT EMERGENCY ALERT"
        }));

        return { message: "Emergency Dispatched", appointmentId };
    }

    return { message: "Vitals Normal" };
};
