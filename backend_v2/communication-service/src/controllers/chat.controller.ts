import { Router, Request, Response } from "express";
import {
    ApiGatewayManagementApi,
    PostToConnectionCommand,
    GoneException
} from "@aws-sdk/client-apigatewaymanagementapi";
import { PutCommand, QueryCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../config/aws";
import { mapToFHIRCommunication, scrubPII } from "../utils/fhir-mapper";
import { writeAuditLog } from "../../../shared/audit";

const router = Router();

// =============================================================================
// 🗄️ DATABASE CONSTANTS
// =============================================================================
const DB_TABLES = {
    HISTORY: "mediconnect-chat-history",
    CONNECTIONS: "mediconnect-chat-connections",
    GRAPH: "mediconnect-graph-data",
    PATIENTS: "mediconnect-patients"
};

// =============================================================================
// 🔐 LOGIC HELPER: Deterministic Conversation ID
// =============================================================================
const generateConversationId = (userA: string, userB: string): string => {
    const sorted = [userA, userB].sort();
    return `CONV#${sorted[0]}#${sorted[1]}`;
};

/**
 * Normalizes WebSocket events from different AWS sources (HTTP API vs REST API vs Lambda)
 * 🟢 FIX: Now extracts 'userRole' so we can use it later
 */
const normalizeWsEvent = async (req: Request) => {
    // 🟢 Robust extraction from multiple sources
    const apiEvent = (req as any).apiGateway?.event || (req as any).event || req.body;
    const context = apiEvent?.requestContext;
    
    // 1. Prioritize Trusted AWS Context (WebSocket Handshakes)
    let userId = context?.authorizer?.sub || context?.authorizer?.principalId;
    let userRole = context?.authorizer?.role;

    // 2. Fallback to Middleware Identification (REST API tests)
    if (!userId && (req as any).user) {
        userId = (req as any).user.sub;
        userRole = (req as any).user.role;
    }

    // 3. Precise Route Detection
    const routeKey = apiEvent?.routeKey || context?.routeKey || req.query.routeKey || "$connect";
    const connectionId = context?.connectionId || req.query.connectionId;

    return {
        routeKey,
        connectionId,
        userId,
        userRole,
        // If routeKey is in the body, the data might be nested or direct
        body: apiEvent?.body ? (typeof apiEvent.body === 'string' ? JSON.parse(apiEvent.body) : apiEvent.body) : apiEvent,
        domainName: context?.domainName || req.headers.host,
        stage: context?.stage || process.env.STAGE || 'prod'
    };
};

// =============================================================================
// 🚀 REST API ROUTES (History & Context)
// =============================================================================

router.get("/history", async (req: Request, res: Response) => {
    try {
        const { recipientId } = req.query;
        const requesterId = (req as any).user?.sub;

        if (!requesterId || !recipientId) {
            return res.status(400).json({ error: "Missing recipientId or authentication." });
        }

        const conversationId = generateConversationId(requesterId, String(recipientId));
        const isDoctor = (req as any).user?.role === 'doctor';
        
        const pk = isDoctor ? `DOCTOR#${requesterId}` : `PATIENT#${requesterId}`;
        const sk = isDoctor ? `PATIENT#${recipientId}` : `DOCTOR#${recipientId}`;

        const relationship = await docClient.send(new GetCommand({
            TableName: DB_TABLES.GRAPH,
            Key: { PK: pk, SK: sk }
        }));

        if (!relationship.Item) {
            await writeAuditLog(requesterId, "SYSTEM", "UNAUTHORIZED_HISTORY_ACCESS", "No Care Network Link", { target: recipientId });
            return res.status(403).json({ error: "You are not authorized to view this conversation." });
        }

        const history = await docClient.send(new QueryCommand({
            TableName: DB_TABLES.HISTORY,
            KeyConditionExpression: "conversationId = :cid",
            ExpressionAttributeValues: { ":cid": conversationId },
            Limit: 50,
            ScanIndexForward: false
        }));

        await writeAuditLog(requesterId, String(recipientId), "READ_CHAT_HISTORY", "History accessed");

        res.json((history.Items || []).reverse());

    } catch (error: any) {
        console.error("History Error:", error.message);
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

// =============================================================================
// ⚡ WEBSOCKET EVENT HANDLER
// =============================================================================

router.post("/ws-event", async (req: Request, res: Response) => {
    try {
        const event = await normalizeWsEvent(req);

        if (!event.userId && event.routeKey !== "$disconnect") {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const result = await handleWebSocketEvent(event);
        res.status(result.statusCode).json(result.body);
    } catch (error: any) {
        console.error("WS Error:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export const handleWebSocketEvent = async (event: any) => {
    const { routeKey, connectionId, userId, userRole, domainName, stage, body } = event;
    
    // 🟢 FIX: Prioritize the Environment Variable for the AWS Gateway Endpoint.
    // This ensures REST calls target the AWS WebSocket Gateway, not the Azure container.
    const endpoint = process.env.AWS_WS_GATEWAY_ENDPOINT || `https://${domainName}/${stage}`;
    
    const apigw = new ApiGatewayManagementApi({ endpoint });

    switch (routeKey) {
        case "$connect":
    // 🟢 CRITICAL FIX: Prevent crash if testing via REST (No connectionId)
    if (!connectionId) {
        console.log("ℹ️ REST Request detected - Skipping WebSocket connection storage.");
        return { statusCode: 200, body: { message: "REST Bridge Active" } };
    }

            await writeAuditLog(userId, "SYSTEM", "WS_CONNECT", "Secure Session");
            await docClient.send(new PutCommand({
                TableName: DB_TABLES.CONNECTIONS,
                Item: { connectionId, userId, ttl: Math.floor(Date.now() / 1000) + 7200 }
            }));
            return { statusCode: 200, body: {} };

        case "sendMessage":
            // 🟢 PAYLOAD FIX: Ensure we get the right nesting
            const data = body.body || body; 
            const { recipientId, text } = data;

            if (!recipientId || !text) return { statusCode: 400, body: { error: "Missing data" } };

            const conversationId = generateConversationId(userId, recipientId);

            const relations = await Promise.all([
                docClient.send(new GetCommand({ 
                    TableName: DB_TABLES.GRAPH, 
                    Key: { PK: `PATIENT#${userId}`, SK: `DOCTOR#${recipientId}` } 
                })),
                docClient.send(new GetCommand({ 
                    TableName: DB_TABLES.GRAPH, 
                    Key: { PK: `DOCTOR#${userId}`, SK: `PATIENT#${recipientId}` } 
                })),
                docClient.send(new GetCommand({ 
                    TableName: DB_TABLES.GRAPH, 
                    Key: { PK: `PATIENT#${recipientId}`, SK: `DOCTOR#${userId}` } 
                })),
                docClient.send(new GetCommand({ 
                    TableName: DB_TABLES.GRAPH, 
                    Key: { PK: `DOCTOR#${recipientId}`, SK: `PATIENT#${userId}` } 
                }))
            ]);

            const hasRelationship = relations.some(r => !!r.Item);

            if (!hasRelationship) {
                await writeAuditLog(userId, "SYSTEM", "UNAUTHORIZED_MESSAGE_ATTEMPT", "Blocked: No Graph Link");
                return { statusCode: 403, body: { error: "Communication blocked: No established care relationship." } };
            }

            // 🟢 FIX: USE 'userRole' (String) INSTEAD OF 'req' OBJECT
            const senderType = userRole === 'doctor' ? "Practitioner" : "Patient";
            const recipientType = userRole === 'doctor' ? "Patient" : "Practitioner";

            const fhirResource = mapToFHIRCommunication(userId, senderType, recipientId, recipientType, text);
            
            const timestamp = new Date().toISOString();
            
            await docClient.send(new PutCommand({
                TableName: DB_TABLES.HISTORY,
                Item: { 
                    conversationId, 
                    timestamp, 
                    senderId: userId,
                    recipientId,
                    text: scrubPII(text), 
                    resource: fhirResource,
                    isRead: false
                }
            }));

            const connections = await docClient.send(new QueryCommand({
                TableName: DB_TABLES.CONNECTIONS,
                IndexName: "UserIdIndex",
                KeyConditionExpression: "userId = :uid",
                ExpressionAttributeValues: { ":uid": recipientId }
            }));

            const deliveryPromises = (connections.Items || []).map(async (conn) => {
                try {
                    await apigw.send(new PostToConnectionCommand({
                        ConnectionId: conn.connectionId,
                        Data: JSON.stringify({
                            type: "message",
                            senderId: userId,
                            text: scrubPII(text),
                            conversationId,
                            timestamp
                        })
                    }));
                } catch (e: any) {
                    if (e.name === 'GoneException' || e.statusCode === 410) {
                        await docClient.send(new DeleteCommand({
                            TableName: DB_TABLES.CONNECTIONS,
                            Key: { connectionId: conn.connectionId }
                        }));
                    }
                }
            });

            await Promise.all(deliveryPromises);

            return { statusCode: 200, body: { status: "Sent", conversationId } };

        case "$disconnect":
            await docClient.send(new DeleteCommand({ 
                TableName: DB_TABLES.CONNECTIONS, 
                Key: { connectionId } 
            }));
            return { statusCode: 200, body: {} };

        default:
            return { statusCode: 400, body: { error: "Unknown Route" } };
    }
};

export const chatController = router;