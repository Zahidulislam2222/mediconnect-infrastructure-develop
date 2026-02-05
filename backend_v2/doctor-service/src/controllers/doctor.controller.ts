import { NextFunction, Request, Response } from 'express';
import { query } from '../config/db';
import { generatePresignedUrl } from '../utils/s3';
import { TextractClient, DetectDocumentTextCommand, Block } from "@aws-sdk/client-textract";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const textract = new TextractClient({ region: process.env.AWS_REGION || "us-east-1" });
const sns = new SNSClient({ region: process.env.AWS_REGION || "us-east-1" });
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

    // 1. Check for duplicate (Check inside the JSONB data column or via id)
    const existing = await query('SELECT 1 FROM doctors WHERE id = $1', [finalDoctorId]);
    if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Doctor already registered' });
    }

    // 2. Prepare JSON metadata for the 'data' column
    const finalRole = role === 'provider' ? 'doctor' : (role || 'doctor');
    const metadata = {
        email,
        role: finalRole,
        licenseNumber: licenseNumber || 'PENDING_VERIFICATION',
        verificationStatus: 'UNVERIFIED',
        isEmailVerified: false,
        createdAt: new Date()
    };

    // 3. Insert into actual discovered columns: id, name, specialization, data
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
    const { id } = req.params;

    // Fixed: Using 'id' column instead of 'doctor_id'
    const result = await query('SELECT * FROM doctors WHERE id = $1', [id]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Doctor not found' });
    }

    const doctor = result.rows[0];

    // Merge JSONB data into the root object for frontend compatibility
    if (doctor.data) {
        Object.assign(doctor, doctor.data);
    }

    // Sign avatar URL if present
    if (doctor.avatar && !doctor.avatar.startsWith('http')) {
        const bucket = 'mediconnect-identity-verification';
        doctor.avatar = await generatePresignedUrl(bucket, doctor.avatar);
    }

    res.status(200).json(doctor);
});

export const updateDoctor = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const updates = req.body;

    // Logic: Update top-level columns (name, specialization) 
    // and merge everything else into the 'data' jsonb column
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

    // Merge other updates into the JSONB 'data' column
    updateQuery += `data = data || $${idx}::jsonb WHERE id = $${idx + 1} RETURNING *`;
    values.push(JSON.stringify(dataFields));
    values.push(id);

    const result = await query(updateQuery, values);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Doctor not found' });
    }

    res.status(200).json({ message: 'Profile updated successfully', doctor: result.rows[0] });
});

export const getSchedule = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    // Fixed: Using 'id'
    const result = await query('SELECT * FROM doctor_schedules WHERE id = $1', [id]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Schedule not found' });
    }

    res.status(200).json(result.rows[0]);
});

export const updateSchedule = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { schedule, timezone } = req.body;

    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
        return res.status(400).json({ error: 'Invalid schedule format. Must be a JSON object.' });
    }

    const finalTimezone = timezone || 'UTC';

    // Fixed: Using 'id' and handling conflict on 'id'
    const text = `
        INSERT INTO doctor_schedules (id, schedule, timezone, last_updated)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (id) 
        DO UPDATE SET schedule = $2, timezone = $3, last_updated = NOW()
        RETURNING *
    `;

    const result = await query(text, [id, JSON.stringify(schedule), finalTimezone]);

    res.status(200).json({ message: 'Schedule updated', schedule: result.rows[0] });
});

export const verifyDiploma = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { s3Key, bucketName } = req.body;

    if (!s3Key || !bucketName) {
        return res.status(400).json({ error: "Missing s3Key or bucketName" });
    }

    const command = new DetectDocumentTextCommand({
        Document: { S3Object: { Bucket: bucketName, Name: s3Key } }
    });

    let fullText = "";
    try {
        const response = await textract.send(command);
        if (response.Blocks) {
            fullText = response.Blocks
                .filter((b: Block) => b.BlockType === 'LINE')
                .map((b: Block) => b.Text)
                .join(" ");
        }
    } catch (e: any) {
        return res.status(500).json({ error: "Diploma Scan Failed", details: e.message });
    }

    const keywords = ["Doctor", "Medicine", "License", "Board", "MD", "Surgeon", "Medical", "Surgery", "Degree", "Diploma"];
    const lowerText = fullText.toLowerCase();
    const passed = keywords.some(k => lowerText.includes(k.toLowerCase()));

    const status = passed ? "PENDING_REVIEW" : "REJECTED_AUTO";
    const diplomaUrl = `s3://${bucketName}/${s3Key}`;

    // Update 'data' column using JSONB merge operator (||)
    const updateText = `
        UPDATE doctors 
        SET data = data || jsonb_build_object(
            'isDiplomaAutoVerified', $1::boolean,
            'verificationStatus', $2::text,
            'diplomaUrl', $3::text
        )
        WHERE id = $4
        RETURNING *
    `;

    await query(updateText, [passed, status, diplomaUrl, id]);

    if (passed) {
        await sns.send(new PublishCommand({
            TopicArn: SNS_TOPIC_ARN,
            Message: `ACTION REQUIRED: Doctor ${id} has uploaded a diploma. AI Check Passed.`,
            Subject: "New Doctor Credential Review"
        }));
    }

    res.json({
        verified: passed,
        status,
        message: passed ? "Diploma Verified by AI. Pending Admin Approval." : "Diploma Validation Failed."
    });
});