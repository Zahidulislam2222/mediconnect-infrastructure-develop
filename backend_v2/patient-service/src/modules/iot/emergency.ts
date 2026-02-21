import { Request, Response } from "express";
import { getRegionalClient, getRegionalSNSClient } from "../../config/aws"; 
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { PublishCommand } from "@aws-sdk/client-sns";
import { writeAuditLog } from "../../../../shared/audit";
import { v4 as uuidv4 } from "uuid";

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

        // 🟢 ARCHITECTURE FIX: Read env vars inside the function so loadSecrets() has time to populate them
        const TABLE_APPOINTMENTS = process.env.DYNAMO_TABLE_APPOINTMENTS || "mediconnect-appointments";
        const targetTopic = region.toUpperCase() === 'EU' ? process.env.SNS_TOPIC_ARN_EU : process.env.SNS_TOPIC_ARN_US;

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
                // FHIR Standard Embedded
                resource: { resourceType: "Appointment", id: appointmentId, status: "proposed", description: message },
                region
            }
        }));

        // 2. Dispatch AWS SNS (SMS/Email)
        if (targetTopic) {
            const regionalSNS = getRegionalSNSClient(region);
            await regionalSNS.send(new PublishCommand({
                TopicArn: targetTopic,
                Message: message,
                Subject: `MEDICONNECT EMERGENCY [${region.toUpperCase()}]`
            }));
        } else {
            console.warn(`⚠️ No SNS Topic configured for region: ${region}`);
        }
        
        // 🟢 HIPAA FIX: Immutable Audit Log for Emergency dispatch
        await writeAuditLog("SYSTEM_IOT", patientId, "EMERGENCY_DISPATCH", message, { region, heartRate });
        
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
        
        if (!user || (patientId !== user.id && user.role !== 'doctor')) {
            await writeAuditLog(user?.id || "UNKNOWN", patientId, "UNAUTHORIZED_EMERGENCY", "Unauthorized panic button trigger.", { ipAddress: req.ip });
            return res.status(403).json({ error: "Unauthorized" });
        }

        const result = await handleEmergencyDetection(patientId, Number(heartRate), type || 'MANUAL_OVERRIDE', user.region);
        
        // Audit manual trigger
        await writeAuditLog(user.id, patientId, "MANUAL_EMERGENCY", "Panic button pressed", { region: user.region, ipAddress: req.ip });

        return res.status(result.success ? 201 : 200).json(result);

    } catch (error: any) {
        res.status(500).json({ error: "Dispatch Failed", details: error.message });
    }
};