// --- Safe Dependency Loading ---
let instrumentedDDBClient, instrumentedSNSClient;
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

try {
    const AWSXRay = require("aws-xray-sdk-core");
    const ddbModule = require("@aws-sdk/client-dynamodb");
    const snsModule = require("@aws-sdk/client-sns");
    // Instrument the clients
    instrumentedDDBClient = AWSXRay.captureAWSv3Client(new ddbModule.DynamoDBClient({}));
    instrumentedSNSClient = AWSXRay.captureAWSv3Client(new snsModule.SNSClient({}));
    console.log("X-Ray: ENABLED");
} catch (e) {
    console.log("X-Ray: SKIPPED (Library not found). Running in standard mode.");
    instrumentedDDBClient = new DynamoDBClient({});
    instrumentedSNSClient = new SNSClient({});
}

// Initialize Global Clients
const dynamo = DynamoDBDocumentClient.from(instrumentedDDBClient);
const sns = instrumentedSNSClient;

// Use Env Vars or Defaults
const INVENTORY_TABLE = process.env.INVENTORY_TABLE || "mediconnect-pharmacy-inventory";
const PRESCRIPTION_TABLE = process.env.PRESCRIPTION_TABLE || "mediconnect-prescriptions";
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;

exports.handler = async (event) => {
    console.log("Event:", JSON.stringify(event));
    
    // 1. Safe Body Parsing
    let body = {};
    if (event.body) {
        try {
            body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        } catch (e) {
            return response(400, { error: "Invalid JSON" });
        }
    }

    const path = event.resource || event.path || ""; // Safe fallback
    const method = event.httpMethod;

    try {
        // ==========================================
        // ROUTE 1: INVENTORY (Pharmacy Side)
        // ==========================================
        if (path.includes("/pharmacy/inventory") && method === "POST") {
            const { pharmacyId, drugId, stock, price } = body;
            await dynamo.send(new PutCommand({
                TableName: INVENTORY_TABLE,
                Item: { pharmacyId, drugId, stock, price, lastUpdated: new Date().toISOString() }
            }));
            return response(200, { message: "Inventory updated successfully" });
        }

        // ==========================================
        // ROUTE 2: REQUEST REFILL (Patient Side) - NEW!
        // ==========================================
        if (path.includes("/pharmacy/request-refill") && method === "POST") {
            const { prescriptionId } = body;

            // Update status so it appears on Doctor's Dashboard
            await dynamo.send(new UpdateCommand({
                TableName: PRESCRIPTION_TABLE,
                Key: { prescriptionId: prescriptionId },
                UpdateExpression: "set #status = :s, #t = :t",
                ExpressionAttributeNames: { "#status": "status", "#t": "updatedAt" },
                ExpressionAttributeValues: { 
                    ":s": "REFILL_REQUESTED",
                    ":t": new Date().toISOString()
                }
            }));
            return response(200, { message: "Refill request sent to doctor." });
        }

        // ==========================================
        // ROUTE 3: GENERATE QR (Patient Side)
        // ==========================================
        if (path.includes("/pharmacy/generate-qr") && method === "POST") {
            const { prescriptionId } = body;
            
            // Security: Check if it's allowed to be picked up
            const pres = await dynamo.send(new GetCommand({ TableName: PRESCRIPTION_TABLE, Key: { prescriptionId } }));
            if (!pres.Item) return response(404, { error: "Prescription not found" });

            // Only generate code if Issued (Doctor Approved) or Ready
            const allowedStatuses = ["ISSUED", "READY_FOR_PICKUP"];
            if (!allowedStatuses.includes(pres.Item.status)) {
                return response(403, { error: "Cannot generate code. Doctor approval required." });
            }

            const pickupCode = `PICKUP-${prescriptionId.substring(0,8)}-${Math.floor(1000 + Math.random() * 9000)}`;
            
            await dynamo.send(new UpdateCommand({
                TableName: PRESCRIPTION_TABLE,
                Key: { prescriptionId: prescriptionId },
                UpdateExpression: "set pickupCode = :c, #status = :s",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":c": pickupCode, ":s": "READY_FOR_PICKUP" }
            }));
            return response(200, { qrPayload: pickupCode });
        }

        // ==========================================
        // ROUTE 4: FULFILL ORDER (Pharmacy Side)
        // ==========================================
        if (path.includes("/pharmacy/fulfill") && method === "POST") {
            const { pharmacyId, prescriptionId, scannedCode } = body;
            const pres = await dynamo.send(new GetCommand({ TableName: PRESCRIPTION_TABLE, Key: { prescriptionId } }));
            
            if (!pres.Item) return response(404, { error: "Prescription not found" });
            if (pres.Item.pickupCode !== scannedCode) return response(403, { error: "Invalid Code" });

            await dynamo.send(new UpdateCommand({
                TableName: PRESCRIPTION_TABLE,
                Key: { prescriptionId: prescriptionId },
                UpdateExpression: "set #status = :s, pharmacyId = :p, fulfilledAt = :t",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":s": "PICKED_UP", ":p": pharmacyId, ":t": new Date().toISOString() }
            }));

            // Notify System (SNS)
            if (SNS_TOPIC_ARN) {
                try {
                    await sns.send(new PublishCommand({
                        TopicArn: SNS_TOPIC_ARN,
                        Message: `Order ${prescriptionId} picked up from Pharmacy ${pharmacyId}.`,
                        Subject: "Order Fulfilled"
                    }));
                } catch (e) { console.log("SNS Warning:", e.message); }
            }
            return response(200, { success: true });
        }

        return response(400, { error: "Invalid Route", path: path });

    } catch (error) {
        console.error("Handler Error", error);
        return response(500, { error: error.message });
    }
};

function response(statusCode, body) {
    return {
        statusCode: statusCode,
        headers: { 
            "Content-Type": "application/json", 
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
        },
        body: JSON.stringify(body)
    };
}