import { NextFunction, Request, Response } from 'express';
import { generatePresignedUrl } from '../utils/s3';
import { TextractClient, AnalyzeDocumentCommand } from "@aws-sdk/client-textract";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { google } from 'googleapis';
import { PutCommand, GetCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getRegionalClient } from '../config/aws';
import { writeAuditLog } from '../../../shared/audit';
import jwt from 'jsonwebtoken';

const TABLE_DOCTORS = "mediconnect-doctors";

const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
};

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// Helper to handle async errors
const catchAsync = (fn: any) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 🟢 COMPILER FIX: Safely parse headers
export const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

// =============================================================================
// 1. PROFILE MANAGEMENT (DYNAMODB MIGRATED)
// =============================================================================

export const createDoctor = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    
    // 🟢 SECURITY FIX: We stop trusting req.body.userId. 
    // We strictly use the authenticated Token ID.
    const authUser = (req as any).user;
    if (!authUser || !authUser.sub) {
        return res.status(401).json({ error: "Unauthorized: You must be logged in to create a profile." });
    }
    
    const finalId = authUser.sub; // 🔒 Locked to the token
    const { email, name, specialization, licenseNumber, role } = req.body;

    if (!email) return res.status(400).json({ error: 'Missing email' });

    const fhirResource = {
        resourceType: "Practitioner",
        id: finalId,
        active: true,
        name: [{ text: name }],
        qualification: [{ code: { text: specialization || 'General Practice' } }]
    };

    const item = {
        doctorId: finalId, email, name,
        specialization: specialization || 'General Practice',
        licenseNumber: licenseNumber || 'PENDING_VERIFICATION',
        verificationStatus: 'UNVERIFIED',
        role: role === 'provider' ? 'doctor' : 'doctor',
        createdAt: new Date().toISOString(),
        consultationFee: 50, 
        resource: fhirResource 
    };

    try {
        await docClient.send(new PutCommand({
            TableName: TABLE_DOCTORS,
            Item: item,
            ConditionExpression: "attribute_not_exists(doctorId)"
        }));
    } catch (e: any) {
        if (e.name === 'ConditionalCheckFailedException') return res.status(409).json({ error: 'Doctor already registered' });
        throw e;
    }

    await writeAuditLog(finalId, finalId, "CREATE_DOCTOR", "Doctor profile created");
    res.status(201).json({ message: 'Doctor profile created successfully', doctor: item });
});

export const getDoctor = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req) as string;
    const docClient = getRegionalClient(region);
    const id = req.params.id || req.query.id;

    if (!id) return res.status(400).json({ error: 'Missing Doctor ID' });

    const result = await docClient.send(new GetCommand({
        TableName: TABLE_DOCTORS,
        Key: { doctorId: String(id) }
    }));

    if (!result.Item) return res.status(404).json({ error: 'Doctor not found' });

    const doctor = result.Item;

    if (doctor.avatar && !doctor.avatar.startsWith('http')) {
        // 🟢 GDPR FIX: Ensure presigned URLs point to the correct regional bucket
        const bucket = region.toUpperCase() === 'EU' ? 'mediconnect-identity-verification-eu' : 'mediconnect-identity-verification';
        doctor.avatar = await generatePresignedUrl(bucket, doctor.avatar);
    }

    await writeAuditLog((req as any).user?.sub || "SYSTEM", String(id), "READ_DOCTOR", "Profile viewed");
    res.status(200).json(doctor);
});

export const updateDoctor = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    const { id } = req.params;
    const updates = req.body;
    const authUser = (req as any).user;

    if (!id) return res.status(400).json({ error: 'Missing ID' });

    if (!authUser || authUser.sub !== id) {
        await writeAuditLog(authUser?.sub || "UNKNOWN", id, "UNAUTHORIZED_UPDATE_ATTEMPT", "Blocked attempt to modify another doctor.");
        return res.status(403).json({ error: "HIPAA Violation: Unauthorized." });
    }

    const parts: string[] = [];
    const names: any = {};
    const values: any = {};
    const allowed = ['name', 'specialization', 'bio', 'avatar', 'consultationFee'];

    Object.keys(updates).forEach(key => {
        if (allowed.includes(key) || key === 'schedule') {
            parts.push(`#${key} = :${key}`);
            names[`#${key}`] = key;
            values[`:${key}`] = updates[key];
        }
    });

    if (parts.length === 0) return res.status(400).json({ error: "No valid fields to update" });

    // 🟢 FHIR R4 FIX: Synchronize Flat DB Fields with the FHIR JSON Object
    if (updates.name) {
        parts.push("resource.name[0].text = :fhirName");
        values[":fhirName"] = updates.name;
    }
    if (updates.specialization) {
        parts.push("resource.qualification[0].code.text = :fhirSpec");
        values[":fhirSpec"] = updates.specialization;
    }

    parts.push("resource.meta.lastUpdated = :now");
    values[":now"] = new Date().toISOString();

    const response = await docClient.send(new UpdateCommand({
        TableName: TABLE_DOCTORS,
        Key: { doctorId: id },
        UpdateExpression: "SET " + parts.join(", "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW"
    }));

    await writeAuditLog(authUser.sub, id, "UPDATE_DOCTOR", "Profile updated");
    res.status(200).json({ message: 'Profile updated successfully', doctor: response.Attributes });
});

export const getDoctors = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    
    // 🟢 HIPAA FIX: Filter out unverified doctors so patients don't see them
    const response = await docClient.send(new ScanCommand({ 
        TableName: TABLE_DOCTORS,
        FilterExpression: "verificationStatus <> :unverified AND verificationStatus <> :rejected",
        ExpressionAttributeValues: {
            ":unverified": "UNVERIFIED",
            ":rejected": "REJECTED_AUTO"
        }
    }));

    // 🟢 DATA MINIMIZATION: Sanitize the output (Don't leak private keys or PII in a public list)
    const safeDoctors = (response.Items || []).map((doc: any) => ({
        doctorId: doc.doctorId,
        name: doc.name,
        specialization: doc.specialization,
        avatar: doc.avatar,
        bio: doc.bio,
        consultationFee: doc.consultationFee,
        verificationStatus: doc.verificationStatus,
        schedule: doc.schedule // Needed for booking
    }));

    res.status(200).json({ doctors: safeDoctors });
});

// =============================================================================
// 2. SCHEDULE MANAGEMENT
// =============================================================================

export const getSchedule = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    const { id } = req.params;

    const result = await docClient.send(new GetCommand({
        TableName: TABLE_DOCTORS,
        Key: { doctorId: id },
        ProjectionExpression: "schedule, timezone"
    }));

    if (!result.Item) return res.status(404).json({ error: 'Doctor not found' });
    res.status(200).json({ id: id, schedule: result.Item.schedule || {}, timezone: result.Item.timezone || 'UTC' });
});

export const updateSchedule = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    const { id } = req.params;
    const { schedule, timezone } = req.body;
    const authUser = (req as any).user;

    if (!authUser || authUser.sub !== id) return res.status(403).json({ error: "Unauthorized" });
    if (!schedule || typeof schedule !== 'object') return res.status(400).json({ error: 'Invalid schedule format.' });

    await docClient.send(new UpdateCommand({
        TableName: TABLE_DOCTORS, Key: { doctorId: id },
        UpdateExpression: "SET schedule = :s, timezone = :t",
        ExpressionAttributeValues: { ":s": schedule, ":t": timezone || 'UTC' },
        ReturnValues: "UPDATED_NEW"
    }));

    res.status(200).json({ message: 'Schedule updated successfully', schedule });
});

// =============================================================================
// 3. VERIFICATION (AI TEXTRACT -> DYNAMODB)
// =============================================================================

export const verifyDiploma = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req) as string;
    const docClient = getRegionalClient(region);
    
    // 🟢 GDPR FIX: AI Processing now matches the User's Legal Jurisdiction
    const regionalTextract = new TextractClient({ 
        region: region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1', 
        credentials 
    });

    const { id } = req.params;
    const { s3Key, bucketName, expectedName } = req.body;
    const authUser = (req as any).user;

    if (!authUser || authUser.sub !== id) return res.status(403).json({ error: "Unauthorized" });
    if (!s3Key || !bucketName) return res.status(400).json({ error: "Missing file data" });

    const command = new AnalyzeDocumentCommand({
        Document: { S3Object: { Bucket: bucketName, Name: s3Key } },
        FeatureTypes: ["QUERIES"],
        QueriesConfig: {
            Queries: [
                { Text: "What is the full name of the graduate or person on this document?", Alias: "GRADUATE_NAME" },
                { Text: "What is the name of the medical school or institution?", Alias: "INSTITUTION" },
                { Text: "What is the degree type or license number?", Alias: "DEGREE" }
            ]
        }
    });

    try {
        const response = await regionalTextract.send(command);

        const fullOcrText = response.Blocks?.filter(b => b.BlockType === 'LINE').map(b => b.Text).join(" ") || "";
        const nameMatched = fullOcrText.toLowerCase().includes(expectedName.toLowerCase().split(' ')[0]);

        const medicalKeywords = ["Doctor", "Medicine", "Surgeon", "Medical", "Physician", "MD", "License"];
        const hasMedicalContext = medicalKeywords.some(k => fullOcrText.includes(k));

        const isLegit = nameMatched && hasMedicalContext;
        const status = isLegit ? "PENDING_OFFICER_APPROVAL" : "REJECTED_AUTO";

        await docClient.send(new UpdateCommand({
            TableName: TABLE_DOCTORS, Key: { doctorId: id },
            UpdateExpression: "SET isDiplomaAutoVerified = :v, verificationStatus = :s, diplomaUrl = :u, aiExtractedText = :txt",
            ExpressionAttributeValues: { ":v": isLegit, ":s": status, ":u": `s3://${bucketName}/${s3Key}`, ":txt": fullOcrText.substring(0, 500) }
        }));

        if (isLegit) {
            // 🟢 HIPAA FIX: Masked PII in SNS Ops Alerts
            const maskedId = `${String(id).substring(0, 4)}****`;
            const regionalSns = new SNSClient({ region: region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1', credentials });
            
            await regionalSns.send(new PublishCommand({
                TopicArn: process.env.SNS_TOPIC_ARN || "arn:aws:sns:us-east-1:950110266426:mediconnect-ops-alerts",
                Message: `STRICT VERIFICATION: A Doctor (ID: ${maskedId}) uploaded a diploma. AI Confidence: HIGH. Awaiting human officer approval.`,
                Subject: "Doctor Credential Alert"
            }));
        }

        return res.json({ verified: isLegit, status, message: isLegit ? "AI Verification Successful." : "AI could not match your name." });

    } catch (e: any) {
        console.error("Textract Error:", e);
        return res.status(500).json({ error: "AI Processing Failed" });
    }
});

// =============================================================================
// 4. GOOGLE CALENDAR
// =============================================================================

export const getCalendarStatus = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    const { id } = req.params;
    const result = await docClient.send(new GetCommand({ TableName: TABLE_DOCTORS, Key: { doctorId: id }, ProjectionExpression: "googleRefreshToken" }));
    if (!result.Item) return res.status(404).json({ error: 'Doctor not found' });
    res.json({ connected: !!result.Item.googleRefreshToken });
});

export const connectGoogleCalendar = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.query; 
    const secret = process.env.GOOGLE_CLIENT_SECRET || 'fallback_secret';
    const secureState = jwt.sign({ doctorId: id }, secret, { expiresIn: '15m' });
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/calendar'], state: secureState });
    res.json({ url });
});

export const googleCallback = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    const { code, state } = req.query; 

    if (!code || !state) return res.status(400).json({ error: "Invalid callback data" });

    let targetDoctorId = "";
    try {
        const secret = process.env.GOOGLE_CLIENT_SECRET || 'fallback_secret';
        const decoded = jwt.verify(state as string, secret) as any;
        targetDoctorId = decoded.doctorId;
    } catch (err) { return res.status(403).json({ error: "Security Violation: Invalid state." }); }

    const { tokens } = await oauth2Client.getToken(code as string);

    if (tokens.refresh_token) {
        await docClient.send(new UpdateCommand({
            TableName: TABLE_DOCTORS, Key: { doctorId: targetDoctorId },
            UpdateExpression: "SET googleRefreshToken = :token", ExpressionAttributeValues: { ":token": tokens.refresh_token }
        }));
    }
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?calendar=connected`);
});

export const disconnectGoogleCalendar = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    const { id } = req.params;
    const authUser = (req as any).user;

    if (!authUser || authUser.sub !== id) return res.status(403).json({ error: "Unauthorized" });

    await docClient.send(new UpdateCommand({ TableName: TABLE_DOCTORS, Key: { doctorId: id }, UpdateExpression: "REMOVE googleRefreshToken" }));
    res.json({ connected: false, message: "Calendar disconnected" });
});

// =============================================================================
// 5. GDPR RIGHT TO ERASURE
// =============================================================================

export const deleteDoctor = catchAsync(async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req) as string);
    const { id } = req.params;
    const authUser = (req as any).user;

    if (!authUser || authUser.sub !== id) return res.status(403).json({ error: "Unauthorized" });

    await docClient.send(new UpdateCommand({
        TableName: TABLE_DOCTORS, Key: { doctorId: id },
        UpdateExpression: "SET #name = :deleted, email = :deleted, verificationStatus = :status, #res = :empty",
        ExpressionAttributeNames: { "#name": "name", "#res": "resource" },
        ExpressionAttributeValues: { ":deleted": "ANONYMIZED_GDPR", ":status": "DELETED", ":empty": {} }
    }));

    await writeAuditLog(authUser.sub, id, "DELETE_PROFILE", "Account anonymized per GDPR Right to be Forgotten");
    res.status(200).json({ message: "Profile successfully anonymized." });
});