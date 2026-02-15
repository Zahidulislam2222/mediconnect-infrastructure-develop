import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from 'uuid';
import { safeError, safeLog } from "./logger";

const REGION = process.env.AWS_REGION || "us-east-1";
const AUDIT_TABLE = process.env.AUDIT_TABLE || "mediconnect-audit-logs";

const dbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);

export interface AuditMetadata {
    [key: string]: any;
}

/**
 * writeAuditLog - Centralized HIPAA Audit Logging
 * 
 * @param actorId - The ID of the user performing the action (e.g. Doctor ID, Patient ID)
 * @param patientId - The ID of the patient whose record is being accessed/modified
 * @param action - The action being performed (e.g. READ_PROFILE, UPDATE_RX)
 * @param details - Human readable details
 * @param metadata - Optional JSON metadata (handled safely if empty)
 */
export const writeAuditLog = async (
    actorId: string,
    patientId: string,
    action: string,
    details: string,
    metadata?: AuditMetadata
) => {
    try {
        const safeMetadata = metadata || {};

        // Ensure metadata is a valid object and not null
        const cleanMetadata = (typeof safeMetadata === 'object' && safeMetadata !== null)
            ? safeMetadata
            : { raw: String(safeMetadata) };

        const item = {
            logId: uuidv4(),
            timestamp: new Date().toISOString(),
            actorId: actorId || "SYSTEM",
            patientId: patientId || "UNKNOWN",
            action,
            details,
            metadata: cleanMetadata,
            source: "backend-v2"
        };

        await docClient.send(new PutCommand({
            TableName: AUDIT_TABLE,
            Item: item
        }));

    } catch (error: any) {
        // Fallback: Log to CloudWatch if DynamoDB fails (Critical for Audit)
        safeError("AUDIT_WRITE_FAILED", { error: error.message, actorId, action });
    }
};
