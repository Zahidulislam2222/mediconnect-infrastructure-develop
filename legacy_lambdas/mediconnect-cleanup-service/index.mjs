import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const secretsClient = new SecretsManagerClient({});

const TABLE_APPOINTMENTS = "mediconnect-appointments";
const TABLE_LOCKS = "mediconnect-booking-locks";
const STRIPE_SECRET_NAME = "mediconnect/stripe/keys";

// --- HELPER: TIME NORMALIZATION ---
function normalizeTimeSlot(isoString) {
    if (!isoString) return "";
    return isoString.split('.')[0] + "Z";
}

// --- HELPER: SECRETS ---
async function getSecret(secretName) {
    try {
        const data = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
        const secretString = data.SecretString;
        if (!secretString) throw new Error("Secret empty");
        try {
            const parsed = JSON.parse(secretString);
            return parsed.secretKey || parsed;
        } catch (e) { return secretString; }
    } catch (err) {
        console.error(`Secret Error: ${err.message}`);
        return null;
    }
}

export const handler = async (event) => {
    console.log("⏰ Watchdog Started...");
    const now = new Date();

    try {
        // 1. Scan for ALL Active Appointments
        // In a huge production app, we would use a GSI with Date range, but Scan is fine for now.
        const scanRes = await docClient.send(new ScanCommand({
            TableName: TABLE_APPOINTMENTS,
            FilterExpression: "#s = :confirmed",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":confirmed": "CONFIRMED" }
        }));

        const appointments = scanRes.Items || [];
        console.log(`🔍 Checking ${appointments.length} active appointments.`);

        const stripeKey = await getSecret(STRIPE_SECRET_NAME);
        const stripe = stripeKey ? new Stripe(stripeKey) : null;

        for (const apt of appointments) {
            if (!apt.timeSlot) continue;

            const aptTime = new Date(apt.timeSlot);
            const diffMs = now.getTime() - aptTime.getTime();
            const diffMinutes = Math.floor(diffMs / 60000);

            // 🟢 RULE 1: PATIENT NO-SHOW (10 Minutes Late)
            // If 10 mins passed AND patient has NOT arrived
            if (diffMinutes >= 10 && !apt.patientArrived) {
                console.log(`❌ PATIENT LATE: ID ${apt.appointmentId} (${diffMinutes}m)`);
                
                // Cancel - NO REFUND (Patient Fault)
                await cancelAppointment(apt, "CANCELLED_NO_SHOW", "FAILED");
                continue;
            }

            // 🟢 RULE 2: DOCTOR NO-SHOW (30 Minutes Late)
            // If 30 mins passed AND patient WAS waiting
            if (diffMinutes >= 30 && apt.patientArrived) {
                console.log(`⚠️ DOCTOR LATE: ID ${apt.appointmentId} (${diffMinutes}m)`);
                
                // Refund Logic
                let refundId = "REFUND_FAILED";
                if (stripe && apt.paymentId && apt.paymentId !== "PENDING" && apt.paymentId !== "TEST_MODE") {
                    try {
                        const refund = await stripe.refunds.create({ payment_intent: apt.paymentId });
                        refundId = refund.id;
                        console.log(`💰 Auto-Refunded: ${refundId}`);
                    } catch (e) {
                        console.error("Refund Error:", e.message);
                    }
                }

                // Cancel - WITH REFUND (Doctor Fault)
                await cancelAppointment(apt, "CANCELLED_DOCTOR_FAULT", refundId);
            }
        }

        return { statusCode: 200, body: "Cleanup Complete" };

    } catch (error) {
        console.error("CRASH:", error);
        return { statusCode: 500, error: error.message };
    }
};

// --- HELPER: PERFORM CANCELLATION ---
async function cancelAppointment(apt, newStatus, refundId) {
    // 1. Update Status
    await docClient.send(new UpdateCommand({
        TableName: TABLE_APPOINTMENTS,
        Key: { appointmentId: apt.appointmentId },
        UpdateExpression: "set #s = :s, refundId = :r, lastUpdated = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { 
            ":s": newStatus, 
            ":r": refundId,
            ":now": new Date().toISOString()
        }
    }));

    // 2. Release Lock
    if (apt.doctorId && apt.timeSlot) {
        const normalizedTime = normalizeTimeSlot(apt.timeSlot);
        const lockKey = `${apt.doctorId}#${normalizedTime}`;
        try {
            await docClient.send(new DeleteCommand({
                TableName: TABLE_LOCKS,
                Key: { lockId: lockKey }
            }));
            console.log("🔓 Lock Released");
        } catch (e) { console.warn("Lock clean error:", e.message); }
    }
}