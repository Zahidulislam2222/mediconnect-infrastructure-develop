import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({ region: "us-east-1" });

export const handler = async (event) => {
  // CORS Headers are mandatory for Frontend access
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST"
  };

  console.log("EVENT METHOD:", event.httpMethod);

  try {
    // ==========================================================
    // 1. GET: FETCH CHAT HISTORY (Professional Chat)
    // ==========================================================
    if (event.httpMethod === "GET") {
        const conversationId = event.queryStringParameters?.conversationId;
        
        if (!conversationId) {
             return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing conversationId" }) };
        }

        // Query DynamoDB for the chat thread
        const historyData = await ddb.send(new QueryCommand({
            TableName: "mediconnect-chat-history",
            KeyConditionExpression: "conversationId = :cid",
            ExpressionAttributeValues: { ":cid": conversationId },
            ScanIndexForward: true // true = oldest first (timeline order)
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ messages: historyData.Items || [] })
        };
    }

    // ==========================================================
    // 2. POST: AI CHATBOT (Existing Feature)
    // ==========================================================
    if (event.httpMethod === "POST") {
        const body = JSON.parse(event.body || "{}");
        const { message, patientId } = body;

        // Fetch Knowledge Base
        const dbData = await ddb.send(new ScanCommand({ TableName: "mediconnect-knowledge-base" }));
        const knowledgeContext = dbData.Items ? dbData.Items.map(item => item.content).join("\n") : "";

        // AI Inference (Bedrock)
        const input = {
          modelId: "amazon.nova-2-lite-v1:0", 
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: [{ text: `Context: ${knowledgeContext}\n\nQuestion: ${message}` }]
              }
            ],
            inferenceConfig: { max_new_tokens: 200, temperature: 0.7 }
          }),
        };

        const command = new InvokeModelCommand(input);
        const response = await bedrock.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const aiText = responseBody.output.message.content[0].text.trim();

        // Save AI Interaction
        await ddb.send(new PutCommand({
            TableName: "mediconnect-chat-history",
            Item: {
                conversationId: `AI#${patientId}`, // Segregated ID for AI chats
                timestamp: new Date().toISOString(),
                userMessage: message,
                botResponse: aiText,
                senderId: "AI_BOT",
                text: aiText
            }
        }));

        return { statusCode: 200, headers, body: JSON.stringify({ response: aiText }) };
    }

    return { statusCode: 400, headers, body: "Unsupported Method" };

  } catch (err) {
    console.error("Handler Error:", err);
    return { 
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Server Error", details: err.message }) 
    };
  }
};