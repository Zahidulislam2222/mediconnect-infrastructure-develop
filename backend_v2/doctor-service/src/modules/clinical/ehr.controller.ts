import { Request, Response } from "express";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { query } from '../../config/db';
import { safeLog, safeError } from '../../../../shared/logger';

const s3Client = new S3Client({ region: "us-east-1" });
const BUCKET_NAME = process.env.EHR_BUCKET || "mediconnect-ehr-records";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const TABLE_EHR = "mediconnect-health-records";
const AUDIT_TABLE = "mediconnect-audit-logs";

// 🟢 HIPAA: Centralized Audit Logging function
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
                metadata: { platform: "MediConnect-v2", security: "High" }
            }
        }));
    } catch (e) { console.error("Audit Log Failed", e); }
};

// 🟢 RESTORED Standalone Export for Routes
export const getUploadUrl = async (req: Request, res: Response) => {
    const { fileName, fileType, patientId } = req.body;
    const authUser = (req as any).user;

    if (!fileName || !patientId) return res.status(400).json({ error: "Missing fields" });

    const s3Key = `${patientId}/${uuidv4()}-${fileName}`;

    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key,
            ContentType: fileType
        });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

        // HIPAA Log
        await writeAuditLog(authUser.sub, patientId, "REQUEST_UPLOAD_URL", `File: ${fileName}`);

        res.json({ uploadUrl, s3Key });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// 🟢 RESTORED Standalone Export for Routes
export const getViewUrl = async (req: Request, res: Response) => {
    const { s3Key } = req.body;
    const authUser = (req as any).user;

    if (!s3Key) return res.status(400).json({ error: "s3Key required" });

    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key
        });
        const viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

        // HIPAA Log
        await writeAuditLog(authUser.sub, s3Key.split('/')[0], "GET_VIEW_URL", `Key: ${s3Key}`);

        res.json({ viewUrl });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

export const handleEhrAction = async (req: Request, res: Response) => {
    const { action, patientId } = req.body;
    const authUser = (req as any).user;

    // 1. SECURITY: Determine Roles
    let isDoctor = authUser['cognito:groups']?.some((g: string) => ['doctor', 'doctors'].includes(g.toLowerCase()));
    if (!isDoctor) {
        const docCheck = await query('SELECT 1 FROM doctors WHERE id = $1', [authUser.sub]);
        if (docCheck.rows.length > 0) isDoctor = true;
    }
    const isOwner = authUser.sub === patientId;

    if (!isDoctor && !isOwner) return res.status(403).json({ error: "Access Denied" });

    try {
        switch (action) {
            case "list_records":
                const listCmd = new QueryCommand({
                    TableName: TABLE_EHR,
                    KeyConditionExpression: "patientId = :pid",
                    ExpressionAttributeValues: { ":pid": patientId }
                });
                const result = await docClient.send(listCmd);
                const items = result.Items || [];

                const processedItems = await Promise.all(items.map(async (item) => {
                    if (item.type === 'NOTE' || !item.s3Key) return item;
                    try {
                        const s3Url = await getSignedUrl(s3Client, new GetObjectCommand({
                            Bucket: BUCKET_NAME, Key: item.s3Key
                        }), { expiresIn: 900 });
                        return { ...item, s3Url };
                    } catch (e) { return { ...item, error: "Link expired" }; }
                }));

                await writeAuditLog(authUser.sub, patientId, "ACCESS_LIST", `Viewed ${items.length} records`);
                return res.json(processedItems);

            case "add_clinical_note":
                const { note, title, fileName } = req.body;
                const noteId = uuidv4();

                // 🟢 HL7 FHIR-NATIVE RESOURCE: ClinicalImpression
                const fhirResource = {
                    resourceType: "ClinicalImpression",
                    id: noteId,
                    status: "completed",
                    subject: { reference: `Patient/${patientId}` }, // FHIR Reference
                    assessor: { reference: `Practitioner/${authUser.sub}` }, // FHIR Reference
                    date: new Date().toISOString(),
                    summary: note,
                    description: fileName || title || "Clinical Consultation",
                    // 🛡️ HIPAA/GDPR Metadata
                    meta: {
                        versionId: "1",
                        lastUpdated: new Date().toISOString(),
                        security: [
                            { system: "http://terminology.hl7.org/CodeSystem/v3-Confidentiality", code: "R", display: "restricted" }
                        ],
                        tag: [
                            { system: "https://mediconnect.com/privacy", code: "GDPR-LOCKED" }
                        ]
                    }
                };

                // 🟢 BACKEND REFACTOR: Store Root Keys + FHIR Resource
                await docClient.send(new PutCommand({
                    TableName: TABLE_EHR,
                    Item: {
                        patientId,
                        recordId: noteId,
                        type: 'NOTE', // Root key for Indexing using On-the-fly migration
                        isLocked: true, // 🟢 IMMUTABILITY ENFORCED
                        resource: fhirResource, // 🟢 RAW FHIR JSON MAP
                        createdAt: new Date().toISOString()
                    }
                }));

                await writeAuditLog(authUser.sub, patientId, "CREATE_FHIR_RESOURCE", `Resource: ClinicalImpression/${noteId}`);
                return res.json({ success: true, fhirId: noteId });

            case "save_record_metadata":
                const { fileName: fName, fileType, s3Key, description } = req.body;
                const recordId = uuidv4();
                await docClient.send(new PutCommand({
                    TableName: TABLE_EHR,
                    Item: {
                        patientId, recordId,
                        fileName: fName, fileType, s3Key,
                        description: description || "Medical Upload",
                        uploadedBy: authUser.sub,
                        createdAt: new Date().toISOString()
                    }
                }));
                await writeAuditLog(authUser.sub, patientId, "UPLOAD_FILE", `File: ${fName}`);
                return res.json({ success: true, recordId });

            case "request_upload":
                return getUploadUrl(req, res);

            case "get_view_url":
                return getViewUrl(req, res);

            default:
                return res.status(400).json({ error: "Invalid Action" });
        }
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};