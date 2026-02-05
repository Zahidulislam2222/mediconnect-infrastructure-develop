import { Request, Response } from 'express';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, PutObjectTaggingCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { RekognitionClient, CompareFacesCommand, InvalidS3ObjectException } from "@aws-sdk/client-rekognition";
import { safeLog, safeError } from '@shared/logger';

const REGION = process.env.AWS_REGION || "us-east-1";

// Clients
const dbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const s3Client = new S3Client({ region: REGION });
const rekognitionClient = new RekognitionClient({ region: REGION });

// Config (Loaded from Vault usually, fallbacks here)
const DYNAMO_TABLE = process.env.DYNAMO_TABLE || 'mediconnect-patients';
const BUCKET_NAME = process.env.BUCKET_NAME || 'mediconnect-identity-verification';

// --- CONTROLLER METHODS ---

// 1. Get Demographics
export const getDemographics = async (req: Request, res: Response) => {
    try {
        // Optimization: Scan only dob and role
        const command = new ScanCommand({
            TableName: DYNAMO_TABLE,
            ProjectionExpression: 'dob, #r',
            ExpressionAttributeNames: { '#r': 'role' }
        });
        const response = await docClient.send(command);
        const items = response.Items || [];

        const ageGroups = { '18-30': 0, '31-50': 0, '51-70': 0, '70+': 0 };
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

        res.json({
            demographicData,
            totalPatients: patientCount
        });
    } catch (error: any) {
        safeError("Demographics Error:", error);
        res.status(500).json({ error: "Failed to fetch demographics", details: error.message });
    }
};

// 2. Get Profile
export const getProfile = async (req: Request, res: Response) => {
    try {
        const userId = req.params.id;
        if (!userId) return res.status(400).json({ error: "Missing id" });

        const command = new GetCommand({
            TableName: DYNAMO_TABLE,
            Key: { patientId: userId }
        });
        const response = await docClient.send(command);

        if (response.Item) {
            const item = response.Item;

            // Sign Avatar URL
            if (item.avatar && !item.avatar.startsWith('http')) {
                try {
                    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: item.avatar });
                    item.avatar = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                } catch (e) {
                    safeError("S3 Signing Error:", e);
                }
            }
            return res.json(item);
        } else {
            return res.status(404).json({ error: "Patient not found" });
        }
    } catch (error: any) {
        safeError("Get Profile Error:", error);
        res.status(500).json({ error: "Server Error", details: error.message });
    }
};

// 3. Create Patient
export const createPatient = async (req: Request, res: Response) => {
    try {
        const { userId, email, name, role = 'patient', dob } = req.body;

        if (!userId || !email) return res.status(400).json({ error: "Missing userId or email" });

        const timestamp = new Date().toISOString();
        const item = {
            patientId: userId,
            email,
            name,
            role,
            isEmailVerified: false,
            isIdentityVerified: false,
            createdAt: timestamp,
            avatar: null,
            preferences: { email: true, sms: true },
            dob // Optional
        };

        const command = new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: item
        });

        await docClient.send(command);
        res.status(200).json({ message: "Patient Registration Processed", details: ["DynamoDB: Success"] });

    } catch (error: any) {
        safeError("Create Patient Error:", error);
        res.status(500).json({ error: "Server Error", details: error.message });
    }
};

// 4. Update Profile
export const updateProfile = async (req: Request, res: Response) => {
    try {
        const userId = req.params.id;
        if (!userId) return res.status(400).json({ error: "Missing userId" });

        const allowedUpdates = ['name', 'avatar', 'phone', 'address', 'preferences', 'dob', 'isEmailVerified'];
        const body = req.body;

        const updateExpressionParts: string[] = [];
        const expressionAttributeNames: Record<string, string> = {};
        const expressionAttributeValues: Record<string, any> = {};

        for (const field of allowedUpdates) {
            if (body[field] !== undefined) {
                updateExpressionParts.push(`#${field} = :${field}`); // Note: logic fix below
                expressionAttributeNames[`#${field}`] = field;
                expressionAttributeValues[`:${field}`] = body[field];
            }
        }

        // Fix for array push syntax
        for (const field of allowedUpdates) {
            if (body[field] !== undefined) {
                // Already handled in loop logic conceptualization, fixing actual code
            }
        }

        // Re-do loop correctly
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

        if (parts.length === 0) return res.status(400).json({ error: "No valid fields provided for update" });

        parts.push("#updatedAt = :updatedAt");
        names["#updatedAt"] = "updatedAt";
        values[":updatedAt"] = new Date().toISOString();

        const command = new UpdateCommand({
            TableName: DYNAMO_TABLE,
            Key: { patientId: userId },
            UpdateExpression: "SET " + parts.join(", "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: "ALL_NEW"
        });

        const response = await docClient.send(command);
        res.json({ message: "Profile updated successfully", profile: response.Attributes });

    } catch (error: any) {
        safeError("Update Profile Error:", error);
        res.status(500).json({ error: "Update failed", details: error.message });
    }
};

// 5. Verify Identity (Rekognition)
export const verifyIdentity = async (req: Request, res: Response) => {
    try {
        const { userId, selfieImage, idImage, role = 'patient' } = req.body;

        if (!userId) return res.status(400).json({ error: "Missing userId" });
        if (!selfieImage) return res.status(400).json({ error: "No selfieImage provided" });

        // Normalize
        const userRole = role === 'provider' ? 'doctor' : role;
        const targetTable = userRole === 'doctor' ? 'mediconnect-doctors' : 'mediconnect-patients'; // Consider using ENV for table names if they differ
        const idKeyField = userRole === 'doctor' ? 'doctorId' : 'patientId';

        // Buffer from Base64
        const selfieBytes = Buffer.from(selfieImage, 'base64');
        const idCardKey = `${userRole}/${userId}/id_card.jpg`;

        // Upload ID Card if provided
        if (idImage) {
            const idBytes = Buffer.from(idImage, 'base64');
            await s3Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: idCardKey,
                Body: idBytes,
                ContentType: 'image/jpeg'
            }));

            // Tagging
            await s3Client.send(new PutObjectTaggingCommand({
                Bucket: BUCKET_NAME,
                Key: idCardKey,
                Tagging: { TagSet: [{ Key: 'auto-delete', Value: 'true' }] }
            }));
        }

        // Compare Faces
        try {
            const command = new CompareFacesCommand({
                SourceImage: { S3Object: { Bucket: BUCKET_NAME, Name: idCardKey } },
                TargetImage: { Bytes: selfieBytes },
                SimilarityThreshold: 80
            });
            const response = await rekognitionClient.send(command);

            if (response.FaceMatches && response.FaceMatches.length > 0) {
                const confidence = response.FaceMatches[0].Similarity;

                // Success: Upload Verified Selfie
                const selfieKey = `${userRole}/${userId}/selfie_verified.jpg`;
                await s3Client.send(new PutObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: selfieKey,
                    Body: selfieBytes,
                    ContentType: 'image/jpeg'
                }));

                // Update DB
                const dbTable = userRole === 'doctor' ? 'mediconnect-doctors' : DYNAMO_TABLE; // Handle diff tables

                const updateCmd = new UpdateCommand({
                    TableName: dbTable,
                    Key: { [idKeyField]: userId },
                    UpdateExpression: "set avatar = :a, isIdentityVerified = :v, verificationStatus = :s",
                    ExpressionAttributeValues: {
                        ':a': selfieKey,
                        ':v': true,
                        ':s': userRole === 'doctor' ? "PENDING_REVIEW" : "VERIFIED"
                    }
                });
                await docClient.send(updateCmd);

                // Generate Temp URL
                const getCmd = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: selfieKey });
                const photoUrl = await getSignedUrl(s3Client, getCmd, { expiresIn: 3600 });

                return res.json({
                    verified: true,
                    confidence,
                    message: `Identity Verified. Confidence: ${confidence?.toFixed(2)}%`,
                    photoUrl
                });

            } else {
                return res.json({ verified: false, message: "Face does not match the provided ID card." });
            }

        } catch (error: any) {
            if (error instanceof InvalidS3ObjectException || error.name === 'InvalidS3ObjectException') {
                return res.status(404).json({ error: "ID Document missing. Please ensure ID is uploaded." });
            }
            throw error;
        }

    } catch (error: any) {
        safeError("Identity Verification Error:", error);
        res.status(500).json({ error: "Server Error", details: error.message });
    }
};

// 6. Delete Profile (Right to be Forgotten)
export const deleteProfile = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.id || req.params.id; // Support both token and direct param if admin
        if (!userId) return res.status(400).json({ error: "Unauthorized" });

        safeLog(`[GDPR] Initiating soft delete for ${userId}`);

        const timestamp = new Date().toISOString();
        const ttl = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 days

        const command = new UpdateCommand({
            TableName: DYNAMO_TABLE,
            Key: { patientId: userId },
            UpdateExpression: "SET #s = :s, #ttl = :ttl, #n = :n, #e = :e, #a = :a, deletedAt = :now",
            ExpressionAttributeNames: {
                "#s": "status",
                "#ttl": "ttl",
                "#n": "name", // PII Masking
                "#e": "email",
                "#a": "avatar"
            },
            ExpressionAttributeValues: {
                ":s": "DELETED",
                ":ttl": ttl,
                ":n": `DELETED_USER_${userId}`,
                ":e": `deleted_${userId}@mediconnect.local`,
                ":a": null,
                ":now": timestamp
            }
        });

        await docClient.send(command);

        res.json({
            message: "Account Deleted. Data will be permanently removed in 30 days.",
            status: "Scheduled for deletion"
        });

    } catch (error: any) {
        safeError("Delete Profile Error:", error);
        res.status(500).json({ error: "Delete failed" });
    }
};
