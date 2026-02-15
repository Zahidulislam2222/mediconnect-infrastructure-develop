import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";
import { randomUUID } from "crypto"; // 🟢 Added for Refund Bill ID

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const secretsClient = new SecretsManagerClient({});

const TABLE_APPOINTMENTS = "mediconnect-appointments";
const TABLE_LOCKS = "mediconnect-booking-locks";
const TABLE_TRANSACTIONS = "mediconnect-transactions"; // 🟢 Added Ledger Table
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
        if (!secretString) throw new Error("SecretString is empty");
        try {
            const parsed = JSON.parse(secretString);
            return parsed.secretKey || parsed;
        } catch (e) { return secretString; }
    } catch (err) {
        console.error(`❌ CRITICAL: Secret ${secretName} failed:`, err);
        throw err;
    }
}

export const handler = async (event) => {
    console.log("EVENT:", JSON.stringify(event));

    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    let body = {};
    try {
        if (event.body) body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        else body = event;
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ message: "Invalid JSON body" }) };
    }

    const { appointmentId, patientId } = body;

    if (!appointmentId || !patientId) {
        return { statusCode: 400, headers, body: JSON.stringify({ message: "Missing appointmentId or patientId" }) };
    }

    try {
        // 1. Fetch the Appointment
        const getResult = await docClient.send(new GetCommand({
            TableName: TABLE_APPOINTMENTS,
            Key: { appointmentId }
        }));

        const appointment = getResult.Item;

        if (!appointment) {
            return { statusCode: 404, headers, body: JSON.stringify({ message: "Appointment not found" }) };
        }

        if (appointment.patientId !== patientId) {
            return { statusCode: 403, headers, body: JSON.stringify({ message: "Unauthorized to cancel this appointment" }) };
        }

        // 2. Process Refund (If paid)
        let refundId = null;
        const paymentId = appointment.paymentId;
        const amountPaid = parseFloat(appointment.amountPaid || "0");
        
        if (paymentId && paymentId !== "PENDING" && paymentId !== "N/A" && paymentId !== "TEST_MODE") {
            try {
                const stripeKey = await getSecret(STRIPE_SECRET_NAME);
                if (stripeKey) {
                    const stripe = new Stripe(stripeKey);
                    console.log(`💸 Attempting refund for: ${paymentId}`);
                    
                    const refund = await stripe.refunds.create({
                        payment_intent: paymentId
                    });
                    refundId = refund.id;
                    console.log("💰 Refund Successful:", refundId);

                    // 🟢 3. PROFESSIONAL UPDATE: Write Refund to Ledger
                    // This ensures the Analytics Page subtracts the revenue
                    const refundBillId = randomUUID();
                    await docClient.send(new PutCommand({
                        TableName: TABLE_TRANSACTIONS,
                        Item: {
                            billId: refundBillId,
                            referenceId: appointmentId,
                            patientId: patientId,
                            doctorId: appointment.doctorId, // Important for Doctor Analytics
                            type: "REFUND",
                            amount: -Math.abs(amountPaid), // Negative amount!
                            currency: "USD",
                            status: "REFUNDED",
                            createdAt: new Date().toISOString(),
                            description: `Refund for Cancelled Appt`,
                            paymentIntentId: refundId
                        }
                    }));
                }
            } catch (stripeError) {
                console.error("⚠️ Refund Failed (Proceeding with cancellation anyway):", stripeError.message);
            }
        }

        // 4. Update Status to CANCELLED in DynamoDB
        await docClient.send(new UpdateCommand({
            TableName: TABLE_APPOINTMENTS,
            Key: { appointmentId },
            UpdateExpression: "set #status = :s, refundId = :rid, lastUpdated = :ts",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { 
                ":s": "CANCELLED",
                ":rid": refundId || "FAILED_OR_NOT_REQUIRED",
                ":ts": new Date().toISOString()
            }
        }));

        // 5. Release the Slot Lock
        if (appointment.doctorId && appointment.timeSlot) {
            const normalizedTime = normalizeTimeSlot(appointment.timeSlot);
            const lockKey = `${appointment.doctorId}#${normalizedTime}`;
            
            console.log("🔓 Releasing Lock:", lockKey);
            try {
                await docClient.send(new DeleteCommand({
                    TableName: TABLE_LOCKS,
                    Key: { lockId: lockKey }
                }));
            } catch (e) {
                console.warn("Lock release failed:", e.message);
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ message: "Appointment cancelled and refunded successfully.", refundId })
        };

    } catch (error) {
        console.error("CRASH:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};