import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";import { v4 as uuidv4 } from "uuid";


 

const s3Client = new S3Client({ region: "us-east-1" });
const dbClient = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(dbClient);

const BUCKET_NAME = "mediconnect-ehr-records"; 
const TABLE_NAME = "mediconnect-health-records";
const TABLE_DOCTORS = "mediconnect-doctors";
const TABLE_NOTES = "mediconnect-clinical-notes";

export const handler = async (event) => {
    // 🔒 HEADERS
    const headers = {
        "Access-Control-Allow-Origin": "*", // Updated to allow all origins (safer for dev)
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "OPTIONS,GET,POST"
    };

    try {
        // Handle Options Preflight
        if (event.httpMethod === 'OPTIONS') {
             return { statusCode: 200, headers: headers, body: '' };
        }

        const body = event.body ? JSON.parse(event.body) : event;
        const { action, patientId, fileName, fileType, doctorId, description } = body;

        // --- ACTION 1: Get Secure Upload URL (S3) ---
        if (action === "request_upload") {
            const recordId = uuidv4();
            const s3Key = `${patientId}/${recordId}-${fileName}`;

            // 1. Generate the Secure URL (Valid for 5 minutes)
            const command = new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: s3Key,
                ContentType: fileType
            });
            const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

            // 2. Save Metadata to DynamoDB
            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    patientId,
                    recordId,
                    fileName,
                    fileType,
                    description,
                    uploadedBy: doctorId || "patient",
                    s3Key,
                    s3Url: uploadUrl.split("?")[0], // Clean URL for storage
                    createdAt: new Date().toISOString()
                }
            }));

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({ uploadUrl, recordId })
            };
        }

        // --- ACTION 2: Get Clinical Notes (Read Mode) ---
        if (action === "get_clinical_notes") {
            try {
                const command = new QueryCommand({
                    TableName: TABLE_NOTES,
                    KeyConditionExpression: "patientId = :pid",
                    ExpressionAttributeValues: { ":pid": patientId },
                    ScanIndexForward: false 
                });
                const response = await docClient.send(command);
                
                // Format to match old MongoDB structure
                const formattedNotes = (response.Items || []).map(item => ({
                    noteId: item.noteId,
                    text: item.text,
                    doctorId: item.doctorId,
                    doctorName: item.doctorName,
                    timestamp: item.timestamp
                }));

                return { 
                    statusCode: 200, 
                    headers: headers, 
                    body: JSON.stringify({ patientId, clinicalNotes: formattedNotes }) 
                };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ error: "Failed to fetch notes" }) };
            }
        }

        // --- ACTION 3: Add Clinical Note (Write Mode) - ✨ NEW ✨ ---
        if (action === "add_clinical_note") {
            if (!patientId || !body.note || !doctorId) {
                 return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "Missing required fields" }) };
            }
            try {
                const newNote = {
                    patientId: patientId,
                    timestamp: new Date().toISOString(),
                    noteId: uuidv4(),
                    text: body.note,
                    doctorId: doctorId,
                    doctorName: body.doctorName || "Unknown Doctor",
                    createdAt: new Date().toISOString()
                };

                await docClient.send(new PutCommand({
                    TableName: TABLE_NOTES,
                    Item: newNote
                }));

                return {
                    statusCode: 200,
                    headers: headers,
                    body: JSON.stringify({ message: "Clinical note saved", note: newNote })
                };
            } catch (err) {
                return { statusCode: 500, headers: headers, body: JSON.stringify({ error: "Failed to save note" }) };
            }
        }

        // --- ACTION 4: List Records for a Patient (DynamoDB) ---
        if (action === "list_records") {
            const command = new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "patientId = :pid",
                ExpressionAttributeValues: { ":pid": patientId }
            });

            const response = await docClient.send(command);
            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify(response.Items || [])
            };
        }
        // --- ACTION 5: Get Secure View Link (WITH SECURITY CHECK) ---
        if (action === "get_view_url") {
            const { s3Key, doctorId } = body; // 🟢 We now require doctorId

            if (!s3Key || !doctorId) {
                return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "Missing s3Key or doctorId" }) };
            }

            // 1. 🔒 CHECK DOCTOR STATUS IN DYNAMODB
            const docRes = await docClient.send(new GetCommand({
                TableName: TABLE_DOCTORS,
                Key: { doctorId: doctorId } 
            }));

            const doctor = docRes.Item;

            // 2. 🛑 IF NOT APPROVED, BLOCK ACCESS
            // Checks if it is missing, or false, or string "false"
            if (!doctor || doctor.isOfficerApproved !== true) {
                console.log(`⛔ Blocked access for ${doctorId}. Approved: ${doctor?.isOfficerApproved}`);
                return { 
                    statusCode: 403, 
                    headers: headers, 
                    body: JSON.stringify({ error: "Access Denied: Officer Approval Required." }) 
                };
            }

            // 3. ✅ IF APPROVED, GENERATE LINK
            const command = new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: s3Key
            });

            const viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({ viewUrl })
            };
       }

        return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "Invalid action" }) };

    } catch (error) {
        console.error("EHR Error:", error);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: error.message }) };
    }
};