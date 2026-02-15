import { Request, Response } from 'express';
import { docClient, getSecret, getSSMParameter } from '../config/aws';
import { PutCommand, QueryCommand, GetCommand, DeleteCommand, TransactWriteCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import Stripe from "stripe";
import { randomUUID } from "crypto";
import { logger } from '../../../shared/logger';
import { writeAuditLog } from '../../../shared/audit';
import { BookingPDFGenerator } from "../utils/pdf-generator";
import { google } from 'googleapis';
// REMOVE: import { Client } from 'pg'; 
import { query } from '../config/db';

interface AuthRequest extends Request {
    user?: {
        sub: string;
        email_verified?: boolean;
        // add other properties if needed
    };
}

const TABLE_APPOINTMENTS = "mediconnect-appointments";
const TABLE_LOCKS = "mediconnect-booking-locks";
const TABLE_PATIENTS = "mediconnect-patients";
const TABLE_TRANSACTIONS = "mediconnect-transactions";
const TABLE_SCHEDULES = "mediconnect-doctor-schedules";
const STRIPE_SECRET_NAME = "/mediconnect/stripe/keys";
const CLEANUP_SECRET_PARAM = "/mediconnect/prod/cleanup/secret";
const TABLE_GRAPH = "mediconnect-graph-data"; // 🟢 Added for Care Network

const normalizeTimeSlot = (isoString: string) => {
    if (!isoString) return new Date().toISOString();
    return isoString.split('Z')[0].split('.')[0] + "Z";
};

// --- CONTROLLER METHODS ---

export const createBooking = async (req: Request, res: Response) => {
    let stripeInstance: Stripe | null = null;
    let paymentIntentId: string | null = null;
    let lockKey: string | null = null;

    try {
        const {
            patientId, patientName, doctorId, doctorName, timeSlot, paymentToken,
            priority = "Low", reason = "General Checkup"
        } = req.body;

        // [REPLACE THE ERROR LINE WITH THIS]
        const authReq = req as AuthRequest;
        if (authReq.user && authReq.user.sub !== patientId) {
            return res.status(403).json({ message: "Identity Spoofing Detected." });
        }

        if (!timeSlot || !patientId || !doctorId) {
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
            const patientRes = await docClient.send(new GetCommand({ TableName: TABLE_PATIENTS, Key: { userId: patientId } }));
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
        // 🟢 SECURE PRICING LOGIC (Admin Controlled)

        let amountToCharge = 5000; // Default $50.00 (in cents)

        // ✅ NEW LOGIC: Use shared pool (No 'new Client', no 'connect', no 'end')
        try {
            const priceRes = await query(
                "SELECT data->>'consultationFee' as fee FROM doctors WHERE id = $1", 
                [doctorId]
            );
            
            if (priceRes.rows.length > 0) {
                const rawFee = priceRes.rows[0].fee;
                if (rawFee) {
                    // Convert "80" -> 8000
                    amountToCharge = Math.round(Number(rawFee) * 100);
                    console.log(`✅ Dynamic Price Found: $${rawFee} -> ${amountToCharge} cents`);
                }
            }
        } catch (dbError) {
            console.warn("⚠️ Could not fetch dynamic price, using default $50", dbError);
            // We continue with default price to not block service
        } 

        const stripeKey = await getSSMParameter(STRIPE_SECRET_NAME, true);
        if (!stripeKey) throw new Error("Stripe secret not found");

        stripeInstance = new Stripe(stripeKey);
        try {
            const paymentIntent = await stripeInstance.paymentIntents.create({
                amount: amountToCharge,
                currency: "usd",
                payment_method: paymentToken || "pm_card_visa",
                confirm: true, // This confirms the card is valid
                capture_method: 'manual', // <--- CRITICAL: Do not take money yet
                metadata: {
                    appointmentId,
                    doctorId,
                    patientId,
                    billId: transactionId,
                    type: 'BOOKING_FEE' // Added for Webhook clarity
                },
                automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
            });
            paymentIntentId = paymentIntent.id;
        } catch (paymentError: any) {
            console.error("Payment Failed:", paymentError.message);
            // Release lock
            await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } }));
            return res.status(402).json({ error: "Payment Failed", details: paymentError.message });
        }

        // 🟢 FHIR TRANSFORMATION: Appointment (R4)
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

        // 4. TransactWriteItems (Atomic Commit)

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
                            createdAt: timestamp,
                            
                            // 🟢 MAKE SURE THIS USES 'amountToCharge'
                            amountPaid: amountToCharge / 100, 
                            
                            coverageType: "NONE",
                            priority, reason, patientAvatar, patientAge, triageStatus: "WAITING",
                            resource: fhirResource
                        }
                    }
                },
                {
                    Put: {
                        TableName: TABLE_TRANSACTIONS,
                        Item: {
                            billId: transactionId, referenceId: appointmentId,
                            patientId, doctorId, type: "BOOKING_FEE",
                            
                            amount: amountToCharge / 100, 
                            
                            currency: "USD",
                            status: "PAID", createdAt: timestamp,
                            description: `Consultation with ${doctorName}`,
                            paymentIntentId: paymentIntentId
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
                    // 🟢 NEW: Automatic Graph Link (Patient -> Doctor)
                    {
                        Put: {
                            TableName: TABLE_GRAPH,
                            Item: {
                                PK: `PATIENT#${patientId}`,
                                SK: `DOCTOR#${doctorId}`,
                                relationship: "isTreatedBy",
                                doctorName: doctorName,
                                lastVisit: normalizedTime,
                                createdAt: timestamp
                            }
                        }
                    },
                    // 🟢 NEW: Automatic Graph Link (Doctor -> Patient)
                    {
                        Put: {
                            TableName: TABLE_GRAPH,
                            Item: {
                                PK: `DOCTOR#${doctorId}`,
                                SK: `PATIENT#${patientId}`,
                                relationship: "treats",
                                patientName: patientName,
                                lastVisit: normalizedTime,
                                createdAt: timestamp
                            }
                        }
                    }
                ]
            }));

            // 🟢 AUDIT LOG
            await writeAuditLog(patientId, patientId, "CREATE_BOOKING", `Appointment ${appointmentId} booked`, { doctorId, timeSlot: normalizedTime });

            if (stripeInstance && paymentIntentId) {
                try {
                    await stripeInstance.paymentIntents.capture(paymentIntentId);
                    logger.info(`Payment captured for ${appointmentId}`);
                    syncToGoogleCalendar(doctorId, normalizedTime, patientName, reason);
                } catch (captureError) {
                    // Very rare edge case: DB wrote, but Capture failed (e.g., Stripe down).
                    // In a real prod env, you would log this to a "Manual Review" queue.
                    logger.error("CRITICAL: DB Write Success but Payment Capture Failed", { appointmentId, paymentIntentId });
                }
            }

            res.status(200).json({
                message: "Appointment Secured",
                id: appointmentId,
                billId: transactionId,
                priority,
                queueStatus: "WAITING"
            });

        } catch (dbError: any) {
            console.error("Transaction Failed. Releasing Payment Hold.", dbError);

            // --- START CHANGE: Cancel/Void Authorization ---
            if (stripeInstance && paymentIntentId) {
                try {
                    // .cancel() releases the hold instantly. Much better than .refund()
                    await stripeInstance.paymentIntents.cancel(paymentIntentId);
                    logger.info(`Payment hold released for ${paymentIntentId}`);
                } catch (e) {
                    console.error("Cancel failed:", e);
                }
            }
            // --- END CHANGE ---

            // Release Lock
            try { await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } })); } catch (e) { }

            res.status(500).json({ error: "System Error. Payment hold released." });
        }

    } catch (error: any) {
        logger.error("Booking System Crash", { error });
        // If lock was acquired but code crashed before transaction?
        // The transaction is atomic, so if it failed, nothing happened to DB.
        // But we acquired lock in step 2.
        if (lockKey) {
            try { await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } })); } catch (e) { }
        }
        res.status(500).json({ error: error.message });
    }
};

export const getAppointments = async (req: Request, res: Response) => {
    try {
        const { doctorId, patientId } = req.query;

        // 1. Fetch for Patient
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

        // 2. Fetch for Doctor (Only returns Bookings now)
        if (doctorId) {
            const bookingCommand = new QueryCommand({
                TableName: TABLE_APPOINTMENTS,
                IndexName: "DoctorIndex",
                KeyConditionExpression: "doctorId = :did",
                ExpressionAttributeValues: { ":did": doctorId },
            });

            const bookingRes = await docClient.send(bookingCommand);

            // 🟢 FIX: Remove scheduleCommand. Schedule now comes from Doctor Service.
            return res.status(200).json({
                existingBookings: bookingRes.Items || []
            });
        }

        res.status(400).json({ error: "Missing doctorId or patientId" });
    } catch (error: any) {
        console.error("GetAppointments Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

export const cleanupAppointments = async (req: Request, res: Response) => {
    try {
        // 1. Security Check
        const secretHeader = req.headers['x-internal-secret'];
        const validSecret = await getSSMParameter(CLEANUP_SECRET_PARAM, true); // True = Decrypt

        if (!validSecret || secretHeader !== validSecret) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        // 2. Scan (as per legacy)
        const scanRes = await docClient.send(new ScanCommand({
            TableName: TABLE_APPOINTMENTS,
            FilterExpression: "#s = :confirmed",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":confirmed": "CONFIRMED" }
        }));

        const appointments = scanRes.Items || [];
        const now = new Date();
        const stripeKey = await getSSMParameter(STRIPE_SECRET_NAME, true)
        const stripe = stripeKey ? new Stripe(stripeKey) : null;
        let processed = 0;

        for (const apt of appointments) {
            if (!apt.timeSlot) continue;
            const aptTime = new Date(apt.timeSlot);
            const diffMinutes = Math.floor((now.getTime() - aptTime.getTime()) / 60000);

            // Rule 1: Patient No-Show (10m)
            if (diffMinutes >= 10 && !apt.patientArrived) {
                // Cancel, No Refund
                await cancelAppointment(apt, "CANCELLED_NO_SHOW", "FAILED");
                processed++;
                continue;
            }

            // Rule 2: Doctor No-Show (30m)
            if (diffMinutes >= 30 && apt.patientArrived) {
                // Refund
                let refundId = "REFUND_FAILED";
                if (stripe && apt.paymentId && apt.paymentId !== "TEST_MODE") {
                    try {
                        const refund = await stripe.refunds.create({ payment_intent: apt.paymentId });
                        refundId = refund.id;
                    } catch (e) { console.error("Refund failed", e); }
                }
                await cancelAppointment(apt, "CANCELLED_DOCTOR_FAULT", refundId);
                processed++;
            }
        }

        res.status(200).json({ message: "Cleanup Complete", processed });

    } catch (error: any) {
        console.error("Cleanup Error:", error);
        res.status(500).json({ error: error.message });
    }
};

export const cancelBookingUser = async (req: Request, res: Response) => {
    try {
        const { appointmentId, patientId } = req.body;
        const authReq = req as AuthRequest;

        if (authReq.user && authReq.user.sub !== patientId) {
            return res.status(403).json({ message: "Identity mismatch." });
        }

        const getCmd = new GetCommand({
            TableName: TABLE_APPOINTMENTS,
            Key: { appointmentId }
        });
        const aptRes = await docClient.send(getCmd);
        const apt = aptRes.Item;

        if (!apt) return res.status(404).json({ message: "Appointment not found" });

        // 1. Refund Logic
        let refundId = "NOT_APPLICABLE";
        if (apt.paymentId && apt.paymentId !== "TEST_MODE") {
            try {
                const stripeKey = await getSSMParameter(STRIPE_SECRET_NAME, true);
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
            TableName: TABLE_APPOINTMENTS,
            Key: { appointmentId },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));

        // ---------------------------------------------------------
        // 🟢 FIX: DELETE THE LOCK SO THE SLOT OPENS UP
        // ---------------------------------------------------------
        if (apt.doctorId && apt.timeSlot) {
            try {
                // Ensure helper function 'normalizeTimeSlot' is available in this file
                const lockKey = `${apt.doctorId}#${normalizeTimeSlot(apt.timeSlot)}`;
                
                await docClient.send(new DeleteCommand({
                    TableName: TABLE_LOCKS,
                    Key: { lockId: lockKey }
                }));
                console.log(`🔓 Lock released for ${lockKey}`);
            } catch (lockError) {
                console.error("Failed to release lock:", lockError);
            }
        }
        // ---------------------------------------------------------

        // 3. Audit Log
        try {
            await writeAuditLog(patientId, patientId, "CANCEL_BOOKING", `Appointment ${appointmentId} cancelled`, { reason: "User requested" });
        } catch (e) { console.warn("Audit log failed but continuing..."); }

        // 4. Ledger Entry (Refund Transaction)
        const transactionId = randomUUID();
        await docClient.send(new PutCommand({
            TableName: TABLE_TRANSACTIONS,
            Item: {
                billId: transactionId,
                referenceId: appointmentId,
                patientId,
                doctorId: apt.doctorId || "UNKNOWN",
                type: "REFUND",
                amount: -(apt.amountPaid || 0),
                currency: "USD",
                status: "PROCESSED",
                createdAt: new Date().toISOString(),
                description: "User requested cancellation"
            }
        }));

        res.status(200).json({ message: "Appointment cancelled and refunded" });

    } catch (error: any) {
        console.error("Cancel Error (Full Trace):", error);
        res.status(500).json({ error: error.message });
    }
};

// REPLACE 'checkInPatient' (bottom of file) with this:

export const updateAppointment = async (req: Request, res: Response) => {
    try {
        const { appointmentId, patientArrived, status } = req.body;

        if (!appointmentId) {
            return res.status(400).json({ message: "Missing appointmentId" });
        }

        // 🛡️ SECURITY: Request must be authenticated (handled by authMiddleware)
        // If req.user is missing, authMiddleware would have blocked it.

        // Build Dynamic Update for DynamoDB (Atomic Operation)
        let updateExpression = "set lastUpdated = :now";
        const expressionAttributeValues: any = { ":now": new Date().toISOString() };
        const expressionAttributeNames: any = {};

        // 1. Handle Patient Check-In
        if (patientArrived !== undefined) {
            updateExpression += ", patientArrived = :pa";
            expressionAttributeValues[":pa"] = patientArrived;
        }

        // 2. Handle Queue Status (Doctor Actions: IN_PROGRESS, COMPLETED)
        if (status) {
            updateExpression += ", #s = :s";
            expressionAttributeNames["#s"] = "status";
            expressionAttributeValues[":s"] = status;
        }

        await docClient.send(new UpdateCommand({
            TableName: TABLE_APPOINTMENTS,
            Key: { appointmentId },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
            ExpressionAttributeValues: expressionAttributeValues
        }));

        res.status(200).json({ message: "Appointment updated successfully" });

    } catch (error: any) {
        console.error("Update Error:", error);
        res.status(500).json({ error: error.message });
    }
};

// ↓↓↓ REPLACE THE EXISTING 'cancelAppointment' FUNCTION AT THE BOTTOM OF THE FILE ↓↓↓

async function cancelAppointment(apt: any, newStatus: string, refundId: string) {
    try {
        // 1. Prepare Update Logic (Legacy + FHIR)
        let updateExpression = "set #s = :s, refundId = :r, lastUpdated = :now";
        const expressionAttributeValues: any = {
            ":s": newStatus,
            ":r": refundId,
            ":now": new Date().toISOString()
        };
        const expressionAttributeNames: any = { "#s": "status" };

        // 🟢 FHIR R4 FIX: Also update the 'resource' object if it exists
        // This ensures the FHIR data matches the legacy status
        if (apt.resource) {
            updateExpression += ", #res.#rs = :cancelled";
            expressionAttributeNames["#res"] = "resource";
            expressionAttributeNames["#rs"] = "status";
            expressionAttributeValues[":cancelled"] = "cancelled";
        }

        // 2. Execute Atomic Update
        await docClient.send(new UpdateCommand({
            TableName: TABLE_APPOINTMENTS,
            Key: { appointmentId: apt.appointmentId },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));

        // 3. Release the Time Slot Lock
        if (apt.doctorId && apt.timeSlot) {
            const lockKey = `${apt.doctorId}#${normalizeTimeSlot(apt.timeSlot)}`;
            await docClient.send(new DeleteCommand({
                TableName: TABLE_LOCKS,
                Key: { lockId: lockKey }
            }));
            console.log(`🔓 Lock released for ${lockKey}`);
        }
    } catch (e) {
        console.error("Cancel update failed", e);
    }
}


export const getReceipt = async (req: Request, res: Response) => {
    try {
        const { appointmentId } = req.params;
        const userId = (req as any).user.sub;

        const getCmd = new GetCommand({
            TableName: TABLE_APPOINTMENTS,
            Key: { appointmentId }
        });
        const result = await docClient.send(getCmd);
        const apt = result.Item;

        if (!apt) return res.status(404).json({ message: "Appointment not found" });
        if (apt.patientId !== userId) return res.status(403).json({ message: "Unauthorized" });

        // 🟢 LOGICAL FIX: Determine type and status based on database state
        const isCancelled = apt.status.includes("CANCELLED");

        const generator = new BookingPDFGenerator();
        const url = await generator.generateReceipt({
            appointmentId: apt.appointmentId,
            billId: apt.paymentId || "N/A",
            patientName: apt.patientName,
            doctorName: apt.doctorName,
            amount: apt.amountPaid || 50,
            date: apt.timeSlot,
            // If cancelled, show REFUNDED, else show PAID
            status: isCancelled ? "REFUNDED" : "PAID",
            // If cancelled, use REFUND theme, else use BOOKING theme
            type: isCancelled ? "REFUND" : "BOOKING"
        });

        res.status(200).json({ downloadUrl: url });

    } catch (error: any) {
        console.error("Receipt Generation Error:", error);
        res.status(500).json({ error: "Could not generate receipt" });
    }
};

// 🟢 NEW HELPER: Sync to Google Calendar
// This reads the Doctor's token from Postgres (GCP) and pushes to Google
async function syncToGoogleCalendar(doctorId: string, timeSlot: string, patientName: string, reason: string) {
    try {
        // 1. Get Refresh Token (Using shared pool)
        const res = await query("SELECT data->>'googleRefreshToken' as token FROM doctors WHERE id = $1", [doctorId]);
        
        // Safety check: if no rows returned
        if (!res.rows || res.rows.length === 0) {
             console.log(`[Calendar] Doctor ${doctorId} not found in SQL`);
             return;
        }

        const refreshToken = res.rows[0]?.token;

        if (!refreshToken) {
            console.log(`[Calendar] No Google Token found for doctor ${doctorId}`);
            return;
        }

        // 2. Authenticate Google Client
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        // 3. Create Event
        const startTime = new Date(timeSlot);
        const endTime = new Date(startTime.getTime() + 30 * 60000); // 30 mins duration

        await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
                summary: `Consultation: ${patientName}`,
                description: `Reason: ${reason}\n\nManaged by MediConnect`,
                start: { dateTime: startTime.toISOString() },
                end: { dateTime: endTime.toISOString() },
                reminders: {
                    useDefault: false,
                    overrides: [{ method: 'popup', minutes: 10 }]
                }
            }
        });

        console.log(`[Calendar] Event created for ${doctorId}`);

    } catch (error: any) {
        console.error("[Calendar Sync Failed]:", error.message);
    }
}