import { NextFunction, Request, Response } from 'express';
import { query, pool as pgPool } from '../config/db';
import { generatePresignedUrl } from '../utils/s3';
import { TextractClient, AnalyzeDocumentCommand } from "@aws-sdk/client-textract";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { google } from 'googleapis';

const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
};

const textract = new TextractClient({ region: process.env.AWS_REGION, credentials });
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI // e.g., http://localhost:8082/doctors/auth/google/callback
);
const sns = new SNSClient({ region: process.env.AWS_REGION, credentials });
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN || "arn:aws:sns:us-east-1:950110266426:mediconnect-ops-alerts";

// Helper to handle async errors
const catchAsync = (fn: any) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

export const createDoctor = catchAsync(async (req: Request, res: Response) => {
    const { doctorId, userId, email, name, specialization, licenseNumber, role } = req.body;
    const finalDoctorId = doctorId || userId;

    if (!finalDoctorId || !email) {
        return res.status(400).json({ error: 'Missing userId or email' });
    }

    // 1. Check for duplicate
    const existing = await query('SELECT 1 FROM doctors WHERE id = $1', [finalDoctorId]);
    if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Doctor already registered' });
    }

    // 2. Prepare JSON metadata
    const finalRole = role === 'provider' ? 'doctor' : (role || 'doctor');
    const metadata = {
        email,
        role: finalRole,
        licenseNumber: licenseNumber || 'PENDING_VERIFICATION',
        verificationStatus: 'UNVERIFIED',
        isEmailVerified: false,
        createdAt: new Date()
    };

    // 3. Insert
    const text = `
        INSERT INTO doctors (id, name, specialization, data)
        VALUES ($1, $2, $3, $4)
        RETURNING *
    `;

    const result = await query(text, [
        finalDoctorId,
        name,
        specialization || 'General Practice',
        JSON.stringify(metadata)
    ]);

    res.status(201).json({ message: 'Doctor profile created successfully', doctor: result.rows[0] });
});

export const getDoctor = catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id || req.query.id;

    if (!id) {
        return res.status(400).json({ error: 'Missing Doctor ID' });
    }

    const result = await query('SELECT * FROM doctors WHERE id = $1', [id]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Doctor not found' });
    }

    const doctor = result.rows[0];
    doctor.doctorId = doctor.id;

    if (doctor.data) {
        Object.assign(doctor, doctor.data);
    }

    if (doctor.avatar && !doctor.avatar.startsWith('http')) {
        const bucket = 'mediconnect-identity-verification';
        doctor.avatar = await generatePresignedUrl(bucket, doctor.avatar);
    }

    res.status(200).json(doctor);
});

export const updateDoctor = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const updates = req.body;

    const topLevelFields = ['name', 'specialization'];
    const dataFields: any = {};

    let updateQuery = 'UPDATE doctors SET ';
    const values = [];
    let idx = 1;

    for (const key in updates) {
        if (topLevelFields.includes(key)) {
            updateQuery += `${key} = $${idx}, `;
            values.push(updates[key]);
            idx++;
        } else {
            dataFields[key] = updates[key];
        }
    }

    updateQuery += `data = data || $${idx}::jsonb WHERE id = $${idx + 1} RETURNING *`;
    values.push(JSON.stringify(dataFields));
    values.push(id);

    const result = await query(updateQuery, values);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Doctor not found' });
    }

    res.status(200).json({ message: 'Profile updated successfully', doctor: result.rows[0] });
});

// 🟢 FIX 1: Read Schedule from the 'doctors' table (JSONB column)
// This replaces the old logic that looked for a separate table
export const getSchedule = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;

    // We fetch the 'data' column where the schedule lives inside
    const result = await query("SELECT data FROM doctors WHERE id = $1", [id]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Doctor not found' });
    }

    const doctorData = result.rows[0].data || {};

    res.status(200).json({
        id: id,
        // Cast to any to prevent TS Error 2339 if types are strict
        schedule: (doctorData as any).schedule || {},
        timezone: (doctorData as any).timezone || 'UTC'
    });
});

// 🟢 FIX 2: Write Schedule into the 'doctors' table (JSONB column)
// This ensures that when you click 'Save', it updates the correct place
export const updateSchedule = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { schedule, timezone } = req.body;

    if (!schedule || typeof schedule !== 'object') {
        return res.status(400).json({ error: 'Invalid schedule format.' });
    }

    const finalTimezone = timezone || 'UTC';

    // We use Postgres JSONB concatenation (||) to merge the new schedule into existing data
    const text = `
        UPDATE doctors 
        SET data = data || jsonb_build_object('schedule', $1::jsonb, 'timezone', $2::text)
        WHERE id = $3
        RETURNING *
    `;

    const result = await query(text, [JSON.stringify(schedule), finalTimezone, id]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Doctor not found' });
    }

    res.status(200).json({
        message: 'Schedule updated successfully',
        schedule: (result.rows[0].data as any).schedule
    });
});

export const verifyDiploma = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { s3Key, bucketName, expectedName } = req.body;

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
        const response = await textract.send(command);

        // Fuzzy check name
        const fullOcrText = response.Blocks?.filter(b => b.BlockType === 'LINE').map(b => b.Text).join(" ") || "";
        const nameMatched = fullOcrText.toLowerCase().includes(expectedName.toLowerCase().split(' ')[0]);

        const medicalKeywords = ["Doctor", "Medicine", "Surgeon", "Medical", "Physician", "MD", "License"];
        const hasMedicalContext = medicalKeywords.some(k => fullOcrText.includes(k));

        const isLegit = nameMatched && hasMedicalContext;
        const status = isLegit ? "PENDING_OFFICER_APPROVAL" : "REJECTED_AUTO";

        const updateText = `
            UPDATE doctors 
            SET data = data || jsonb_build_object(
                'isDiplomaAutoVerified', $1::boolean,
                'verificationStatus', $2::text,
                'aiExtractedText', $3::text,
                'diplomaUrl', $4::text
            )
            WHERE id = $5
        `;
        await query(updateText, [isLegit, status, fullOcrText.substring(0, 500), `s3://${bucketName}/${s3Key}`, id]);

        if (isLegit) {
            await sns.send(new PublishCommand({
                TopicArn: SNS_TOPIC_ARN,
                Message: `STRICT VERIFICATION: Doctor ${expectedName} (ID: ${id}) uploaded a diploma. AI Confidence: HIGH. Match: ${nameMatched}`,
                Subject: "Doctor Credential Alert"
            }));
        }

        return res.json({
            verified: isLegit,
            status,
            message: isLegit ? "AI Verification Successful." : "AI could not match your name to this document."
        });

    } catch (e: any) {
        console.error("Textract Error:", e);
        return res.status(500).json({ error: "AI Processing Failed" });
    }
});

export const getDoctors = async (req: Request, res: Response) => {
    try {

        const result = await pgPool!.query(
            `SELECT 
                id as "doctorId", 
                name, 
                specialization, 
                data->>'avatar' as avatar,
                COALESCE((data->>'consultationFee')::int, 50) as "consultationFee"
             FROM doctors`
        );
        res.status(200).json({ doctors: result.rows });
    } catch (error: any) {
        console.error("Fetch Doctors Error:", error.message);
        res.status(500).json({ error: "Could not fetch doctor directory" });
    }
};

// 🟢 ADD THESE FUNCTIONS AT THE END OF FILE

export const getCalendarStatus = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const result = await query("SELECT data->>'googleRefreshToken' as token FROM doctors WHERE id = $1", [id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Doctor not found' });

    res.json({ connected: !!result.rows[0].token });
});

export const connectGoogleCalendar = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.query; // Pass doctor ID in query to persist state
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Critical for refresh token
        scope: ['https://www.googleapis.com/auth/calendar'],
        state: id as string
    });
    res.json({ url });
});

export const googleCallback = catchAsync(async (req: Request, res: Response) => {
    const { code, state } = req.query; // 'state' is the doctorId we passed earlier

    if (!code || !state) return res.status(400).json({ error: "Invalid callback data" });

    const { tokens } = await oauth2Client.getToken(code as string);

    if (tokens.refresh_token) {
        // Store refresh token in JSONB column
        const updateText = `
            UPDATE doctors 
            SET data = data || jsonb_build_object('googleRefreshToken', $1::text)
            WHERE id = $2
        `;
        await query(updateText, [tokens.refresh_token, state]);
    }

    // Redirect back to frontend settings
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?calendar=connected`);
});

export const disconnectGoogleCalendar = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;

    // Remove token from JSONB
    const updateText = `
        UPDATE doctors 
        SET data = data - 'googleRefreshToken'
        WHERE id = $1
    `;
    await query(updateText, [id]);

    res.json({ connected: false, message: "Calendar disconnected" });
});