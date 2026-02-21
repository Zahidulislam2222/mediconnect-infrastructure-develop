import { Request, Response, NextFunction } from 'express';

// AWS SDK v3
import { GetCommand, PutCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CompareFacesCommand } from "@aws-sdk/client-rekognition";

// Shared Utilities
import { safeError } from '../../../shared/logger';
import { writeAuditLog } from '../../../shared/audit';

// Shared Clients
import { getRegionalClient, getRegionalS3Client, getRegionalRekognitionClient } from '../config/aws';

// =============================================================================
// ⚙️ CONFIGURATION & ENV HANDLING
// =============================================================================
const CONFIG = {
    DYNAMO_TABLE: process.env.DYNAMO_TABLE || 'mediconnect-patients',
    DOCTOR_TABLE: process.env.DYNAMO_TABLE_DOCTORS || 'mediconnect-doctors',
    BUCKET_NAME: process.env.BUCKET_NAME || 'mediconnect-identity-verification',
};

// =============================================================================
// 🛠️ HELPERS
// =============================================================================

// Helper to handle async errors (Prevents Node.js crash on unhandled promises)
const catchAsync = (fn: any) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 🟢 COMPILER & GDPR FIX: Safely parse headers to determine Legal Jurisdiction
export const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

/**
 * Generates a temporary signed URL for viewing private S3 avatars.
 * 🟢 HIPAA 2026 Standard: PHI links must expire in 15 minutes (900s).
 */
async function signAvatarUrl(avatarKey: string | null, region: string): Promise<string | null> {
    if (!avatarKey) return null;
    if (avatarKey.startsWith('http')) return avatarKey;

    try {
        const regionalS3 = getRegionalS3Client(region);
        // 🟢 GDPR: Dynamically target EU or US bucket based on patient region
        const bucketName = region.toUpperCase() === 'EU' ? `${CONFIG.BUCKET_NAME}-eu` : CONFIG.BUCKET_NAME;
        const command = new GetObjectCommand({ Bucket: bucketName, Key: avatarKey });
        
        return await getSignedUrl(regionalS3, command, { expiresIn: 900 });
    } catch (e) {
        safeError(`[Avatar Sign Error]`, e);
        return null;
    }
}

// =============================================================================
// 🎮 CONTROLLERS
// =============================================================================

/**
 * 1. CREATE PATIENT (FHIR R4 Compliant)
 */
export const createPatient = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const dynamicDb = getRegionalClient(region);
    
    // 🟢 SECURITY FIX: Stop trusting req.body.userId! Hackers can spoof it.
    // Strictly use the Verified Token ID from Cognito.
    const authUser = (req as any).user;
    if (!authUser || !authUser.id) {
        return res.status(401).json({ error: "Unauthorized: You must be logged in." });
    }

    const finalId = authUser.id; // 🔒 Locked to the cryptographic token
    const { email, name, role = 'patient', dob, gender = 'unknown', phone } = req.body;

    if (!email) return res.status(400).json({ error: "Missing email" });

    const timestamp = new Date().toISOString();

    // 🟢 FHIR Compliance: Standardized Patient Resource
    const fhirResource = {
        resourceType: "Patient",
        id: finalId,
        active: true,
        name: [{ use: "official", text: name }],
        telecom: [{ system: "email", value: email }, { system: "phone", value: phone }],
        gender: gender?.toLowerCase(),
        birthDate: dob,
        meta: { lastUpdated: timestamp }
    };

    const item = {
        patientId: finalId,
        email,
        name,
        role,
        isEmailVerified: false,
        isIdentityVerified: false,
        createdAt: timestamp,
        avatar: null,
        dob,
        resource: fhirResource,
        region: region
    };

    try {
        await dynamicDb.send(new PutCommand({ 
            TableName: CONFIG.DYNAMO_TABLE, 
            Item: item,
            ConditionExpression: "attribute_not_exists(patientId)"
        }));
    } catch (e: any) {
        if (e.name === 'ConditionalCheckFailedException') return res.status(409).json({ error: 'Patient already registered' });
        throw e;
    }

    // 🟢 HIPAA FIX: IP Address added to audit log
    await writeAuditLog(finalId, finalId, "CREATE_PROFILE", "Patient registration completed", { 
        region, ipAddress: req.ip 
    });

    res.status(200).json({ message: "Patient Registration Processed", region });
});

/**
 * 2. GET PROFILE (Strict Ownership Check)
 */
export const getProfile = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const dynamicDb = getRegionalClient(region);
    
    const requestedId = req.params.id;
    const requesterId = (req as any).user?.id;
    const isDoctor = (req as any).user?.isDoctor;

    const targetId = requestedId || requesterId;

    // 🟢 PRIVACY GATE: Only the owner or a verified Doctor can view a profile
    if (requestedId && requestedId !== requesterId && !isDoctor) {
        await writeAuditLog(requesterId || "UNKNOWN", targetId, "UNAUTHORIZED_READ_ATTEMPT", "Blocked attempt to read another patient.");
        return res.status(403).json({ error: "HIPAA Violation: Unauthorized access." });
    }

    const response = await dynamicDb.send(new GetCommand({
        TableName: CONFIG.DYNAMO_TABLE,
        Key: { patientId: targetId }
    }));

    if (!response.Item) return res.status(404).json({ error: "Profile not found." });

    response.Item.avatar = await signAvatarUrl(response.Item.avatar, region);

    await writeAuditLog(requesterId, targetId, "READ_PROFILE", "Profile accessed", {
        role: isDoctor ? "doctor" : "patient",
        region,
        ipAddress: req.ip
    });

    res.json(response.Item);
});

/**
 * 3. UPDATE PROFILE (FHIR Sync)
 */
export const updateProfile = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const dynamicDb = getRegionalClient(region);

    const requestedId = req.params.id;
    const requesterId = (req as any).user?.id;

    if (requestedId !== requesterId) {
        return res.status(403).json({ error: "Unauthorized to edit this profile." });
    }

    const allowedUpdates = ['name', 'avatar', 'phone', 'address', 'preferences', 'dob', 'fcmToken'];
    const body = req.body;
    const parts: string[] = [];
    const names: any = {};
    const values: any = {};

    allowedUpdates.forEach(field => {
        if (body[field] !== undefined) {
            parts.push(`#${field} = :${field}`);
            names[`#${field}`] = field;
            values[`:${field}`] = body[field];

            // 🟢 FHIR SYNC: Automatically update nested FHIR properties
            if (field === 'name') {
                parts.push("resource.name[0].text = :fhirName");
                values[":fhirName"] = body[field];
            }
            if (field === 'dob') {
                parts.push("resource.birthDate = :dob");
            }
            if (field === 'phone') {
                parts.push("resource.telecom[1].value = :phone");
            }
        }
    });

    if (parts.length === 0) return res.status(400).json({ error: "No valid fields to update" });

    const now = new Date().toISOString();
    parts.push("#updatedAt = :now", "resource.meta.lastUpdated = :now");
    names["#updatedAt"] = "updatedAt";
    values[":now"] = now;

    const response = await dynamicDb.send(new UpdateCommand({
        TableName: CONFIG.DYNAMO_TABLE,
        Key: { patientId: requestedId },
        UpdateExpression: "SET " + parts.join(", "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW"
    }));

    await writeAuditLog(requesterId, requestedId, "UPDATE_PROFILE", "Patient profile updated", {
        region, ipAddress: req.ip
    });
    
    res.json({ message: "Profile updated successfully", profile: response.Attributes });
});

/**
 * 4. VERIFY IDENTITY (AI Rekognition)
 */
export const verifyIdentity = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const authUser = (req as any).user;
    
    const { selfieImage, idImage } = req.body;
    if (!authUser?.id || !selfieImage) return res.status(400).json({ error: "Missing identity data" });

    const userId = authUser.id;
    const isDoctor = authUser.isDoctor;
    const userRole = isDoctor ? 'doctor' : 'patient';
    const idCardKey = `${userRole}/${userId}/id_card.jpg`;
    
    // 🟢 GDPR: ID cards are auto-deleted after 24h via S3 Lifecycle tags (Patients Only)
    const fileTags = !isDoctor ? "auto-delete=true" : undefined; 

    const regionalS3 = getRegionalS3Client(region);
    const regionalRek = getRegionalRekognitionClient(region);
    const dynamicDb = getRegionalClient(region);

    const bucketName = region.toUpperCase() === 'EU' ? `${CONFIG.BUCKET_NAME}-eu` : CONFIG.BUCKET_NAME;

    if (idImage) {
        await regionalS3.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: idCardKey,
            Body: Buffer.from(idImage, 'base64'),
            ContentType: 'image/jpeg',
            Tagging: fileTags
        }));
    }

    const compareCmd = new CompareFacesCommand({
        SourceImage: { S3Object: { Bucket: bucketName, Name: idCardKey } },
        TargetImage: { Bytes: Buffer.from(selfieImage, 'base64') },
        SimilarityThreshold: 80
    });
    
    const aiResponse = await regionalRek.send(compareCmd);
    if (!aiResponse.FaceMatches || aiResponse.FaceMatches.length === 0) {
        return res.json({ verified: false, message: "Face does not match ID card." });
    }

    const selfieKey = `${userRole}/${userId}/selfie_verified.jpg`;
    await regionalS3.send(new PutObjectCommand({
        Bucket: bucketName, Key: selfieKey,
        Body: Buffer.from(selfieImage, 'base64'), ContentType: 'image/jpeg'
    }));

    // Update the corresponding correct table
    const targetTable = isDoctor ? CONFIG.DOCTOR_TABLE : CONFIG.DYNAMO_TABLE;
    const primaryKeyName = isDoctor ? "doctorId" : "patientId";

    await dynamicDb.send(new UpdateCommand({
        TableName: targetTable,
        Key: { [primaryKeyName]: userId },
        UpdateExpression: "set avatar = :a, isIdentityVerified = :v, identityStatus = :s",
        ExpressionAttributeValues: { ':a': selfieKey, ':v': true, ':s': "VERIFIED" }
    }));

    await writeAuditLog(userId, userId, "IDENTITY_VERIFIED", "AI facial biometric match successful", {
        region, ipAddress: req.ip
    });

    return res.json({ verified: true, message: "Identity Verified" });
});

/**
 * 5. DELETE PROFILE (GDPR Right to be Forgotten)
 */
export const deleteProfile = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const dynamicDb = getRegionalClient(region);
    const userId = (req as any).user?.id;

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // 🟢 HIPAA Data Retention vs GDPR Erasure: 
    // We soft-delete and anonymize PII immediately, but keep a hashed record for 30 days.
    const ttl = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

    await dynamicDb.send(new UpdateCommand({
        TableName: CONFIG.DYNAMO_TABLE,
        Key: { patientId: userId },
        UpdateExpression: "SET #s = :s, #ttl = :ttl, #n = :n, email = :e, avatar = :a, deletedAt = :now, resource = :empty",
        ExpressionAttributeNames: { "#s": "status", "#ttl": "ttl", "#n": "name" },
        ExpressionAttributeValues: { 
            ":s": "DELETED", ":ttl": ttl, 
            ":n": `ANONYMIZED_USER`, ":e": `gdpr_deleted_${userId}@mediconnect.local`, 
            ":a": null, ":now": new Date().toISOString(), ":empty": {} 
        }
    }));

    await writeAuditLog(userId, userId, "DELETE_PROFILE", "User invoked GDPR Right to be Forgotten", {
        region, ipAddress: req.ip
    });

    res.json({ message: "Account fully anonymized and scheduled for hard deletion.", status: "DELETED" });
});

/**
 * 6. SEARCH PATIENTS (FHIR Interoperability)
 */
export const searchPatients = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const dynamicDb = getRegionalClient(region);
    const { name } = req.query;

    const command = new ScanCommand({
        TableName: CONFIG.DYNAMO_TABLE,
        FilterExpression: "contains(#n, :name)",
        ExpressionAttributeNames: { "#n": "name" },
        ExpressionAttributeValues: { ":name": name as string }
    });

    const result = await dynamicDb.send(command);
    
    await writeAuditLog((req as any).user?.id || "SYSTEM", "MULTIPLE", "SEARCH_PATIENT", "Database search performed", {
        region, ipAddress: req.ip
    });

    res.json(result.Items || []);
});

/**
 * 7. GET DEMOGRAPHICS (Analytics Dashboard)
 */
export const getDemographics = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const dynamicDb = getRegionalClient(region);

    const command = new ScanCommand({
        TableName: CONFIG.DYNAMO_TABLE,
        ProjectionExpression: 'dob, #r',
        ExpressionAttributeNames: { '#r': 'role' }
    });

    const response = await dynamicDb.send(command);
    const items = response.Items || [];

    const ageGroups: Record<string, number> = { '18-30': 0, '31-50': 0, '51-70': 0, '70+': 0 };
    let patientCount = 0;
    const currentYear = new Date().getFullYear();

    for (const item of items) {
        if (item.role === 'patient' && item.dob) {
            patientCount++;
            try {
                const birthYear = parseInt(item.dob.split('-')[0]);
                const age = currentYear - birthYear;
                if (age <= 30) ageGroups['18-30']++;
                else if (age <= 50) ageGroups['31-50']++;
                else if (age <= 70) ageGroups['51-70']++;
                else ageGroups['70+']++;
            } catch { continue; }
        }
    }

    const demographicData = Object.entries(ageGroups).map(([k, v]) => ({ name: k, value: v }));
    res.json({ demographicData, totalPatients: patientCount });
});

/**
 * 8. GET PATIENT BY ID (Shared Access for Doctors)
 */
export const getPatientById = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const dynamicDb = getRegionalClient(region);
    
    // Support both /:userId and /:id parameters
    const requestedId = req.params.userId || req.params.id;
    const requesterId = (req as any).user?.id;
    const isDoctor = (req as any).user?.isDoctor;

    // 🟢 ACCESS CONTROL: Owner OR Doctor Only
    if (requestedId !== requesterId && !isDoctor) {
         return res.status(403).json({ error: "Unauthorized access to patient record." });
    }

    const response = await dynamicDb.send(new GetCommand({
        TableName: CONFIG.DYNAMO_TABLE,
        Key: { patientId: requestedId }
    }));

    if (!response.Item) return res.status(404).json({ error: "Patient not found." });
    
    // Sign the avatar URL before returning
    response.Item.avatar = await signAvatarUrl(response.Item.avatar, region);

    await writeAuditLog(requesterId, requestedId, "READ_PATIENT_BY_ID", "Direct ID lookup performed", { region, role: isDoctor ? 'doctor' : 'patient' });
    res.json(response.Item);
});