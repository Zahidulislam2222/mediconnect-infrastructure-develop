import { Router, Request, Response } from "express";
import { WebSocket } from "ws";
import { AICircuitBreaker } from "../utils/ai-circuit-breaker";
import { docClient } from "../config/aws";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const router = Router();
const aiService = new AICircuitBreaker();

const TABLE_HISTORY = "mediconnect-chat-history";

// --- REST ENDPOINTS ---

// 1. AI Chat Endpoint (POST /chat/ai)
router.post("/ai", async (req: Request, res: Response) => {
    try {
        const { message, context = [] } = req.body;
        if (!message) {
            return res.status(400).json({ error: "Message required" });
        }

        const logs: string[] = [];
        const response = await aiService.generateResponse(message, logs);

        // Save Interaction
        const interactionId = uuidv4();
        await docClient.send(new PutCommand({
            TableName: TABLE_HISTORY,
            Item: {
                conversationId: `AI_INTERACTION`,
                timestamp: new Date().toISOString(),
                userMessage: message,
                aiResponse: response.text,
                provider: response.provider,
                logs
            }
        }));

        res.json({
            response: response.text,
            metadata: { provider: response.provider, model: response.model }
        });

    } catch (error: any) {
        res.status(500).json({ error: "AI Service Failed", details: error.message });
    }
});

// 2. Get Chat History (GET /chat/history)
router.get("/history", async (req: Request, res: Response) => {
    const { conversationId } = req.query;
    if (!conversationId) {
        return res.status(400).json({ error: "conversationId required" });
    }

    try {
        const data = await docClient.send(new QueryCommand({
            TableName: TABLE_HISTORY,
            KeyConditionExpression: "conversationId = :cid",
            ExpressionAttributeValues: { ":cid": conversationId }
        }));
        res.json(data.Items || []);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export const chatController = router;

// --- WEBSOCKET LOGIC ---

// In-memory connection map (Cluster awareness requires Redis, using local for now)
const clients = new Map<string, WebSocket>();

export function handleWebSocketConnection(ws: WebSocket, req: any) {
    const userId = "user-" + Math.random().toString(36).substr(2, 5); // Extract from token in real imp
    clients.set(userId, ws);
    console.log(`WS Connected: ${userId}`);

    ws.on("message", async (data) => {
        try {
            const parsed = JSON.parse(data.toString());
            const { recipientId, text, conversationId } = parsed;

            // 1. Save to DB
            const timestamp = new Date().toISOString();
            await docClient.send(new PutCommand({
                TableName: TABLE_HISTORY,
                Item: {
                    conversationId: conversationId || "General",
                    timestamp,
                    senderId: userId,
                    recipientId,
                    text
                }
            }));

            // 2. Forward to Recipient
            // Note: In real production with multiple instances, use Redis Pub/Sub
            // For Azure Container Apps (single replica test) or sticky sessions, this works.
            clients.forEach((clientWs, clientId) => {
                // Determine if this client is the recipient (Simplification)
                // In prod: Check clientId === recipientId
                if (clientId === recipientId && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ senderId: userId, text, timestamp }));
                }
            });

        } catch (e) {
            console.error("WS Message Error:", e);
        }
    });

    ws.on("close", () => {
        clients.delete(userId);
        console.log(`WS Disconnected: ${userId}`);
    });
}
