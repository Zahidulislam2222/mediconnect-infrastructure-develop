
import { Request, Response } from 'express';
import { Pool } from 'pg';

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

// Shared Clients (Prevents Connection Hangs)
import { docClient, s3Client, rekognitionClient } from '../config/aws';

// =============================================================================
// ⚙️ CONFIGURATION & ENV HANDLING
// =============================================================================
const CONFIG = {
    // Prioritize .env, fallback to hardcoded string if .env is missing/wrong
    DYNAMO_TABLE: process.env.DYNAMO_TABLE || 'mediconnect-patients',
    BUCKET_NAME: process.env.BUCKET_NAME || 'mediconnect-identity-verification',
    DB: {
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD, // Critical: Ensure this is in .env
        database: process.env.DB_NAME || 'mediconnect',
        port: Number(process.env.DB_PORT) || 5432,
    }
};

// Initialize Postgres Pool (For Doctor verification sync)
const pgPool = new Pool({
    ...CONFIG.DB,
    ssl: false // Set to true in Production if using AWS RDS/GCP Cloud SQL public IP
});

// =============================================================================
// 🛠️ HELPERS
// =============================================================================

/**
 * Generates a temporary signed URL for viewing private S3 avatars.
 * Security: Prevents public access to the raw S3 bucket.
 */
async function signAvatarUrl(avatarKey: string | null): Promise<string | null> {
    if (!avatarKey) return null;
    if (avatarKey.startsWith('http')) return avatarKey; // Already a URL (e.g., Google Auth)

    try {
        const command = new GetObjectCommand({
            Bucket: CONFIG.BUCKET_NAME,
            Key: avatarKey
        });
        // URL valid for 1 hour (3600 seconds)
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        console.warn(`[Avatar Sign Error] Could not sign key: ${avatarKey}`);
        return null;
    }
}

// =============================================================================
// 🎮 CONTROLLERS
// =============================================================================

/**
 * 1. GET DEMOGRAPHICS
 * Public Route (Aggregate Data Only - No PII)
 */
export const getDemographics = async (req: Request, res: Response) => {
    try {
        const command = new ScanCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            ProjectionExpression: 'dob, #r',
            ExpressionAttributeNames: { '#r': 'role' }
        });

        const response = await docClient.send(command);
        const items = response.Items || [];

        // Aggregate Data (Privacy Safe)
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
 * 2. GET PROFILE (Protected)
 * HIPAA: Enforces strict ownership or Staff Access.
 */
export const getProfile = async (req: Request, res: Response) => {
    try {
        const requestedId = req.params.id;
        const requesterId = (req as any).user?.id;
        const requesterRole = (req as any).user?.role;

        // HIPAA Authorization Check
        const isStaff = ['doctor', 'admin', 'provider'].includes(requesterRole);
        const isOwner = !requestedId || requestedId === requesterId;

        if (!isOwner && !isStaff) {
            return res.status(403).json({ error: "Unauthorized access to this profile." });
        }

        const targetId = requestedId || requesterId;

        const command = new GetCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Key: { patientId: targetId }
        });
        const response = await docClient.send(command);

        if (!response.Item) {
            return res.status(404).json({ error: "Profile not found." });
        }

        // Security: Sign private S3 URL
        response.Item.avatar = await signAvatarUrl(response.Item.avatar);

        // Audit Log
        await writeAuditLog(requesterId, targetId, "READ_PROFILE", "Profile accessed");

        res.json(response.Item);
    } catch (error: any) {
        safeError("Get Profile Error:", error);
        res.status(500).json({ error: "DB Error" });
    }
};

/**
 * 3. GET PATIENT BY ID (Specific Lookup)
 * Robust ID handling for /:userId, /:id, and ?id=...
 */
export const getPatientById = async (req: Request, res: Response) => {
    try {
        // 🟢 FIX: Handle all possible ways Express passes parameters
        const requestedId = req.params.userId || req.params.id || (req.query.id as string);

        const requesterId = (req as any).user?.id;
        const requesterRole = (req as any).user?.role;

        if (!requestedId) {
            return res.status(400).json({ error: "No Patient ID provided" });
        }

        // 🟢 FIX: Permission Check
        const isAuthorized =
            requesterId === requestedId ||
            ['admin', 'doctor', 'provider'].includes(requesterRole);

        if (!isAuthorized) {
            return res.status(403).json({ error: "Unauthorized." });
        }

        // 🟢 FIX: Correct Table & Key
        const result = await docClient.send(new GetCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Key: {
                patientId: String(requestedId)
            }
        }));

        if (!result.Item) {
            return res.status(404).json({ message: "Patient profile not found." });
        }

        result.Item.avatar = await signAvatarUrl(result.Item.avatar);

        res.status(200).json(result.Item);

    } catch (error: any) {
        safeError("GetPatientById Error:", error);
        res.status(500).json({ error: "Internal Database Error" });
    }
};

/**
 * 4. CREATE PATIENT
 * Handles Registration and FHIR R4 Resource Mapping.
 */
export const createPatient = async (req: Request, res: Response) => {
    try {
        const { userId, email, name, role = 'patient', dob, gender = 'unknown', phone } = req.body;

        if (!userId || !email) return res.status(400).json({ error: "Missing userId or email" });

        const timestamp = new Date().toISOString();

        // 🟢 FHIR R4 COMPLIANCE: Map to HL7 Standard
        const fhirResource = {
            resourceType: "Patient",
            id: userId,
            active: true,
            name: [{ use: "official", text: name }],
            telecom: [
                { system: "email", value: email },
                { system: "phone", value: phone }
            ],
            gender: gender?.toLowerCase(),
            birthDate: dob,
            meta: { lastUpdated: timestamp }
        };

        const item = {
            patientId: userId, // Primary Key
            email,
            name,
            role,
            isEmailVerified: false,
            isIdentityVerified: false,
            createdAt: timestamp,
            avatar: null,
            preferences: { email: true, sms: true },
            dob,
            resource: fhirResource // Embedded FHIR Data
        };

        await docClient.send(new PutCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Item: item
        }));

        await writeAuditLog(userId, userId, "CREATE_PROFILE", "Patient registration completed");

        res.status(200).json({ message: "Patient Registration Processed" });

    } catch (error: any) {
        safeError("Create Patient Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
};

/**
 * 5. UPDATE PROFILE
 * Updates allowed fields and refreshes FHIR Metadata.
 */
export const updateProfile = async (req: Request, res: Response) => {
    try {
        const requestedId = req.params.id;
        const requesterId = (req as any).user?.id;

        if (requestedId !== requesterId) {
            return res.status(403).json({ error: "You can only update your own profile." });
        }

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
            }
        });

        if (parts.length === 0) return res.status(400).json({ error: "No valid fields provided" });

        // Update Timestamps
        const now = new Date().toISOString();
        parts.push("#updatedAt = :updatedAt");
        names["#updatedAt"] = "updatedAt";
        values[":updatedAt"] = now;

        // Sync FHIR Metadata
        parts.push("resource.meta.lastUpdated = :updatedAt");

        const command = new UpdateCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Key: { patientId: requestedId },
            UpdateExpression: "SET " + parts.join(", "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: "ALL_NEW"
        });

        const response = await docClient.send(command);

        await writeAuditLog(requesterId, requestedId, "UPDATE_PROFILE", "Profile updated");

        res.json({ message: "Profile updated successfully", profile: response.Attributes });

    } catch (error: any) {
        safeError("Update Profile Error:", error);
        res.status(500).json({ error: "Update failed" });
    }
};

/**
 * 6. VERIFY IDENTITY (AI)
 * Uses AWS Rekognition to compare Selfie vs ID Card.
 * Syncs verified status to SQL (for Doctors) or DynamoDB (for Patients).
 */
export const verifyIdentity = async (req: Request, res: Response) => {
    try {
        const { userId, selfieImage, idImage, role = 'patient' } = req.body;
        const requesterId = (req as any).user?.id;

        if (userId !== requesterId) return res.status(403).json({ error: "Identity mismatch." });
        if (!selfieImage) return res.status(400).json({ error: "Missing selfie" });

        const isDoctor = role === 'provider' || role === 'doctor';
        const userRole = isDoctor ? 'doctor' : 'patient';

        // Convert Base64
        const selfieBytes = Buffer.from(selfieImage, 'base64');
        const idCardKey = `${userRole}/${userId}/id_card.jpg`;

        // 1. Upload ID (Private Bucket)
        if (idImage) {
            await s3Client.send(new PutObjectCommand({
                Bucket: CONFIG.BUCKET_NAME,
                Key: idCardKey,
                Body: Buffer.from(idImage, 'base64'),
                ContentType: 'image/jpeg'
            }));
        }

        // 2. AI Comparison
        const compareCmd = new CompareFacesCommand({
            SourceImage: { S3Object: { Bucket: CONFIG.BUCKET_NAME, Name: idCardKey } },
            TargetImage: { Bytes: selfieBytes },
            SimilarityThreshold: 80
        });
        const aiResponse = await rekognitionClient.send(compareCmd);

        if (!aiResponse.FaceMatches || aiResponse.FaceMatches.length === 0) {
            return res.json({ verified: false, message: "Face does not match ID card." });
        }

        // 3. Store Verified Selfie
        const confidence = aiResponse.FaceMatches[0].Similarity;
        const selfieKey = `${userRole}/${userId}/selfie_verified.jpg`;

        await s3Client.send(new PutObjectCommand({
            Bucket: CONFIG.BUCKET_NAME,
            Key: selfieKey,
            Body: selfieBytes,
            ContentType: 'image/jpeg'
        }));

        // 4. Update Database (Routing based on Role)
        if (isDoctor) {
            // Doctors -> PostgreSQL (GCP)
            const pgQuery = `
                UPDATE doctors 
                SET data = data || jsonb_build_object(
                    'isIdentityVerified', true,
                    'verificationStatus', 'VERIFIED',
                    'avatar', $1::text
                )
                WHERE id = $2::text
            `;
            await pgPool.query(pgQuery, [selfieKey, userId]);
        } else {
            // Patients -> DynamoDB (AWS)
            const ddbUpdate = new UpdateCommand({
                TableName: CONFIG.DYNAMO_TABLE,
                Key: { patientId: userId },
                UpdateExpression: "set avatar = :a, isIdentityVerified = :v, identityStatus = :s",
                ExpressionAttributeValues: { ':a': selfieKey, ':v': true, ':s': "VERIFIED" }
            });
            await docClient.send(ddbUpdate);
        }

        // Generate URL for immediate display
        const getCmd = new GetObjectCommand({ Bucket: CONFIG.BUCKET_NAME, Key: selfieKey });
        const photoUrl = await getSignedUrl(s3Client, getCmd, { expiresIn: 3600 });

        return res.json({ verified: true, confidence, message: "Verified", photoUrl });

    } catch (error: any) {
        safeError("Identity Verification Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
};

/**
 * 7. DELETE PROFILE (GDPR)
 * "Right to be Forgotten" - Performs PII Masking & Soft Delete.
 */
export const deleteProfile = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.id;
        if (!userId) return res.status(400).json({ error: "Unauthorized" });

        safeLog(`[GDPR] Initiating soft delete for ${userId}`);

        const timestamp = new Date().toISOString();
        const ttl = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 Days

        // 🟢 GDPR COMPLIANCE: Mask PII immediately
        const command = new UpdateCommand({
            TableName: CONFIG.DYNAMO_TABLE,
            Key: { patientId: userId },
            UpdateExpression: "SET #s = :s, #ttl = :ttl, #n = :n, #e = :e, #a = :a, deletedAt = :now",
            ExpressionAttributeNames: {
                "#s": "status",
                "#ttl": "ttl",
                "#n": "name",
                "#e": "email",
                "#a": "avatar"
            },
            ExpressionAttributeValues: {
                ":s": "DELETED",
                ":ttl": ttl,
                ":n": `DELETED_USER_${userId}`,             // Anonymized
                ":e": `deleted_${userId}@mediconnect.local`, // Anonymized
                ":a": null,
                ":now": timestamp
            }
        });

        await docClient.send(command);
        await writeAuditLog(userId, userId, "DELETE_PROFILE", "User requested GDPR deletion");

        res.json({ message: "Account scheduled for deletion.", status: "DELETED" });

    } catch (error: any) {
        safeError("Delete Profile Error:", error);
        res.status(500).json({ error: "Delete failed" });
    }
};