import { KMSClient, VerifyCommand } from "@aws-sdk/client-kms";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

async function runPerfectAudit() {
    const region = process.env.AWS_REGION || "us-east-1";

    // 🟢 FIX: No hardcoded credentials. The SDK automatically picks up 
    // AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from your .env file.
    const ddbClient = new DynamoDBClient({ region });
    const docClient = DynamoDBDocumentClient.from(ddbClient);
    const kmsClient = new KMSClient({ region });

    const targetId = "d17c2fb3-022b..."; // Keep your target ID

    console.log("🔍 Step 1: Fetching...");
    const result = await docClient.send(new GetCommand({
        TableName: "mediconnect-prescriptions",
        Key: { prescriptionId: targetId }
    }));

    const item = result.Item;
    if (!item) {
        console.error("❌ Error: Prescription not found");
        return;
    }

    const originalDataToVerify = {
        prescriptionId: item.prescriptionId,
        patientName: item.patientName,
        doctorName: item.doctorName,
        medication: item.medication,
        dosage: item.dosage,
        instructions: item.instructions,
        timestamp: item.timestamp,
        price: item.price,
        refillsRemaining: item.refillsRemaining,
        paymentStatus: "UNPAID" 
    };

    console.log("🔒 Step 2: Sending to KMS...");
    const command = new VerifyCommand({
        // 🟢 FIX: Using Key ID from Environment Variables
        KeyId: process.env.KMS_KEY_ID, 
        Message: Buffer.from(JSON.stringify(originalDataToVerify)),
        MessageType: "RAW",
        Signature: Buffer.from(item.digitalSignature, "base64"),
        SigningAlgorithm: "RSASSA_PSS_SHA_256",
    });

    try {
        const response = await kmsClient.send(command);
        if (response.SignatureValid) {
            console.log("✅ [LEGAL AUDIT PASSED]");
            console.log("Identity and Integrity Verified.");
        }
    } catch (e: any) {
        console.error("❌ [AUDIT FAILED]:", e.message);
    }
}

runPerfectAudit();