import { Request, Response } from "express";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { PutCommand, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// 🟢 ARCHITECTURE FIX: Import Shared Factories (Prevents Socket Exhaustion)
import { getRegionalClient, getRegionalS3Client } from '../../config/aws'; 
import { writeAuditLog } from '../../../../shared/audit';

const TABLE_EHR = "mediconnect-health-records";

// 🟢 COMPILER FIX: Safely extract region string
const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

// Helper: Resolve Bucket Name based on Region
const getBucketName = (region: string) => {
    return region.toUpperCase().includes('EU') 
        ? (process.env.EHR_BUCKET_EU || "mediconnect-ehr-records-eu")
        : (process.env.EHR_BUCKET_US || "mediconnect-ehr-records");
};

export const getUploadUrl = async (req: Request, res: Response) => {
    const { fileName, fileType, patientId } = req.body;
    const authUser = (req as any).user;
    
    // 🟢 GDPR/INFRA FIX: Use Shared Cached Client
    const userRegion = extractRegion(req);
    const s3Client = getRegionalS3Client(userRegion);
    const bucketName = getBucketName(userRegion);

    if (!fileName || !patientId) return res.status(400).json({ error: "Missing fields" });

    // 🟢 HIPAA SECURITY FIX: IDOR Prevention
    const isDoctor = authUser['cognito:groups']?.some((g: string) => ['doctor', 'doctors'].includes(g.toLowerCase()));
    if (authUser.sub !== patientId && !isDoctor) {
        await writeAuditLog(authUser.sub, patientId, "UNAUTHORIZED_UPLOAD_ATTEMPT", "Blocked attempt to upload", { region: userRegion, ipAddress: req.ip });
        return res.status(403).json({ error: "HIPAA Violation: Unauthorized upload attempt." });
    }

    const s3Key = `${patientId}/${uuidv4()}-${fileName}`;

    try {
        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: s3Key,
            ContentType: fileType
        });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

        await writeAuditLog(authUser.sub, patientId, "REQUEST_UPLOAD_URL", `File: ${fileName}`, { region: userRegion, ipAddress: req.ip });
        res.json({ uploadUrl, s3Key });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

export const getViewUrl = async (req: Request, res: Response) => {
    const { s3Key } = req.body;
    const authUser = (req as any).user;
    
    // 🟢 GDPR/INFRA FIX: Use Shared Cached Client
    const userRegion = extractRegion(req);
    const s3Client = getRegionalS3Client(userRegion);
    const bucketName = getBucketName(userRegion);

    if (!s3Key) return res.status(400).json({ error: "s3Key required" });

    // 🟢 HIPAA SECURITY FIX: IDOR Prevention
    const targetPatientId = s3Key.split('/')[0];
    const isDoctor = authUser['cognito:groups']?.some((g: string) => ['doctor', 'doctors'].includes(g.toLowerCase()));
    
    if (authUser.sub !== targetPatientId && !isDoctor) {
        await writeAuditLog(authUser.sub, targetPatientId, "UNAUTHORIZED_VIEW_ATTEMPT", "Blocked attempt to view file", { region: userRegion, ipAddress: req.ip });
        return res.status(403).json({ error: "HIPAA Violation: Unauthorized view attempt." });
    }

    try {
        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: s3Key
        });
        const viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

        await writeAuditLog(authUser.sub, targetPatientId, "GET_VIEW_URL", `Key: ${s3Key}`, { region: userRegion, ipAddress: req.ip });
        res.json({ viewUrl });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

export const handleEhrAction = async (req: Request, res: Response) => {
    const { action, patientId } = req.body;
    const authUser = (req as any).user;
    
    // 🟢 INFRA FIX: Use Shared Cached Factories
    const userRegion = extractRegion(req);
    const regionalDb = getRegionalClient(userRegion);
    const s3Client = getRegionalS3Client(userRegion);
    const bucketName = getBucketName(userRegion);

    let isDoctor = authUser['cognito:groups']?.some((g: string) => ['doctor', 'doctors'].includes(g.toLowerCase()));
    
    if (!isDoctor) {
        try {
            const docCheck = await regionalDb.send(new GetCommand({
                TableName: "mediconnect-doctors",
                Key: { doctorId: authUser.sub }
            }));
            if (docCheck.Item) isDoctor = true;
        } catch (e) { 
            console.error("Doctor Check Failed", e); 
        }
    }
    
    const isOwner = authUser.sub === patientId;

    if (!isDoctor && !isOwner) {
        await writeAuditLog(authUser.sub, patientId, "UNAUTHORIZED_EHR_ACCESS", "Blocked access", { region: userRegion, ipAddress: req.ip });
        return res.status(403).json({ error: "Access Denied" });
    }

    try {
        switch (action) {
            case "list_records":
                const listCmd = new QueryCommand({
                    TableName: TABLE_EHR,
                    KeyConditionExpression: "patientId = :pid",
                    FilterExpression: "isDeleted <> :true", // 🟢 GDPR: Hide deleted records
                    ExpressionAttributeValues: { ":pid": patientId, ":true": true }
                });
                
                const result = await regionalDb.send(listCmd);
                const items = result.Items || [];

                const processedItems = await Promise.all(items.map(async (item: any) => {
                    if (item.type === 'NOTE' || !item.s3Key) return item;
                    try {
                        const s3Url = await getSignedUrl(s3Client, new GetObjectCommand({
                            Bucket: bucketName, Key: item.s3Key
                        }), { expiresIn: 900 });
                        return { ...item, s3Url };
                    } catch (e) { return { ...item, error: "Link expired" }; }
                }));

                await writeAuditLog(authUser.sub, patientId, "ACCESS_LIST", `Viewed ${items.length} records`, { region: userRegion, ipAddress: req.ip });
                return res.json(processedItems);

            case "add_clinical_note":
                const { note, title, fileName } = req.body;
                const noteId = uuidv4();

                const fhirImpression = {
                    resourceType: "ClinicalImpression",
                    id: noteId,
                    status: "completed",
                    code: {
                        coding: [{ system: "http://loinc.org", code: "11450-4", display: "Problem list - Reported" }],
                        text: title || "General Clinical Note"
                    },
                    subject: { reference: `Patient/${patientId}` },
                    assessor: { reference: `Practitioner/${authUser.sub}` },
                    date: new Date().toISOString(),
                    summary: note,
                    meta: {
                        versionId: "1", lastUpdated: new Date().toISOString(),
                        security: [{ system: "http://terminology.hl7.org/CodeSystem/v3-Confidentiality", code: "R", display: "restricted" }]
                    }
                };

                await regionalDb.send(new PutCommand({
                    TableName: TABLE_EHR,
                    Item: {
                        patientId, recordId: noteId, type: 'NOTE', summary: note,       
                        title: title || "Clinical Note", isLocked: true,      
                        resource: fhirImpression, createdAt: new Date().toISOString()
                    }
                }));

                await writeAuditLog(authUser.sub, patientId, "CREATE_FHIR_RESOURCE", `Resource: ClinicalImpression/${noteId}`, { region: userRegion, ipAddress: req.ip });
                return res.json({ success: true, fhirId: noteId });

            case "save_record_metadata":
                const { fileName: fName, fileType, s3Key, description } = req.body;
                const recordId = uuidv4();
                
                // 🟢 FHIR R4: DocumentReference
                const fhirDocument = {
                    resourceType: "DocumentReference",
                    id: recordId,
                    status: "current",
                    subject: { reference: `Patient/${patientId}` },
                    author: [{ reference: `Practitioner/${authUser.sub}` }],
                    description: description || fName,
                    content: [{
                        attachment: { contentType: fileType, url: s3Key, title: fName }
                    }],
                    date: new Date().toISOString()
                };

                await regionalDb.send(new PutCommand({
                    TableName: TABLE_EHR,
                    Item: {
                        patientId, recordId, fileName: fName, fileType, s3Key,
                        description: description || "Medical Upload",
                        uploadedBy: authUser.sub,
                        resource: fhirDocument, 
                        createdAt: new Date().toISOString()
                    }
                }));

                await writeAuditLog(authUser.sub, patientId, "UPLOAD_FILE", `File: ${fName} saved`, { region: userRegion, ipAddress: req.ip });
                return res.json({ success: true, recordId });

            // 🟢 GDPR FIX: Right to Erasure (Soft Delete)
            // Allows patient to 'delete' view, but maintains HIPAA retention in backend
            case "delete_record":
                const { recordIdToDelete } = req.body;
                if (!recordIdToDelete) return res.status(400).json({ error: "Missing recordId" });
                
                if (!isOwner && !isDoctor) return res.status(403).json({ error: "Unauthorized" });

                await regionalDb.send(new UpdateCommand({
                    TableName: TABLE_EHR,
                    Key: { patientId, recordId: recordIdToDelete },
                    UpdateExpression: "SET isDeleted = :true, deletedAt = :now, deletedBy = :who",
                    ExpressionAttributeValues: {
                        ":true": true,
                        ":now": new Date().toISOString(),
                        ":who": authUser.sub
                    }
                }));

                await writeAuditLog(authUser.sub, patientId, "DELETE_RECORD", `Soft deleted record ${recordIdToDelete}`, { region: userRegion, ipAddress: req.ip });
                return res.json({ success: true, message: "Record removed from view." });

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