import { Request, Response } from 'express';
import { docClient, getSecret, getSSMParameter } from '../config/aws';
import { PutCommand, QueryCommand, GetCommand, DeleteCommand, TransactWriteCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import Stripe from "stripe";
import { randomUUID } from "crypto";

const TABLE_APPOINTMENTS = "mediconnect-appointments";
const TABLE_LOCKS = "mediconnect-booking-locks";
const TABLE_PATIENTS = "mediconnect-patients";
const TABLE_TRANSACTIONS = "mediconnect-transactions";
const TABLE_SCHEDULES = "mediconnect-doctor-schedules";
const STRIPE_SECRET_NAME = "mediconnect/stripe/keys";
const CLEANUP_SECRET_PARAM = "/mediconnect/prod/cleanup/secret";

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
            insuranceProvider, policyId, priority = "Low", reason = "General Checkup"
        } = req.body;

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
        const BASE_FEE = 5000; // in cents
        // Example insurance logic
        const amountToCharge = (insuranceProvider && policyId) ? Math.round(BASE_FEE * 0.40) : BASE_FEE;

        const stripeKey = await getSecret(STRIPE_SECRET_NAME);
        if (!stripeKey) throw new Error("Stripe secret not found");

        stripeInstance = new Stripe(stripeKey);
        try {
            const paymentIntent = await stripeInstance.paymentIntents.create({
                amount: amountToCharge,
                currency: "usd",
                payment_method: paymentToken || "pm_card_visa",
                confirm: true,
                metadata: { appointmentId, doctorId, patientId, billId: transactionId },
                automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
            });
            paymentIntentId = paymentIntent.id;
        } catch (paymentError: any) {
            console.error("Payment Failed:", paymentError.message);
            // Release lock
            await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } }));
            return res.status(402).json({ error: "Payment Failed", details: paymentError.message });
        }

        // 4. TransactWriteItems (Atomic Commit)
        // Ops:
        // 1. Put Appointment
        // 2. Put Transaction
        // 3. Delete Lock (or update status, but usually we keep it or delete it. Plan said delete/update. Let's Delete to free up space, duplicate check handled by business logic or if we want to keep it as a tombstone, but slots are distinct.)
        // Actually, if we delete the lock immediately, someone else might book it if we don't put the appointment first?
        // Wait, the appointment table primary key should prevent duplicates if it's based on time?
        // Usually Appointment ID is UUID.
        // We should KEEP the lock BUT change status to BOOKED to prevent others from taking it, OR rely on a GSI or logic to check appointments.
        // The legacy code used TABLE_LOCKS just for temporary holding.
        // Let's UPDATE the lock to "CONFIRMED" or just Delete it if the Appointment record itself acts as the source of truth for "Slot Taken".
        // The legacy code didn't seem to check Appointment table for conflict in `mediconnect-book-appointment` line 174, it checked `TABLE_LOCKS`.
        // So we must KEEP the lock item effectively, or ensure the Appointment check covers it.
        // Let's UPDATING the lock to "BOOKED" and ensure it expires later or stays.
        // Actually, creating the Appointment IS the final record.
        // Let's Delete the lock as the Appointment now exists... BUT, does the `createBooking` check `TABLE_APPOINTMENTS`? No.
        // It relies on `TABLE_LOCKS`. So we should probably keep the lock as a permanent record OR have a way to check appointments.
        // Standard pattern: The Lock table is for ephemeral concurrency. The Appointment table is permanent.
        // To be safe and simple: Update Lock to "BOOKED" so checks on Lock Table still fail for others.

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
                                insuranceProvider: insuranceProvider || "N/A", policyId: policyId || "N/A",
                                amountPaid: amountToCharge / 100, coverageType: (insuranceProvider && policyId) ? "INSURANCE_40_PERCENT" : "NONE",
                                priority, reason, patientAvatar, patientAge, triageStatus: "WAITING"
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
                                description: `Consultation with ${doctorName}`,
                                paymentIntentId: paymentIntentId
                            }
                        }
                    },
                    {
                        // Update Lock to Booked prevents race conditions if we rely on Lock table for "Is Slot Taken"
                        Update: {
                            TableName: TABLE_LOCKS,
                            Key: { lockId: lockKey },
                            UpdateExpression: "SET #s = :s, appointmentId = :aid",
                            ExpressionAttributeNames: { "#s": "status" },
                            ExpressionAttributeValues: { ":s": "BOOKED", ":aid": appointmentId }
                        }
                    }
                ]
            }));

            res.status(200).json({
                message: "Appointment Secured",
                id: appointmentId,
                billId: transactionId,
                priority,
                queueStatus: "WAITING"
            });

        } catch (dbError: any) {
            console.error("Transaction Failed. Initiating Refund.", dbError);
            // CRITICAL: Refund Stripe
            if (stripeInstance && paymentIntentId) {
                try { await stripeInstance.refunds.create({ payment_intent: paymentIntentId }); } catch (e) {
                    console.error("Refund failed dramatically:", e);
                }
            }
            // Release Lock (Delete it so user can try again)
            try { await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } })); } catch (e) { }

            res.status(500).json({ error: "System Error. Payment refunded." });
        }

    } catch (error: any) {
        console.error("CRASH:", error);
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
            const scheduleCommand = new GetCommand({
                TableName: TABLE_SCHEDULES,
                Key: { doctorId: String(doctorId) }
            });

            const [bookingRes, scheduleRes] = await Promise.all([
                docClient.send(bookingCommand),
                docClient.send(scheduleCommand)
            ]);

            return res.status(200).json({
                existingBookings: bookingRes.Items || [],
                weeklySchedule: scheduleRes.Item?.schedule || {},
                timezone: scheduleRes.Item?.timezone || "UTC"
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
        const stripeKey = await getSecret(STRIPE_SECRET_NAME);
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

async function cancelAppointment(apt: any, newStatus: string, refundId: string) {
    try {
        await docClient.send(new UpdateCommand({
            TableName: TABLE_APPOINTMENTS,
            Key: { appointmentId: apt.appointmentId },
            UpdateExpression: "set #s = :s, refundId = :r, lastUpdated = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":s": newStatus, ":r": refundId, ":now": new Date().toISOString() }
        }));

        if (apt.doctorId && apt.timeSlot) {
            const lockKey = `${apt.doctorId}#${normalizeTimeSlot(apt.timeSlot)}`;
            await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } }));
        }
    } catch (e) {
        console.error("Cancel update failed", e);
    }
}
