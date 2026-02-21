import { Request, Response } from 'express';

// AWS SDK v3
import {
    GetCommand,
    PutCommand,
    UpdateCommand,
    ScanCommand
} from "@aws-sdk/lib-dynamodb";
import {
    PutObjectCommand,
    GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CompareFacesCommand } from "@aws-sdk/client-rekognition";

// Shared Utilities
import { safeLog, safeError } from '../../../shared/logger';
import { writeAuditLog } from '../../../shared/audit';

// Shared Clients
import { docClient, s3Client, rekognitionClient, getRegionalClient, getRegionalS3Client, getRegionalRekognitionClient } from '../config/aws';

// =============================================================================
// ⚙️ CONFIGURATION & ENV HANDLING
// =============================================================================
const CONFIG = {
    DYNAMO_TABLE: process.env.DYNAMO_TABLE || 'mediconnect-patients',
    BUCKET_NAME: process.env.BUCKET_NAME || 'mediconnect-identity-verification',
    
};


// =============================================================================
// 🛠️ HELPERS
// =============================================================================

/**
 * Generates a temporary signed URL for viewing private S3 avatars.
 * 🟢 HIPAA 2026 Standard: PHI links must expire in 15 minutes (900s).
 */
async function signAvatarUrl(avatarKey: string | null): Promise<string | null> {
    if (!avatarKey) return null;
    if (avatarKey.startsWith('http')) return avatarKey;

    try {
        const command = new GetObjectCommand({
            Bucket: CONFIG.BUCKET_NAME,
            Key: avatarKey
        });
        // 🟢 FIX: Reduced from 3600 to 900 for HIPAA compliance
        return await getSignedUrl(s3Client, command, { expiresIn: 900 });
    } catch (e) {
        safeError(`[Avatar Sign Error]`, e);
        return null;
    }
}

// =============================================================================
// 🎮 CONTROLLERS
// =============================================================================

/**
 * 1. GET DEMOGRAPHICS
 */
export const getDemographics = async (req: Request, res: Response) => {
    try {
        const userRegion = (req as any).user?.region || "us-east-1";
        const dynamicDb = getRegionalClient(userRegion);

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
    } catch (error: any) {
        safeError("Demographics Error:", error);
        res.status(500).json({ error: "Failed to fetch demographics" });
    }
};

/**
 * 2. GET PROFILE
 * GDPR: Enforces regional silo lookup.
 */
export const getProfile = async (req: Request, res: Response) => {
    try {
        const requestedId = req.params.id;
        const requesterId = (req as any).user?.id;
        const requesterRole = (req as any).user?.role;
        const userRegion = (req as any).user?.region || "us-east-1";

        const isStaff = ['doctor', 'admin', 'provider'].includes(requesterRole);
        const isOwner = !requestedId || requestedId === requesterId;

        if (!isOwner && !isStaff) {
            return res.status(403).json({ error: "Unauthorized access to this profile." });
        }

        const targetId = requestedId || requesterId;
        const dynamicDb = getRegionalClient(userRegion);

        const response = await dynamicDb.send(new GetCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Key: { patientId: targetId }
        }));

        if (!response.Item) return res.status(404).json({ error: "Profile not found." });

        response.Item.avatar = await signAvatarUrl(response.Item.avatar);

        await writeAuditLog(requesterId, targetId, "READ_PROFILE", "Profile accessed", {
            role: requesterRole,
            region: userRegion
        });

        res.json(response.Item);
    } catch (error: any) {
        safeError("Get Profile Error:", error);
        res.status(500).json({ error: "DB Error" });
    }
};

/**
 * 3. GET PATIENT BY ID
 * 🟢 GDPR FIX: Uses getRegionalClient to prevent cross-region data leaks.
 */
export const getPatientById = async (req: Request, res: Response) => {
    try {
        const requestedId = req.params.userId || req.params.id || (req.query.id as string);
        const requesterId = (req as any).user?.id;
        const requesterRole = (req as any).user?.role;
        const userRegion = (req as any).user?.region || "us-east-1";

        if (!requestedId) return res.status(400).json({ error: "No Patient ID provided" });

        const isAuthorized = requesterId === requestedId || ['admin', 'doctor', 'provider'].includes(requesterRole);
        if (!isAuthorized) return res.status(403).json({ error: "Unauthorized." });

        // 🟢 FIX: Use dynamic region client instead of static docClient
        const dynamicDb = getRegionalClient(userRegion);
        const result = await dynamicDb.send(new GetCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Key: { patientId: String(requestedId) }
        }));

        if (!result.Item) return res.status(404).json({ message: "Patient profile not found." });

        result.Item.avatar = await signAvatarUrl(result.Item.avatar);
        res.status(200).json(result.Item);

    } catch (error: any) {
        safeError("GetPatientById Error:", error);
        res.status(500).json({ error: "Internal Database Error" });
    }
};

/**
 * 4. CREATE PATIENT
 * FHIR R4 Compliant creation.
 */
export const createPatient = async (req: Request, res: Response) => {
    try {
        const { userId, email, name, role = 'patient', dob, gender = 'unknown', phone } = req.body;
        if (!userId || !email) return res.status(400).json({ error: "Missing userId or email" });

        const userRegion = (req.headers['x-user-region'] as string) || "us-east-1";
        const dynamicDb = getRegionalClient(userRegion);
        const timestamp = new Date().toISOString();

        const fhirResource = {
            resourceType: "Patient",
            id: userId,
            active: true,
            name: [{ use: "official", text: name }],
            telecom: [{ system: "email", value: email }, { system: "phone", value: phone }],
            gender: gender?.toLowerCase(),
            birthDate: dob,
            meta: { lastUpdated: timestamp }
        };

        const item = {
            patientId: userId,
            email,
            name,
            role,
            isEmailVerified: false,
            isIdentityVerified: false,
            createdAt: timestamp,
            avatar: null,
            dob,
            resource: fhirResource,
            region: userRegion
        };

        await dynamicDb.send(new PutCommand({ TableName: CONFIG.DYNAMO_TABLE, Item: item }));
        await writeAuditLog(userId, userId, "CREATE_PROFILE", "Patient registration completed", { region: userRegion });

        res.status(200).json({ message: "Patient Registration Processed", region: userRegion });
    } catch (error: any) {
        safeError("Create Patient Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
};

/**
 * 5. UPDATE PROFILE
 * 🟢 FHIR FIX: Synchronizes updates between root fields and the 'resource' object.
 */
export const updateProfile = async (req: Request, res: Response) => {
    try {
        const requestedId = req.params.id;
        const requesterId = (req as any).user?.id;
        const userRegion = (req as any).user?.region || "us-east-1";

        if (requestedId !== requesterId) return res.status(403).json({ error: "Unauthorized" });

        const allowedUpdates = ['name', 'avatar', 'phone', 'address', 'preferences', 'dob', 'isEmailVerified', 'fcmToken'];
        const body = req.body;
        const parts: string[] = [];
        const names: any = {};
        const values: any = {};

        allowedUpdates.forEach(field => {
            if (body[field] !== undefined) {
                parts.push(`#${field} = :${field}`);
                names[`#${field}`] = field;
                values[`:${field}`] = body[field];

                // 🟢 FHIR SYNC: Update the nested FHIR resource fields
                if (field === 'name') {
                    parts.push("resource.#fhirName[0].#fhirText = :name");
                    names["#fhirName"] = "name";
                    names["#fhirText"] = "text";
                }
                if (field === 'dob') {
                    parts.push("resource.birthDate = :dob");
                }
            }
        });

        if (parts.length === 0) return res.status(400).json({ error: "No valid fields" });

        const now = new Date().toISOString();
        parts.push("#updatedAt = :now", "resource.meta.lastUpdated = :now");
        names["#updatedAt"] = "updatedAt";
        values[":now"] = now;

        const dynamicDb = getRegionalClient(userRegion);
        const response = await dynamicDb.send(new UpdateCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Key: { patientId: requestedId },
            UpdateExpression: "SET " + parts.join(", "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: "ALL_NEW"
        }));

        await writeAuditLog(requesterId, requestedId, "UPDATE_PROFILE", "Profile updated");
        res.json({ message: "Profile updated successfully", profile: response.Attributes });
    } catch (error: any) {
        safeError("Update Profile Error:", error);
        res.status(500).json({ error: "Update failed" });
    }
};

/**
 * 6. VERIFY IDENTITY
 */
export const verifyIdentity = async (req: Request, res: Response) => {
    try {
        const { userId, selfieImage, idImage, role = 'patient' } = req.body;
        const userRegion = (req as any).user?.region || "us-east-1";

        // 1. Define missing variables (FIXES 6 ERRORS)
        const isDoctor = role === 'provider' || role === 'doctor';
        const userRole = isDoctor ? 'doctor' : 'patient';
        const idCardKey = `${userRole}/${userId}/id_card.jpg`;
        const fileTags = !isDoctor ? "auto-delete=true" : undefined;
        const timestamp = new Date().toISOString();

        // 2. Get regional clients (Requires import update below)
        const regionalS3 = getRegionalS3Client(userRegion);
        const regionalRek = getRegionalRekognitionClient(userRegion);
        const dynamicDb = getRegionalClient(userRegion);

        const bucketName = userRegion.toUpperCase() === 'EU' ? `${CONFIG.BUCKET_NAME}-eu` : CONFIG.BUCKET_NAME;

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
            Bucket: bucketName,
            Key: selfieKey,
            Body: Buffer.from(selfieImage, 'base64'),
            ContentType: 'image/jpeg'
        }));

        if (isDoctor) {
            // Update Doctor in DynamoDB
            await dynamicDb.send(new UpdateCommand({
                TableName: "mediconnect-doctors",
                Key: { doctorId: userId },
                UpdateExpression: "set avatar = :a, isIdentityVerified = :v, verificationStatus = :s",
                ExpressionAttributeValues: { ':a': selfieKey, ':v': true, ':s': "VERIFIED" }
            }));
        } else {
            // Update Patient in DynamoDB
            await dynamicDb.send(new UpdateCommand({
                TableName: CONFIG.DYNAMO_TABLE,
                Key: { patientId: userId },
                UpdateExpression: "set avatar = :a, isIdentityVerified = :v, identityStatus = :s",
                ExpressionAttributeValues: { ':a': selfieKey, ':v': true, ':s': "VERIFIED" }
            }));
        }

        return res.json({ verified: true, message: "Verified" });
    } catch (error: any) {
        safeError("Identity Verification Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
};

/**
 * 7. DELETE PROFILE (GDPR)
 */
export const deleteProfile = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.id;
        const userRegion = (req as any).user?.region || "us-east-1";
        if (!userId) return res.status(400).json({ error: "Unauthorized" });

        const ttl = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
        const dynamicDb = getRegionalClient(userRegion);

        await dynamicDb.send(new UpdateCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Key: { patientId: userId },
            UpdateExpression: "SET #s = :s, #ttl = :ttl, #n = :n, #e = :e, #a = :a, deletedAt = :now",
            ExpressionAttributeNames: { "#s": "status", "#ttl": "ttl", "#n": "name", "#e": "email", "#a": "avatar" },
            ExpressionAttributeValues: { ":s": "DELETED", ":ttl": ttl, ":n": `DELETED_USER_${userId}`, ":e": `deleted_${userId}@mediconnect.local`, ":a": null, ":now": new Date().toISOString() }
        }));

        await writeAuditLog(userId, userId, "DELETE_PROFILE", "User requested GDPR deletion");
        res.json({ message: "Account scheduled for deletion.", status: "DELETED" });
    } catch (error: any) {
        safeError("Delete Profile Error:", error);
        res.status(500).json({ error: "Delete failed" });
    }
};

/**
 * 8. SEARCH PATIENTS (FHIR R4)
 */
export const searchPatients = async (req: Request, res: Response) => {
    try {
        const { name } = req.query;
        const userRegion = (req.headers['x-user-region'] as string) || "us-east-1";
        const dynamicDb = getRegionalClient(userRegion);

        const command = new ScanCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            FilterExpression: "contains(#n, :name)",
            ExpressionAttributeNames: { "#n": "name" },
            ExpressionAttributeValues: { ":name": name as string }
        });

        const result = await dynamicDb.send(command);
        await writeAuditLog((req as any).user?.id || "SYSTEM", "MULTIPLE", "SEARCH_PATIENT", "FHIR Search performed");

        res.json(result.Items || []);
    } catch (e) { 
        res.status(500).json({ error: "Search Failed" }); 
    }
};