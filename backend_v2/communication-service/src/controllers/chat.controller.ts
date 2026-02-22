import { Router, Request, Response } from "express";
import {
    ApiGatewayManagementApi,
    PostToConnectionCommand
} from "@aws-sdk/client-apigatewaymanagementapi";
import { PutCommand, QueryCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { getRegionalClient } from "../config/aws";
import { mapToFHIRCommunication, scrubPII } from "../utils/fhir-mapper";
import { writeAuditLog } from "../../../shared/audit";

const router = Router();

const DB_TABLES = {
    HISTORY: "mediconnect-chat-history",
    CONNECTIONS: "mediconnect-chat-connections",
    GRAPH: "mediconnect-graph-data"
};

const generateConversationId = (userA: string, userB: string): string => {
    const sorted = [userA, userB].sort();
    return `CONV#${sorted[0]}#${sorted[1]}`;
};

// 🟢 GDPR FIX: Extract region from headers or WebSocket payload
export const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

const normalizeWsEvent = async (req: Request) => {
    const apiEvent = (req as any).apiGateway?.event || (req as any).event || req.body;
    const context = apiEvent?.requestContext;
    
    let userId = context?.authorizer?.sub || context?.authorizer?.principalId;
    let userRole = context?.authorizer?.role;

    if (!userId && (req as any).user) {
        userId = (req as any).user.sub;
        userRole = (req as any).user.role;
    }

    const routeKey = apiEvent?.routeKey || context?.routeKey || req.query.routeKey || "$connect";
    const connectionId = context?.connectionId || req.query.connectionId;
    
    const body = apiEvent?.body ? (typeof apiEvent.body === 'string' ? JSON.parse(apiEvent.body) : apiEvent.body) : apiEvent;
    
    // Fallback region extraction for WebSocket events that might not have standard headers
    const region = (req.headers && req.headers['x-user-region']) || body?.region || "us-east-1";

    return {
        routeKey, connectionId, userId, userRole, body, region,
        domainName: context?.domainName || req.headers.host,
        stage: context?.stage || process.env.STAGE || 'prod'
    };
};

router.get("/history", async (req: Request, res: Response) => {
    try {
        const region = extractRegion(req);
        const regionalDb = getRegionalClient(region);
        
        const { recipientId } = req.query;
        const requesterId = (req as any).user?.sub;

        if (!requesterId || !recipientId) return res.status(400).json({ error: "Missing recipientId or authentication." });

        const conversationId = generateConversationId(requesterId, String(recipientId));
        const isDoctor = (req as any).user?.role === 'doctor';
        
        const pk = isDoctor ? `DOCTOR#${requesterId}` : `PATIENT#${requesterId}`;
        const sk = isDoctor ? `PATIENT#${recipientId}` : `DOCTOR#${recipientId}`;

        const relationship = await regionalDb.send(new GetCommand({
            TableName: DB_TABLES.GRAPH,
            Key: { PK: pk, SK: sk }
        }));

        if (!relationship.Item) {
            await writeAuditLog(requesterId, "SYSTEM", "UNAUTHORIZED_HISTORY_ACCESS", "No Care Network Link", { target: recipientId, region, ipAddress: req.ip });
            return res.status(403).json({ error: "Unauthorized to view this conversation." });
        }

        const history = await regionalDb.send(new QueryCommand({
            TableName: DB_TABLES.HISTORY,
            KeyConditionExpression: "conversationId = :cid",
            ExpressionAttributeValues: { ":cid": conversationId },
            Limit: 50,
            ScanIndexForward: false
        }));

        await writeAuditLog(requesterId, String(recipientId), "READ_CHAT_HISTORY", "History accessed", { region, ipAddress: req.ip });

        res.json((history.Items || []).reverse());

    } catch (error: any) {
        console.error("History Error:", error.message);
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

router.post("/ws-event", async (req: Request, res: Response) => {
    try {
        const event = await normalizeWsEvent(req);
        if (!event.userId && event.routeKey !== "$disconnect") return res.status(401).json({ message: "Unauthorized" });

        const result = await handleWebSocketEvent(event);
        res.status(result.statusCode).json(result.body);
    } catch (error: any) {
        console.error("WS Error:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export const handleWebSocketEvent = async (event: any) => {
    const { routeKey, connectionId, userId, userRole, domainName, stage, body, region } = event;
    const regionalDb = getRegionalClient(region);
    
    // 🟢 Target correct regional AWS API Gateway Endpoint
    const awsRegionTarget = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    const endpoint = process.env.AWS_WS_GATEWAY_ENDPOINT || `https://${domainName}/${stage}`;
    const apigw = new ApiGatewayManagementApi({ endpoint, region: awsRegionTarget });

    switch (routeKey) {
        case "$connect":
            if (!connectionId) return { statusCode: 200, body: { message: "REST Bridge Active" } };

            await writeAuditLog(userId, "SYSTEM", "WS_CONNECT", "Secure Session", { region });
            await regionalDb.send(new PutCommand({
                TableName: DB_TABLES.CONNECTIONS,
                Item: { connectionId, userId, ttl: Math.floor(Date.now() / 1000) + 7200 }
            }));
            return { statusCode: 200, body: {} };

        case "sendMessage":
            const data = body.body || body; 
            const { recipientId, text } = data;

            if (!recipientId || !text) return { statusCode: 400, body: { error: "Missing data" } };

            const conversationId = generateConversationId(userId, recipientId);

            const relations = await Promise.all([
                regionalDb.send(new GetCommand({ TableName: DB_TABLES.GRAPH, Key: { PK: `PATIENT#${userId}`, SK: `DOCTOR#${recipientId}` } })),
                regionalDb.send(new GetCommand({ TableName: DB_TABLES.GRAPH, Key: { PK: `DOCTOR#${userId}`, SK: `PATIENT#${recipientId}` } })),
                regionalDb.send(new GetCommand({ TableName: DB_TABLES.GRAPH, Key: { PK: `PATIENT#${recipientId}`, SK: `DOCTOR#${userId}` } })),
                regionalDb.send(new GetCommand({ TableName: DB_TABLES.GRAPH, Key: { PK: `DOCTOR#${recipientId}`, SK: `PATIENT#${userId}` } }))
            ]);

            if (!relations.some(r => !!r.Item)) {
                await writeAuditLog(userId, "SYSTEM", "UNAUTHORIZED_MESSAGE", "Blocked: No Graph Link", { region });
                return { statusCode: 403, body: { error: "Blocked: No established care relationship." } };
            }

            const senderType = userRole === 'doctor' ? "Practitioner" : "Patient";
            const recipientType = userRole === 'doctor' ? "Patient" : "Practitioner";

            const fhirResource = mapToFHIRCommunication(userId, senderType, recipientId, recipientType, text);
            const timestamp = new Date().toISOString();
            
            await regionalDb.send(new PutCommand({
                TableName: DB_TABLES.HISTORY,
                Item: { 
                    conversationId, timestamp, senderId: userId, recipientId,
                    text: scrubPII(text), resource: fhirResource, isRead: false
                }
            }));

            const connections = await regionalDb.send(new QueryCommand({
                TableName: DB_TABLES.CONNECTIONS,
                IndexName: "UserIdIndex",
                KeyConditionExpression: "userId = :uid",
                ExpressionAttributeValues: { ":uid": recipientId }
            }));

            const deliveryPromises = (connections.Items || []).map(async (conn) => {
                try {
                    await apigw.send(new PostToConnectionCommand({
                        ConnectionId: conn.connectionId,
                        Data: JSON.stringify({ type: "message", senderId: userId, text: scrubPII(text), conversationId, timestamp })
                    }));
                } catch (e: any) {
                    if (e.name === 'GoneException' || e.statusCode === 410) {
                        await regionalDb.send(new DeleteCommand({ TableName: DB_TABLES.CONNECTIONS, Key: { connectionId: conn.connectionId } }));
                    }
                }
            });

            await Promise.all(deliveryPromises);
            return { statusCode: 200, body: { status: "Sent", conversationId } };

        case "$disconnect":
            await regionalDb.send(new DeleteCommand({ TableName: DB_TABLES.CONNECTIONS, Key: { connectionId } }));
            return { statusCode: 200, body: {} };

        default:
            return { statusCode: 400, body: { error: "Unknown Route" } };
    }
};

export const chatController = router;