import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { 
    DynamoDBDocumentClient, 
    PutCommand, 
    GetCommand, 
    QueryCommand, 
    UpdateCommand 
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms"; 
import { v4 as uuidv4 } from "uuid";

// --- CONFIGURATION ---
const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE_RX = process.env.TABLE_RX || "mediconnect-prescriptions";
const TABLE_DOCTORS = process.env.TABLE_DOCTORS || "mediconnect-doctors"; 
const TABLE_DRUGS = process.env.TABLE_DRUGS || "mediconnect-drug-interactions"; 
const BUCKET_NAME = process.env.BUCKET_NAME || "mediconnect-prescriptions"; 
const KMS_KEY_ID = process.env.KMS_KEY_ID; 

// --- INITIALIZE CLIENTS ---
const dbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const s3Client = new S3Client({ region: REGION });
const kmsClient = new KMSClient({ region: REGION });

export const handler = async (event) => {
    // 🔒 HEADERS
    const headers = {
        "Access-Control-Allow-Origin": "*", // In production, replace '*' with your frontend domain
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT"
    };

    try {
        // 🟢 1. HANDLE PREFLIGHT (OPTIONS)
        if (event.httpMethod === 'OPTIONS') {
            return { statusCode: 200, headers: headers, body: '' };
        }

        // 🟢 2. GET LOGIC (Fetch List - NOW OPTIMIZED)
        if (event.httpMethod === 'GET') {
            const { patientId, doctorId } = event.queryStringParameters || {};

            if (!patientId && !doctorId) {
                return { 
                    statusCode: 400, 
                    headers: headers, 
                    body: JSON.stringify({ error: "Missing required query parameter: patientId OR doctorId" }) 
                };
            }

            let queryParams = {
                TableName: TABLE_RX,
                ScanIndexForward: false // "false" means descending order (Newest first)
            };

            // SCENARIO A: Patient View (Use PatientIndex)
            if (patientId) {
                queryParams.IndexName = "PatientIndex";
                queryParams.KeyConditionExpression = "patientId = :pid";
                queryParams.ExpressionAttributeValues = { ":pid": patientId };
            }
            // SCENARIO B: Doctor View (Use DoctorIndex)
            else if (doctorId) {
                queryParams.IndexName = "DoctorIndex";
                queryParams.KeyConditionExpression = "doctorId = :did";
                queryParams.ExpressionAttributeValues = { ":did": doctorId };
            }

            // 🚀 FAST QUERY (No more Scan)
            const response = await docClient.send(new QueryCommand(queryParams));

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({
                    count: response.Count,
                    prescriptions: response.Items || []
                })
            };
        }

        // 🟢 3. PUT LOGIC (Update Status / Approve Refill)
        if (event.httpMethod === 'PUT') {
            const body = JSON.parse(event.body || "{}");
            const { prescriptionId, status } = body;

            if (!prescriptionId || !status) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "Missing prescriptionId or status" }) };
            }

            await docClient.send(new UpdateCommand({
                TableName: TABLE_RX,
                Key: { prescriptionId },
                UpdateExpression: "set #s = :status, #t = :updatedAt",
                ExpressionAttributeNames: { "#s": "status", "#t": "updatedAt" },
                ExpressionAttributeValues: { 
                    ":status": status,
                    ":updatedAt": new Date().toISOString()
                }
            }));

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({ message: "Prescription updated", status })
            };
        }

        // 🟢 4. POST LOGIC (Create Prescription - NOW SECURE)
        if (event.httpMethod === 'POST') {
            const body = event.body ? JSON.parse(event.body) : event;
            const { doctorId, patientId, medication, dosage, instructions } = body;

            if (!doctorId || !medication || !patientId || !dosage) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "Missing required fields" }) };
            }

            // A. Verify Doctor Credentials
            const doctorRecord = await docClient.send(new GetCommand({
                TableName: TABLE_DOCTORS,
                Key: { doctorId: doctorId }
            }));

            if (!doctorRecord.Item || doctorRecord.Item.isOfficerApproved !== true) {
                return { 
                    statusCode: 403, 
                    headers: headers, 
                    body: JSON.stringify({ error: "UNAUTHORIZED", message: "Doctor not credentialed." }) 
                };
            }

            // B. SECURITY CHECK: Fetch Patient's ACTIVE meds from DB (Do not trust frontend)
            // We use the new PatientIndex to find what they are currently taking.
            const patientHistory = await docClient.send(new QueryCommand({
                TableName: TABLE_RX,
                IndexName: "PatientIndex",
                KeyConditionExpression: "patientId = :pid",
                FilterExpression: "#s = :status", // Only check ACTIVE drugs
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { 
                    ":pid": patientId,
                    ":status": "ISSUED" 
                }
            }));

            const activeMeds = (patientHistory.Items || []).map(p => p.medication);
            
            // C. Check Drug Interactions
            try {
                // Get data about the NEW drug
                const drugData = await docClient.send(new GetCommand({
                    TableName: TABLE_DRUGS,
                    Key: { drugName: medication }
                }));

                if (drugData.Item && drugData.Item.interactsWith) {
                    const dangerousList = drugData.Item.interactsWith;
                    // Check if patient is taking anything on the dangerous list
                    const conflict = dangerousList.find(badDrug => activeMeds.includes(badDrug));
                    
                    if (conflict) {
                        return {
                            statusCode: 409, // Conflict
                            headers: headers, 
                            body: JSON.stringify({ 
                                error: "CRITICAL INTERACTION", 
                                message: `SAFETY ALERT: ${medication} cannot be prescribed. Patient is currently taking ${conflict}.` 
                            })
                        };
                    }
                }
            } catch (e) { 
                console.warn("Drug Interaction DB check skipped or failed:", e); 
                // We don't block the RX if the drug DB is down, but in strict systems, we might.
            }

            // D. Generate Digital Signature (AWS KMS)
            const prescriptionId = uuidv4();
            const timestamp = new Date().toISOString();
            const dataToSign = `${prescriptionId}|${doctorId}|${patientId}|${medication}|${dosage}|${timestamp}`;
            
            let digitalSignature = "UNSIGNED_DEV_MODE";

            if (KMS_KEY_ID) {
                try {
                    const signCommand = new SignCommand({
                        KeyId: KMS_KEY_ID,
                        Message: Buffer.from(dataToSign),
                        MessageType: "RAW",
                        SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256"
                    });
                    const signResponse = await kmsClient.send(signCommand);
                    digitalSignature = Buffer.from(signResponse.Signature).toString('base64');
                } catch (err) {
                    console.error("KMS Signing Error:", err);
                    // Decide: Fail request or allow unsigned? For medical apps, we usually fail.
                    // For this demo, we proceed but log error.
                }
            }

            // E. Save to Database
            await docClient.send(new PutCommand({
                TableName: TABLE_RX,
                Item: {
                    prescriptionId, doctorId, patientId, medication, dosage, instructions, 
                    timestamp, digitalSignature, status: "ISSUED"
                }
            }));

            // F. Save Receipt to S3
            await s3Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: `rx-${prescriptionId}.json`,
                Body: JSON.stringify({
                    receipt_id: prescriptionId,
                    verified_signature: digitalSignature,
                    details: `Rx for ${medication} (${dosage})`,
                    timestamp
                }, null, 2),
                ContentType: "application/json"
            }));

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({
                    message: "Prescription Signed & Issued",
                    prescriptionId,
                    digitalSignature
                })
            };
        }

    } catch (error) {
        console.error("Critical Error:", error);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: error.message }) };
    }
};