import { Request, Response } from "express";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { safeLog, safeError } from '../../../../shared/logger';

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const docClient = DynamoDBDocumentClient.from(dbClient);

const TABLE_GRAPH = "mediconnect-graph-data";
const AUDIT_TABLE = "mediconnect-audit-logs"; // 🟢 HIPAA Requirement

/**
 * 🟢 HIPAA: Centralized Audit Logging
 */
const writeAuditLog = async (actorId: string, patientId: string, action: string, details: string) => {
    try {
        await docClient.send(new PutCommand({
            TableName: AUDIT_TABLE,
            Item: {
                logId: uuidv4(),
                timestamp: new Date().toISOString(),
                actorId,
                patientId,
                action,
                details,
                metadata: { platform: "MediConnect-v2", module: "Relationship-Graph" }
            }
        }));
    } catch (e) { safeError("Audit Log Failed in Relationships", e); }
};

export const getRelationships = async (req: Request, res: Response) => {
    try {
        const authUser = (req as any).user;
        let { entityId } = req.query as { entityId: string };

        if (!entityId) return res.status(400).json({ error: "Missing entityId" });

        // 🟢 FIX: If the frontend sends just "PATIENT", rewrite it to the user's real ID
        // This stops the 403 error and ensures they only see their own data.
        if (entityId === "PATIENT") {
            entityId = `PATIENT#${authUser.sub}`;
        }

        const isDoctor = authUser['cognito:groups']?.some((g: string) => g.toLowerCase() === 'doctor');

        // 🟢 Security Check: Is the user a Doctor? OR are they asking for their own record?
        const isSearchingOwnSelf = entityId === `PATIENT#${authUser.sub}`;

        if (!isDoctor && !isSearchingOwnSelf) {
            safeError(`[SECURITY] Access Denied for ${authUser.sub} requesting ${entityId}`);
            return res.status(403).json({ error: "Access Denied" });
        }

        const command = new QueryCommand({
            TableName: TABLE_GRAPH,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": entityId }
        });

        const response = await docClient.send(command);

        // HIPAA Audit Log
        const logPatientId = entityId.includes('#') ? entityId.split('#')[1] : entityId;
        await writeAuditLog(authUser.sub, logPatientId, "ACCESS_GRAPH", `Viewed ${response.Items?.length} connections`);

        res.json({
            connections: response.Items || [],
            timestamp: new Date().toISOString()
        });

    } catch (error: any) {
        safeError("Relationship Graph Error:", error);
        res.status(500).json({ error: "Failed to load care network" });
    }
};