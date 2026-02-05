import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";

const secrets = new SecretsManagerClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Table Names
const TABLE_TRANSACTIONS = "mediconnect-transactions";
const TABLE_APPOINTMENTS = "mediconnect-appointments";

// CORS Headers
const HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST"
};

export const handler = async (event) => {
    try {
        // 0. Pre-flight
        if (event.httpMethod === 'OPTIONS') {
            return { statusCode: 200, headers: HEADERS, body: '' };
        }

        // 1. Get Secrets
        const secretData = await secrets.send(new GetSecretValueCommand({ SecretId: "mediconnect/stripe/keys" }));
        const { secretKey, stripeWebhookSecret } = JSON.parse(secretData.SecretString);
        const stripe = new Stripe(secretKey);

        // =================================================================
        // 🔒 SCENARIO 1: PAY BILL (Initiated by Patient Clicking "Pay")
        // =================================================================
        if (event.resource === "/pay-bill") {
            const body = JSON.parse(event.body || "{}");
            const { billId, paymentMethodId } = body;

            if (!billId) {
                return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Missing billId" }) };
            }

            // A. SECURITY CHECK: Fetch the REAL bill from DynamoDB
            // We do NOT trust the amount sent from the frontend
            const getRes = await ddb.send(new GetCommand({
                TableName: TABLE_TRANSACTIONS,
                Key: { billId: billId }
            }));

            const bill = getRes.Item;

            if (!bill) {
                return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Bill not found" }) };
            }
            if (bill.status === 'PAID') {
                return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Bill is already paid" }) };
            }

            // B. Create Payment Intent with the DATABASE Amount
            // We interpret bill.amount (e.g. 50.00) as dollars, so multiply by 100 for cents
            const amountInCents = Math.round((bill.amount || bill.patientResponsibility) * 100);

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amountInCents,
                currency: "usd",
                payment_method: paymentMethodId, // Optional: if frontend sends token
                metadata: { 
                    billId: billId, 
                    appointmentId: bill.referenceId, // Critical: Link back to Medical Record
                    patientId: bill.patientId 
                },
                automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
            });

            return { statusCode: 200, headers: HEADERS, body: JSON.stringify(paymentIntent) };
        }

        // =================================================================
        // ⚡ SCENARIO 2: STRIPE WEBHOOK (The Confirmation)
        // =================================================================
        if (event.resource === "/stripe-webhook") {
            const signature = event.headers["Stripe-Signature"] || event.headers["stripe-signature"];

            let stripeEvent;
            try {
                // Verify Signature
                stripeEvent = stripe.webhooks.constructEvent(
                    event.body,
                    signature,
                    stripeWebhookSecret
                );
            } catch (err) {
                console.error(`Webhook Signature Verification Failed: ${err.message}`);
                return { statusCode: 400, body: JSON.stringify({ error: "Invalid Signature" }) };
            }

            // Process "Payment Succeeded"
            if (stripeEvent.type === "payment_intent.succeeded") {
                const metadata = stripeEvent.data.object.metadata;
                const billId = metadata.billId;
                const appointmentId = metadata.appointmentId; // We passed this in metadata above

                console.log(`💰 Webhook Received for Bill: ${billId}, Appt: ${appointmentId}`);

                // A. Update Transaction Ledger (Billing Page Source)
                if (billId) {
                    await ddb.send(new UpdateCommand({
                        TableName: TABLE_TRANSACTIONS,
                        Key: { billId: billId },
                        UpdateExpression: "set #s = :status, paymentIntentId = :pid, paidAt = :now",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: { 
                            ":status": "PAID",
                            ":pid": stripeEvent.data.object.id,
                            ":now": new Date().toISOString()
                        }
                    }));
                }

                // B. Update Medical Record (Doctor Dashboard Source)
                // This ensures the green "Paid" badge appears on the appointment card
                if (appointmentId) {
                    try {
                        await ddb.send(new UpdateCommand({
                            TableName: TABLE_APPOINTMENTS,
                            Key: { appointmentId: appointmentId },
                            UpdateExpression: "set paymentStatus = :status",
                            ExpressionAttributeValues: { ":status": "paid" } // Lowercase to match Booking Lambda
                        }));
                    } catch (e) {
                        console.warn("Could not update appointment status (might have been deleted):", e.message);
                    }
                }
            }

            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

    } catch (err) {
        console.error("CRASH:", err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
};