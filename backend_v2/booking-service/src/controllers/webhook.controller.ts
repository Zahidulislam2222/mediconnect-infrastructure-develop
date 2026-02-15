import { Request, Response } from 'express';
import Stripe from 'stripe';
import { docClient, getSSMParameter } from '../config/aws';
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

// --- CONFIGURATION ---
const STRIPE_SECRET_NAME = "/mediconnect/stripe/keys";
const STRIPE_WEBHOOK_SECRET_NAME = "/mediconnect/stripe/webhook_secret";

// Table Names (Must match your existing schema)
const TABLE_TRANSACTIONS = "mediconnect-transactions";
const TABLE_PRESCRIPTIONS = "mediconnect-prescriptions";
const TABLE_APPOINTMENTS = "mediconnect-appointments";

export const handleStripeWebhook = async (req: Request, res: Response) => {
    let event: Stripe.Event;

    try {
        // 1. Fetch Secrets (Cached in Lambda environment usually, but fetched here for safety)
        const stripeKey = await getSSMParameter(STRIPE_SECRET_NAME, true);
        const webhookSecret = await getSSMParameter(STRIPE_WEBHOOK_SECRET_NAME, true);

        if (!stripeKey || !webhookSecret) {
            console.error("CRITICAL: Stripe secrets missing in SSM.");
            return res.status(500).send("Server Configuration Error");
        }

        const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

        // 2. Verify Signature (Security: Prevents Fake Requests)
        const sig = req.headers['stripe-signature'];
        if (!sig) return res.status(400).send("Missing Stripe Signature");

        // req.body is a Buffer here because of express.raw() in index.ts
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    } catch (err: any) {
        console.error(`⚠️  Webhook Signature Verification Failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 3. Handle the Event
    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;

        console.log(`💰 Payment Captured: ${paymentIntent.id}`);
        await handlePaymentSuccess(paymentIntent);
    } else if (event.type === 'payment_intent.payment_failed') {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(`❌ Payment Failed: ${paymentIntent.last_payment_error?.message}`);
        // Optional: Add logic to mark transaction as FAILED
    }

    // 4. Return 200 OK immediately (Stripe requires this to stop retrying)
    res.json({ received: true });
};

// --- CORE LOGIC: The "Split Brain" Fix ---
async function handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
    const { billId, referenceId, type, pharmacyId, medication } = paymentIntent.metadata;

    if (!billId) {
        console.warn("Skipping Webhook: Missing 'billId' in metadata.");
        return;
    }

    console.log(`Processing Sync for Type: ${type} | Ref: ${referenceId}`);

    const timestamp = new Date().toISOString();
    const transactItems: any[] = [];

    // ACTION A: Update the Ledger (Transaction Table) - ALWAYS
    transactItems.push({
        Update: {
            TableName: TABLE_TRANSACTIONS,
            Key: { billId },
            UpdateExpression: "SET #s = :s, paymentIntentId = :pid, paidAt = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
                ":s": "PAID",
                ":pid": paymentIntent.id,
                ":now": timestamp
            }
        }
    });

    // ACTION B: Sync the Source (Prescription or Appointment)
    if (type === 'PHARMACY' && referenceId) {
        // 1. Update Prescription to READY_FOR_PICKUP
        transactItems.push({
            Update: {
                TableName: TABLE_PRESCRIPTIONS,
                Key: { prescriptionId: referenceId },
                UpdateExpression: "SET paymentStatus = :ps, #s = :rs, updatedAt = :now",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                    ":ps": "PAID",
                    ":rs": "READY_FOR_PICKUP",
                    ":now": timestamp
                }
            }
        });

        // 2. 🟢 NEW: Automatically Deduct Stock from Inventory
        transactItems.push({
            Update: {
                TableName: "mediconnect-pharmacy-inventory",
                Key: {
                    pharmacyId: pharmacyId || "CVS-001", // Metadata from Step 2 below
                    drugId: medication                  // Metadata from Step 2 below
                },
                UpdateExpression: "SET stock = stock - :one",
                ExpressionAttributeValues: { ":one": 1 }
            }
        });
    } else if (type === 'BOOKING_FEE' && referenceId) {
        // Failsafe: Ensures appointment is confirmed even if the frontend crashed
        transactItems.push({
            Update: {
                TableName: TABLE_APPOINTMENTS,
                Key: { appointmentId: referenceId },
                UpdateExpression: "SET paymentStatus = :ps, #s = :confirmed",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                    ":ps": "paid",
                    ":confirmed": "CONFIRMED"
                }
            }
        });
    }

    // ACTION C: Atomic Commit
    try {
        await docClient.send(new TransactWriteCommand({
            TransactItems: transactItems
        }));
        console.log(`✅ DATABASE SYNCED: Transaction ${billId} + ${type} Record`);
    } catch (error) {
        console.error("CRITICAL DB ERROR: Webhook failed to write to DynamoDB", error);
        // Note: Stripe will retry sending the webhook if we returned 500, 
        // but we returned 200 earlier to avoid infinite loops on bad code.
        // In production, push this to a Dead Letter Queue (DLQ).
    }
}