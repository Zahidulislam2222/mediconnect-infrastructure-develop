import { Request, Response } from 'express';
import Stripe from 'stripe';
import { getRegionalClient, getSSMParameter } from '../config/aws';
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

const STRIPE_SECRET_NAME = "/mediconnect/stripe/keys";
const STRIPE_WEBHOOK_SECRET_NAME = "/mediconnect/stripe/webhook_secret";

const TABLE_TRANSACTIONS = process.env.TABLE_TRANSACTIONS || "mediconnect-transactions";
const TABLE_PRESCRIPTIONS = process.env.TABLE_PRESCRIPTIONS || "mediconnect-prescriptions";
const TABLE_APPOINTMENTS = process.env.TABLE_APPOINTMENTS || "mediconnect-appointments";
const TABLE_INVENTORY = process.env.TABLE_INVENTORY || "mediconnect-pharmacy-inventory";

export const handleStripeWebhook = async (req: Request, res: Response) => {
    let event: Stripe.Event;
    
    // 🟢 GDPR/Schrems II: Stripe doesn't send standard headers. 
    // We fall back to the Region defined by the Docker Container's deployment environment.
    const region = (req.headers['x-user-region'] as string) || process.env.AWS_REGION || "us-east-1";
    const regionalDb = getRegionalClient(region);

    try {
        const stripeKey = await getSSMParameter(STRIPE_SECRET_NAME, region, true);
        const webhookSecret = await getSSMParameter(STRIPE_WEBHOOK_SECRET_NAME, region, true);

        if (!stripeKey || !webhookSecret) {
            console.error(`CRITICAL: Stripe secrets missing in SSM for region: ${region}`);
            return res.status(500).send("Server Configuration Error");
        }

        const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
        const sig = req.headers['stripe-signature'];
        if (!sig) return res.status(400).send("Missing Stripe Signature");

        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    } catch (err: any) {
        console.error(`⚠️ Webhook Signature Verification Failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(`💰 Payment Captured: ${paymentIntent.id} in region ${region}`);
        await handlePaymentSuccess(paymentIntent, regionalDb);
    } else if (event.type === 'payment_intent.payment_failed') {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(`❌ Payment Failed: ${paymentIntent.last_payment_error?.message}`);
    }

    res.json({ received: true });
};

async function handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent, regionalDb: any) {
    const { billId, referenceId, type, pharmacyId, medication } = paymentIntent.metadata || {};

    if (!billId) {
        console.warn("Skipping Webhook: Missing 'billId' in metadata.");
        return;
    }

    const timestamp = new Date().toISOString();
    const transactItems: any[] = [];

    // ACTION A: Update the Ledger
    transactItems.push({
        Update: {
            TableName: TABLE_TRANSACTIONS,
            Key: { billId },
            UpdateExpression: "SET #s = :s, paymentIntentId = :pid, paidAt = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":s": "PAID", ":pid": paymentIntent.id, ":now": timestamp }
        }
    });

    // ACTION B: Sync Source
    if (type === 'PHARMACY' && referenceId) {
        transactItems.push({
            Update: {
                TableName: TABLE_PRESCRIPTIONS,
                Key: { prescriptionId: referenceId },
                UpdateExpression: "SET paymentStatus = :ps, #s = :rs, updatedAt = :now",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":ps": "PAID", ":rs": "READY_FOR_PICKUP", ":now": timestamp }
            }
        });

        transactItems.push({
            Update: {
                TableName: TABLE_INVENTORY,
                Key: { pharmacyId: pharmacyId || "CVS-001", drugId: medication },
                UpdateExpression: "SET stock = stock - :one",
                ExpressionAttributeValues: { ":one": 1 }
            }
        });
    } else if (type === 'BOOKING_FEE' && referenceId) {
        transactItems.push({
            Update: {
                TableName: TABLE_APPOINTMENTS,
                Key: { appointmentId: referenceId },
                UpdateExpression: "SET paymentStatus = :ps, #s = :confirmed",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":ps": "paid", ":confirmed": "CONFIRMED" }
            }
        });
    }

    try {
        await regionalDb.send(new TransactWriteCommand({ TransactItems: transactItems }));
        console.log(`✅ DATABASE SYNCED: Transaction ${billId} + ${type} Record`);
    } catch (error) {
        console.error("CRITICAL DB ERROR: Webhook failed to write to Regional DynamoDB", error);
    }
}