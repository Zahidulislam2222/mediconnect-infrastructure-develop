/* 
  MEDICONNECT WEBSOCKET HANDLER (Professional & Dynamic)
  - No hardcoded URLs
  - Auto-detects API Gateway Endpoint
  - Manages Live Connections & Chat History
*/

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const CONNECTIONS_TABLE = "mediconnect-chat-connections";
const HISTORY_TABLE = "mediconnect-chat-history";

// We will initialize this dynamically based on the request
let apiGateway;

export const handler = async (event) => {
  const route = event.requestContext.routeKey;
  const connectionId = event.requestContext.connectionId;

  // 1. DYNAMICALLY DETECT ENDPOINT (The Professional Fix)
  // This constructs "https://xyz.execute-api.us-east-1.amazonaws.com/production" automatically
  if (!apiGateway) {
      const domain = event.requestContext.domainName;
      const stage = event.requestContext.stage;
      const endpoint = `https://${domain}/${stage}`;
      apiGateway = new ApiGatewayManagementApiClient({ endpoint });
  }

  try {
    switch (route) {
      case "$connect":
        return await handleConnect(event, connectionId);
      
      case "$disconnect":
        return await handleDisconnect(connectionId);
      
      case "sendMessage":
        const body = JSON.parse(event.body || "{}");
        return await handleMessage(body, connectionId);
        
      default:
        return { statusCode: 400, body: "Unknown route" };
    }
  } catch (err) {
    console.error("CRITICAL LAMBDA ERROR:", err);
    return { statusCode: 500, body: "Server Error" };
  }
};

// --- HANDLERS ---

async function handleConnect(event, connectionId) {
  // Phase 1: Trust userId param. Phase 2: Will switch to Token.
  const query = event.queryStringParameters || {};
  const userId = query.userId || "guest";

  await ddb.send(new PutCommand({
    TableName: CONNECTIONS_TABLE,
    Item: { 
      connectionId, 
      userId, 
      timestamp: new Date().toISOString(),
      // Auto-delete connection after 24 hours to keep DB clean
      ttl: Math.floor(Date.now() / 1000) + 86400 
    }
  }));
  
  return { statusCode: 200, body: "Connected" };
}

async function handleDisconnect(connectionId) {
  await ddb.send(new DeleteCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { connectionId }
  }));
  return { statusCode: 200, body: "Disconnected" };
}

async function handleMessage(body, senderConnectionId) {
  const { senderId, recipientId, text } = body;
  
  if (!senderId || !recipientId || !text) {
      return { statusCode: 400, body: "Missing fields" };
  }

  // A. Generate Standard Conversation ID (Alphabetical)
  const participants = [senderId, recipientId].sort();
  const conversationId = `${participants[0]}#${participants[1]}`;
  const timestamp = new Date().toISOString();

  // B. Save to History
  await ddb.send(new PutCommand({
    TableName: HISTORY_TABLE,
    Item: {
      conversationId, // PK
      timestamp,      // SK
      senderId,
      recipientId,
      text,
      isRead: false
    }
  }));

  // C. Find Recipient Connection
  const recipientData = await ddb.send(new QueryCommand({
    TableName: CONNECTIONS_TABLE,
    IndexName: "userId-index",
    KeyConditionExpression: "userId = :uid",
    ExpressionAttributeValues: { ":uid": recipientId }
  }));

  // D. Push to Recipient
  if (recipientData.Items && recipientData.Items.length > 0) {
    const promises = recipientData.Items.map(async (conn) => {
      try {
        await apiGateway.send(new PostToConnectionCommand({
          ConnectionId: conn.connectionId,
          Data: JSON.stringify({ 
              action: "sendMessage", 
              senderId, 
              text, 
              timestamp,
              conversationId 
          })
        }));
      } catch (e) {
        if (e.statusCode === 410) {
          // Connection is dead (Gone), clean up
          await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId: conn.connectionId } }));
        }
      }
    });
    await Promise.all(promises);
  }

  return { statusCode: 200, body: "Message Sent" };
}