import { Request, Response } from "express";
import { getRegionalClient, getRegionalSNSClient } from "../../config/aws"; 
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { PublishCommand } from "@aws-sdk/client-sns";
import { v4 as uuidv4 } from "uuid";

const REGION = process.env.AWS_REGION || "us-east-1";

const TABLE_APPOINTMENTS = process.env.DYNAMO_TABLE_APPOINTMENTS || "mediconnect-appointments";
const SNS_TOPIC_ARN_US = process.env.SNS_TOPIC_ARN_US;
const SNS_TOPIC_ARN_EU = process.env.SNS_TOPIC_ARN_EU;

/**
 * 🟢 SHARED LOGIC: handleEmergencyDetection
 * Used by BOTH the HTTP API and the MQTT IoT Bridge.
 */
export const handleEmergencyDetection = async (patientId: string, heartRate: number, type: string, region: string = "us-east-1") => {
    // 🚨 THRESHOLD: 150 BPM for Automated, 100 BPM for Manual/General
    const isCritical = heartRate > 150 || type === 'MANUAL_OVERRIDE';
    
    if (isCritical) {
        const appointmentId = uuidv4();
        const now = new Date().toISOString();
        const message = type === 'MANUAL_OVERRIDE'
            ? `⚠️ MANUAL PANIC: Patient ${patientId} pressed the button.`
            : `🚨 CRITICAL AUTO-ALERT: Patient ${patientId} Heart Rate at ${heartRate} BPM! (Threshold 150)`;

        const dynamicDb = getRegionalClient(region);

        // 1. Create Emergency Record in DynamoDB
        await dynamicDb.send(new PutCommand({
            TableName: TABLE_APPOINTMENTS,
            Item: {
                appointmentId,
                patientId,
                doctorId: "ON-CALL-ER-DOC",
                status: "URGENT",
                type: type.startsWith('EMERGENCY') ? type : `EMERGENCY_IOT`,
                startTime: now,
                notes: message,
                createdAt: now,
                resource: { resourceType: "Appointment", id: appointmentId, status: "proposed", description: message },
                region
            }
        }));

        // 2. Dispatch AWS SNS (SMS/Email)
         const regionalSNS = getRegionalSNSClient(region);
        const targetTopic = region.toUpperCase() === 'EU' ? SNS_TOPIC_ARN_EU : SNS_TOPIC_ARN_US;

        if (targetTopic) {
            await regionalSNS.send(new PublishCommand({
                TopicArn: targetTopic,
                Message: message,
                Subject: `MEDICONNECT EMERGENCY [${region.toUpperCase()}]`
            }));
        } else {
            console.warn(`⚠️ No SNS Topic configured for region: ${region}`);
        }
        
        console.log(`[AUDIT] Emergency Processed for ${patientId} in ${region}`);
        return { success: true, appointmentId };
    }
    return { success: false, message: "Vitals within normal range." };
};

/**
 * Express Controller for manual triggers
 */
export const triggerEmergency = async (req: Request, res: Response) => {
    try {
        const { patientId, heartRate, type } = req.body;
        const user = (req as any).user;
        
        // Security Check
        if (patientId !== user.id && user.role !== 'doctor') {
            return res.status(403).json({ error: "Unauthorized" });
        }

        const result = await handleEmergencyDetection(patientId, Number(heartRate), type || 'MANUAL_OVERRIDE', user.region);
        return res.status(result.success ? 201 : 200).json(result);

    } catch (error: any) {
        res.status(500).json({ error: "Dispatch Failed", details: error.message });
    }
};