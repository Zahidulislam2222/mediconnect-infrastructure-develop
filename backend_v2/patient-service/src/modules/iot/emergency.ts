import { Request, Response } from "express";
import { docClient } from "../../config/aws";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { v4 as uuidv4 } from "uuid";

// 🟢 CONFIG: Load Region from Env
const REGION = process.env.AWS_REGION || "us-east-1";
const snsClient = new SNSClient({ region: REGION });

const TABLE_APPOINTMENTS = process.env.DYNAMO_TABLE_APPOINTMENTS || "mediconnect-appointments";
// 🟢 SECURITY: Remove Hardcoded Account ID
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;

export const triggerEmergency = async (req: Request, res: Response) => {
    try {
        const { patientId, heartRate, type } = req.body;
        const requesterId = (req as any).user?.id;
        const requesterRole = (req as any).user?.role; // 🟢 Get role from token

        // 🟢 SECURITY: IDOR PROTECTION (Expanded for Medical Staff)
        // Allow if: 1. Patient is saving themselves OR 2. A Doctor/Provider is saving a patient
        const isAuthorized = (patientId === requesterId) || (requesterRole === 'doctor' || requesterRole === 'provider');

        if (!patientId || !isAuthorized) {
            console.warn(`[SECURITY] Blocked: ${requesterId} (${requesterRole}) tried to trigger emergency for ${patientId}`);
            return res.status(403).json({ error: "Unauthorized: You do not have permission to trigger an alert for this patient." });
        }

        if (!SNS_TOPIC_ARN) {
            console.error("CRITICAL: SNS_TOPIC_ARN not set in environment");
            return res.status(500).json({ error: "System Configuration Error" });
        }

        // Logic: Trigger if Heart Rate > 100 OR Manual Override
        if (Number(heartRate) > 100 || type === 'MANUAL_OVERRIDE') {
            const appointmentId = uuidv4();
            const now = new Date().toISOString();

            const message = type === 'MANUAL_OVERRIDE'
                ? `⚠️ MANUAL PANIC BUTTON PRESSED by Patient ${patientId}`
                : `CRITICAL ALERT: Patient ${patientId} Heart Rate ${heartRate} bpm.`;

            // 1. Create Emergency Appointment (Distributed Monolith Pattern - Direct Write)
            // Note: Ideally this should call Booking Service, but for Zero-Cost/Hotfix we write direct.
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
                    createdAt: now,
                    updatedAt: now,
                    paymentStatus: "WAIVED" // Emergency is free/billed later
                }
            }));

            // 2. Dispatch SNS Alert
            await snsClient.send(new PublishCommand({
                TopicArn: SNS_TOPIC_ARN,
                Message: message,
                Subject: `MEDICONNECT EMERGENCY: ${patientId}`
            }));

            // 🟢 AUDIT: Log this critical event
            console.log(`[AUDIT] Emergency triggered for ${patientId} (Type: ${type})`);

            return res.status(201).json({
                success: true,
                appointmentId,
                message: "Emergency services dispatched. Support team notified."
            });
        }

        res.json({ message: "Vitals normal. No emergency triggered." });

    } catch (error: any) {
        console.error("🚨 Emergency Handler Error:", error.message);
        res.status(500).json({ error: "Emergency Dispatch Failed", details: error.message });
    }
};