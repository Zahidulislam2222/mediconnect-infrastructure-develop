import { Request, Response, NextFunction } from 'express';
import { getRegionalClient, getSecret, getSSMParameter } from '../config/aws';
import { PutCommand, QueryCommand, GetCommand, DeleteCommand, TransactWriteCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import Stripe from "stripe";
import { randomUUID } from "crypto";
import { logger } from '../../../shared/logger';
import { writeAuditLog } from '../../../shared/audit';
import { BookingPDFGenerator } from "../utils/pdf-generator";
import { google } from 'googleapis';

// 🛡️ ARCHITECTURAL PURGE: 'pg' and 'db.ts' have been completely removed.
// All data (including pricing and tokens) now securely flows through Regional DynamoDB.

interface AuthRequest extends Request {
    user?: {
        sub?: string;
        id?: string;
        email_verified?: boolean;
    };
}

const TABLE_APPOINTMENTS = process.env.TABLE_APPOINTMENTS || "mediconnect-appointments";
const TABLE_LOCKS = process.env.TABLE_LOCKS || "mediconnect-booking-locks";
const TABLE_PATIENTS = process.env.TABLE_PATIENTS || "mediconnect-patients";
const TABLE_DOCTORS = process.env.TABLE_DOCTORS || "mediconnect-doctors"; // 🟢 Replaced Postgres
const TABLE_TRANSACTIONS = process.env.TABLE_TRANSACTIONS || "mediconnect-transactions";
const TABLE_GRAPH = process.env.TABLE_GRAPH || "mediconnect-graph-data";
const STRIPE_SECRET_NAME = "/mediconnect/stripe/keys";
const CLEANUP_SECRET_PARAM = "/mediconnect/prod/cleanup/secret";

const normalizeTimeSlot = (isoString: string) => {
    if (!isoString) return new Date().toISOString();
    return isoString.split('Z')[0].split('.')[0] + "Z";
};

// Helper to handle async errors safely
const catchAsync = (fn: any) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 🟢 GDPR FIX: Strictly route DB calls to the user's legal jurisdiction
export const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

// --- CONTROLLER METHODS ---

export const createBooking = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const docClient = getRegionalClient(region);
    
    let stripeInstance: Stripe | null = null;
    let paymentIntentId: string | null = null;
    let lockKey: string | null = null;

    const {
        patientName, doctorId, doctorName, timeSlot, paymentToken,
        priority = "Low", reason = "General Checkup"
    } = req.body;

    // 🟢 SECURITY FIX: Stop trusting req.body.patientId! Hackers can spoof it.
    // Strictly use the Verified Token ID from Cognito.
    const authReq = req as AuthRequest;
    const patientId = authReq.user?.sub || authReq.user?.id;
    
    if (!patientId) {
        return res.status(401).json({ message: "Identity Spoofing Detected. Missing verified token." });
    }

    if (!timeSlot || !doctorId) {
        return res.status(400).json({ message: "Missing required booking fields" });
    }

    const normalizedTime = normalizeTimeSlot(timeSlot);
    lockKey = `${doctorId}#${normalizedTime}`;
    const transactionId = randomUUID();
    const appointmentId = randomUUID();
    const timestamp = new Date().toISOString();

    // 1. Data Enrichment (Age, Avatar)
    let patientAge = "N/A";
    let patientAvatar: string | null = null;
    try {
        const patientRes = await docClient.send(new GetCommand({ TableName: TABLE_PATIENTS, Key: { patientId } }));
        if (patientRes.Item) {
            patientAvatar = patientRes.Item.avatar || null;
            if (patientRes.Item.dob) {
                const dob = new Date(patientRes.Item.dob);
                patientAge = Math.abs(new Date(Date.now() - dob.getTime()).getUTCFullYear() - 1970).toString();
            }
        }
    } catch (e) { console.warn("Enrichment failed", e); }

    // 2. Atomic Locking (Condition: attribute_not_exists)
    try {
        await docClient.send(new PutCommand({
            TableName: TABLE_LOCKS,
            Item: {
                lockId: lockKey,
                reservedBy: patientId,
                status: "LOCKED",
                createdAt: new Date().toISOString(),
                expiresAt: Math.floor(Date.now() / 1000) + (15 * 60)
            },
            ConditionExpression: "attribute_not_exists(lockId)"
        }));
    } catch (e) {
        if (e instanceof ConditionalCheckFailedException) {
            return res.status(409).json({ message: "This time slot is already taken." });
        }
        throw e;
    }

    // 3. Payment Processing
    let amountToCharge = 5000; // Default $50.00 (in cents)

    // 🟢 SECURE PRICING LOGIC (DynamoDB instead of Postgres)
    try {
        const doctorRes = await docClient.send(new GetCommand({ TableName: TABLE_DOCTORS, Key: { doctorId } }));
        if (doctorRes.Item && doctorRes.Item.consultationFee) {
            amountToCharge = Math.round(Number(doctorRes.Item.consultationFee) * 100);
            console.log(`✅ Dynamic Price Found: $${doctorRes.Item.consultationFee} -> ${amountToCharge} cents`);
        }
    } catch (dbError) {
        console.warn("⚠️ Could not fetch dynamic price from DynamoDB, using default $50", dbError);
    } 

    const stripeKey = await getSSMParameter(STRIPE_SECRET_NAME, region, true);
    if (!stripeKey) throw new Error("Stripe secret not found");

    stripeInstance = new Stripe(stripeKey);
    try {
        const paymentIntent = await stripeInstance.paymentIntents.create({
            amount: amountToCharge,
            currency: "usd",
            payment_method: paymentToken || "pm_card_visa",
            confirm: true,
            capture_method: 'manual', // CRITICAL: Do not take money yet
            metadata: { appointmentId, doctorId, patientId, billId: transactionId, type: 'BOOKING_FEE' },
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
        });
        paymentIntentId = paymentIntent.id;
    } catch (paymentError: any) {
        console.error("Payment Failed:", paymentError.message);
        await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } }));
        return res.status(402).json({ error: "Payment Failed", details: paymentError.message });
    }

    // 🟢 FHIR R4 TRANSFORMATION: Appointment Resource
    const appointmentEnd = new Date(new Date(normalizedTime).getTime() + 30 * 60000).toISOString();
    const fhirResource = {
        resourceType: "Appointment",
        id: appointmentId,
        status: "booked",
        description: reason,
        start: normalizedTime,
        end: appointmentEnd,
        created: timestamp,
        participant: [
            { actor: { reference: `Patient/${patientId}`, display: patientName }, status: "accepted" },
            { actor: { reference: `Practitioner/${doctorId}`, display: doctorName }, status: "accepted" }
        ],
        serviceType: [{ coding: [{ code: "general", display: "General Practice" }] }]
    };

    // 4. TransactWriteItems (Atomic Commit to Regional DB)
    try {
        await docClient.send(new TransactWriteCommand({
        TransactItems: [
            {
                Put: {
                    TableName: TABLE_APPOINTMENTS,
                    Item: {
                        appointmentId, patientId, patientName, doctorId, doctorName,
                        timeSlot: normalizedTime, status: "CONFIRMED",
                        paymentStatus: "paid", paymentId: paymentIntentId,
                        createdAt: timestamp, amountPaid: amountToCharge / 100, 
                        coverageType: "NONE", priority, reason, patientAvatar, patientAge, 
                        triageStatus: "WAITING", resource: fhirResource
                    }
                }
            },
            {
                Put: {
                    TableName: TABLE_TRANSACTIONS,
                    Item: {
                        billId: transactionId, referenceId: appointmentId,
                        patientId, doctorId, type: "BOOKING_FEE",
                        amount: amountToCharge / 100, currency: "USD",
                        status: "PAID", createdAt: timestamp,
                        description: `Consultation with ${doctorName}`, paymentIntentId
                    }
                }
            },
            {
                Update: {
                    TableName: TABLE_LOCKS,
                    Key: { lockId: lockKey },
                    UpdateExpression: "SET #s = :s, appointmentId = :aid",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":s": "BOOKED", ":aid": appointmentId }
                }
            },
            {
                Put: {
                    TableName: TABLE_GRAPH,
                    Item: {
                        PK: `PATIENT#${patientId}`, SK: `DOCTOR#${doctorId}`,
                        relationship: "isTreatedBy", doctorName: doctorName,
                        lastVisit: normalizedTime, createdAt: timestamp
                    }
                }
            },
            {
                Put: {
                    TableName: TABLE_GRAPH,
                    Item: {
                        PK: `DOCTOR#${doctorId}`, SK: `PATIENT#${patientId}`,
                        relationship: "treats", patientName: patientName,
                        lastVisit: normalizedTime, createdAt: timestamp
                    }
                }
            }
        ]
        }));

        // 🟢 HIPAA AUDIT: Log with Region and IP Tracking
        await writeAuditLog(patientId, patientId, "CREATE_BOOKING", `Appointment ${appointmentId} booked`, { 
            doctorId, timeSlot: normalizedTime, region, ipAddress: req.ip 
        });

        if (stripeInstance && paymentIntentId) {
            try {
                await stripeInstance.paymentIntents.capture(paymentIntentId);
                logger.info(`Payment captured for ${appointmentId}`);
                syncToGoogleCalendar(doctorId, normalizedTime, patientName, reason, region);
            } catch (captureError) {
                logger.error("CRITICAL: DB Write Success but Payment Capture Failed", { appointmentId, paymentIntentId });
            }
        }

        res.status(200).json({
            message: "Appointment Secured", id: appointmentId,
            billId: transactionId, priority, queueStatus: "WAITING"
        });

    } catch (dbError: any) {
        console.error("Transaction Failed. Releasing Payment Hold.", dbError);
        if (stripeInstance && paymentIntentId) {
            try { await stripeInstance.paymentIntents.cancel(paymentIntentId); } catch (e) { }
        }
        if (lockKey) {
            try { await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } })); } catch (e) { }
        }
        res.status(500).json({ error: "System Error. Payment hold released." });
    }
});

export const getAppointments = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const docClient = getRegionalClient(region);
    const { doctorId, patientId } = req.query;

    if (patientId) {
        const command = new QueryCommand({
            TableName: TABLE_APPOINTMENTS,
            IndexName: "PatientIndex",
            KeyConditionExpression: "patientId = :pid",
            ExpressionAttributeValues: { ":pid": patientId },
            ScanIndexForward: false
        });
        const response = await docClient.send(command);
        return res.status(200).json({ existingBookings: response.Items || [] });
    }

    if (doctorId) {
        const bookingCommand = new QueryCommand({
            TableName: TABLE_APPOINTMENTS,
            IndexName: "DoctorIndex",
            KeyConditionExpression: "doctorId = :did",
            ExpressionAttributeValues: { ":did": doctorId },
        });
        const bookingRes = await docClient.send(bookingCommand);
        return res.status(200).json({ existingBookings: bookingRes.Items || [] });
    }

    res.status(400).json({ error: "Missing doctorId or patientId" });
});

export const cleanupAppointments = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const docClient = getRegionalClient(region);
    
    // 1. Security Check
    const secretHeader = req.headers['x-internal-secret'];
    const validSecret = await getSSMParameter(CLEANUP_SECRET_PARAM, region, true);

    if (!validSecret || secretHeader !== validSecret) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    const scanRes = await docClient.send(new ScanCommand({
        TableName: TABLE_APPOINTMENTS,
        FilterExpression: "#s = :confirmed",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":confirmed": "CONFIRMED" }
    }));

    const appointments = scanRes.Items || [];
    const now = new Date();
    const stripeKey = await getSSMParameter(STRIPE_SECRET_NAME, region, true);
    const stripe = stripeKey ? new Stripe(stripeKey) : null;
    let processed = 0;

    for (const apt of appointments) {
        if (!apt.timeSlot) continue;
        const aptTime = new Date(apt.timeSlot);
        const diffMinutes = Math.floor((now.getTime() - aptTime.getTime()) / 60000);

        if (diffMinutes >= 10 && !apt.patientArrived) {
            await cancelAppointment(apt, "CANCELLED_NO_SHOW", "FAILED", region);
            processed++;
            continue;
        }

        if (diffMinutes >= 30 && apt.patientArrived) {
            let refundId = "REFUND_FAILED";
            if (stripe && apt.paymentId && apt.paymentId !== "TEST_MODE") {
                try {
                    const refund = await stripe.refunds.create({ payment_intent: apt.paymentId });
                    refundId = refund.id;
                } catch (e) { console.error("Refund failed", e); }
            }
            await cancelAppointment(apt, "CANCELLED_DOCTOR_FAULT", refundId, region);
            processed++;
        }
    }

    res.status(200).json({ message: "Cleanup Complete", processed });
});

export const cancelBookingUser = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const docClient = getRegionalClient(region);
    
    const { appointmentId } = req.body;
    const authReq = req as AuthRequest;
    const patientId = authReq.user?.sub || authReq.user?.id;

    if (!patientId) return res.status(401).json({ message: "Unauthorized." });

    const getCmd = new GetCommand({ TableName: TABLE_APPOINTMENTS, Key: { appointmentId } });
    const aptRes = await docClient.send(getCmd);
    const apt = aptRes.Item;

    if (!apt) return res.status(404).json({ message: "Appointment not found" });
    if (apt.patientId !== patientId) return res.status(403).json({ message: "Identity mismatch." });

    // 1. Refund Logic
    let refundId = "NOT_APPLICABLE";
    if (apt.paymentId && apt.paymentId !== "TEST_MODE") {
        try {
            const stripeKey = await getSSMParameter(STRIPE_SECRET_NAME, region, true);
            if (stripeKey) {
                const stripe = new Stripe(stripeKey);
                const refund = await stripe.refunds.create({ payment_intent: apt.paymentId });
                refundId = refund.id;
            }
        } catch (e: any) {
            console.error("Stripe Refund Failed:", e.message);
            refundId = "REFUND_FAILED_MANUAL_REQUIRED";
        }
    }

    // 2. Update Appointment Status
    let updateExpression = "set #s = :s";
    const expressionAttributeValues: any = { ":s": "CANCELLED" };
    const expressionAttributeNames: any = { "#s": "status" };

    if (apt.resource) {
        updateExpression += ", #res.#rs = :cancelled";
        expressionAttributeNames["#res"] = "resource";
        expressionAttributeNames["#rs"] = "status";
        expressionAttributeValues[":cancelled"] = "cancelled";
    }

    await docClient.send(new UpdateCommand({
        TableName: TABLE_APPOINTMENTS, Key: { appointmentId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
    }));

    // 3. Delete Lock
    if (apt.doctorId && apt.timeSlot) {
        try {
            const lockKey = `${apt.doctorId}#${normalizeTimeSlot(apt.timeSlot)}`;
            await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } }));
        } catch (lockError) { console.error("Failed to release lock:", lockError); }
    }

    // 4. Audit Log
    try {
        await writeAuditLog(patientId, patientId, "CANCEL_BOOKING", `Appointment ${appointmentId} cancelled`, { 
            reason: "User requested", region, ipAddress: req.ip 
        });
    } catch (e) { console.warn("Audit log failed..."); }

    // 5. Ledger Entry
    const transactionId = randomUUID();
    await docClient.send(new PutCommand({
        TableName: TABLE_TRANSACTIONS,
        Item: {
            billId: transactionId, referenceId: appointmentId,
            patientId, doctorId: apt.doctorId || "UNKNOWN",
            type: "REFUND", amount: -(apt.amountPaid || 0),
            currency: "USD", status: "PROCESSED",
            createdAt: new Date().toISOString(), description: "User requested cancellation"
        }
    }));

    res.status(200).json({ message: "Appointment cancelled and refunded" });
});

export const updateAppointment = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const docClient = getRegionalClient(region);
    
    const { appointmentId, patientArrived, status } = req.body;

    if (!appointmentId) return res.status(400).json({ message: "Missing appointmentId" });

    let updateExpression = "set lastUpdated = :now";
    const expressionAttributeValues: any = { ":now": new Date().toISOString() };
    const expressionAttributeNames: any = {};

    if (patientArrived !== undefined) {
        updateExpression += ", patientArrived = :pa";
        expressionAttributeValues[":pa"] = patientArrived;
    }

    if (status) {
        updateExpression += ", #s = :s";
        expressionAttributeNames["#s"] = "status";
        expressionAttributeValues[":s"] = status;
    }

    await docClient.send(new UpdateCommand({
        TableName: TABLE_APPOINTMENTS, Key: { appointmentId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
        ExpressionAttributeValues: expressionAttributeValues
    }));

    res.status(200).json({ message: "Appointment updated successfully" });
});

// Helper Function
async function cancelAppointment(apt: any, newStatus: string, refundId: string, region: string) {
    const docClient = getRegionalClient(region);
    try {
        let updateExpression = "set #s = :s, refundId = :r, lastUpdated = :now";
        const expressionAttributeValues: any = { ":s": newStatus, ":r": refundId, ":now": new Date().toISOString() };
        const expressionAttributeNames: any = { "#s": "status" };

        if (apt.resource) {
            updateExpression += ", #res.#rs = :cancelled";
            expressionAttributeNames["#res"] = "resource";
            expressionAttributeNames["#rs"] = "status";
            expressionAttributeValues[":cancelled"] = "cancelled";
        }

        await docClient.send(new UpdateCommand({
            TableName: TABLE_APPOINTMENTS, Key: { appointmentId: apt.appointmentId },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));

        if (apt.doctorId && apt.timeSlot) {
            const lockKey = `${apt.doctorId}#${normalizeTimeSlot(apt.timeSlot)}`;
            await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } }));
        }
    } catch (e) { console.error("Cancel update failed", e); }
}

export const getReceipt = catchAsync(async (req: Request, res: Response) => {
    const region = extractRegion(req);
    const docClient = getRegionalClient(region);
    
    const { appointmentId } = req.params;
    const authReq = req as AuthRequest;
    const userId = authReq.user?.sub || authReq.user?.id;

    const getCmd = new GetCommand({ TableName: TABLE_APPOINTMENTS, Key: { appointmentId } });
    const result = await docClient.send(getCmd);
    const apt = result.Item;

    if (!apt) return res.status(404).json({ message: "Appointment not found" });
    if (apt.patientId !== userId) return res.status(403).json({ message: "Unauthorized" });

    const isCancelled = apt.status.includes("CANCELLED");

    const generator = new BookingPDFGenerator();
    const url = await generator.generateReceipt({
        appointmentId: apt.appointmentId,
        billId: apt.paymentId || "N/A", patientName: apt.patientName,
        doctorName: apt.doctorName, amount: apt.amountPaid || 50,
        date: apt.timeSlot,
        status: isCancelled ? "REFUNDED" : "PAID",
        type: isCancelled ? "REFUND" : "BOOKING"
    });

    res.status(200).json({ downloadUrl: url });
});

// 🟢 NEW HELPER: Sync to Google Calendar (DynamoDB Migrated)
async function syncToGoogleCalendar(doctorId: string, timeSlot: string, patientName: string, reason: string, region: string) {
    try {
        const docClient = getRegionalClient(region);
        
        // 🟢 PURGED POSTGRES: Now securely fetching the OAuth token from DynamoDB
        const res = await docClient.send(new GetCommand({ 
            TableName: TABLE_DOCTORS, 
            Key: { doctorId },
            ProjectionExpression: "googleRefreshToken"
        }));
        
        const refreshToken = res.Item?.googleRefreshToken;

        if (!refreshToken) {
            console.log(`[Calendar] No Google Token found for doctor ${doctorId}`);
            return;
        }

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        const startTime = new Date(timeSlot);
        const endTime = new Date(startTime.getTime() + 30 * 60000); 

        await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
                summary: `Consultation: ${patientName}`,
                description: `Reason: ${reason}\n\nManaged by MediConnect`,
                start: { dateTime: startTime.toISOString() },
                end: { dateTime: endTime.toISOString() },
                reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }
            }
        });

        console.log(`[Calendar] Event created for ${doctorId}`);

    } catch (error: any) {
        console.error("[Calendar Sync Failed]:", error.message);
    }
}