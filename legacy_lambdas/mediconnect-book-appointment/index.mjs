import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { randomUUID } from "crypto";
import Stripe from "stripe";
import { google } from "googleapis";
import { BigQuery } from "@google-cloud/bigquery";

// --- CLIENT INITIALIZATION ---
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const secretsClient = new SecretsManagerClient({});

// --- CONFIGURATION ---
const STRIPE_SECRET_NAME = "mediconnect/stripe/keys";
const GOOGLE_KEY_NAME = "mediconnect/gcp/calendar_key";
const DOCTOR_CALENDAR_ID = "muhammadzahidulislam2222@gmail.com";

const TABLE_APPOINTMENTS = "mediconnect-appointments";
const TABLE_LOCKS = "mediconnect-booking-locks";
const TABLE_PATIENTS = "mediconnect-patients";
const TABLE_TRANSACTIONS = "mediconnect-transactions"; // 🟢 NEW: Linked to your new Indexes

const HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST,PUT"
};

// --- HELPER: SECRETS ---
async function getSecret(secretName) {
    try {
        const data = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
        const secretString = data.SecretString;
        if (!secretString) return null;
        try {
            const parsed = JSON.parse(secretString);
            return parsed.secretKey || parsed;
        } catch (e) { return secretString; }
    } catch (err) {
        console.warn(`⚠️ Secret Warning: ${secretName} not found`);
        return null;
    }
}

// --- HELPER: AGE CALCULATION ---
function calculateAge(dobString) {
    if (!dobString) return "N/A";
    const dob = new Date(dobString);
    const diff_ms = Date.now() - dob.getTime();
    const age_dt = new Date(diff_ms);
    return Math.abs(age_dt.getUTCFullYear() - 1970);
}

// --- HELPER: TIME NORMALIZATION ---
function normalizeTimeSlot(isoString) {
    if (!isoString) return new Date().toISOString();
    const parts = isoString.split('Z')[0].split('.');
    return parts[0] + "Z";
}

// --- ASYNC HELPERS (Google & BigQuery) ---
async function addToGoogleCalendar(appointment, gcpKeyJson) {
    if (!gcpKeyJson) return;
    try {
        const credentials = typeof gcpKeyJson === 'string' ? JSON.parse(gcpKeyJson) : gcpKeyJson;
        if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\n/g, '\n');
        
        const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/calendar'] });
        const calendar = google.calendar({ version: 'v3', auth: await auth.getClient() });

        const startDate = new Date(appointment.timeSlot);
        const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

        await calendar.events.insert({
            calendarId: DOCTOR_CALENDAR_ID,
            resource: {
                summary: `MediConnect: ${appointment.patientName}`,
                description: `ID: ${appointment.appointmentId}\nPriority: ${appointment.priority}\nReason: ${appointment.reason}\nAge: ${appointment.patientAge}`,
                start: { dateTime: startDate.toISOString() },
                end: { dateTime: endDate.toISOString() },
            },
        });
        console.log("✅ Google Calendar Synced");
    } catch (error) { console.error("❌ Calendar Sync Failed:", error.message); }
}

async function sendToBigQuery(data, gcpKeyJson) {
    if (!gcpKeyJson) return;
    try {
        const credentials = typeof gcpKeyJson === 'string' ? JSON.parse(gcpKeyJson) : gcpKeyJson;
        if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\n/g, '\n');
        
        const bigquery = new BigQuery({ projectId: credentials.project_id, credentials });
        await bigquery.dataset('mediconnect_analytics').table('analytics_revenue').insert([data]);
        console.log(`✅ BigQuery Streamed: ${data.transaction_id}`);
    } catch (error) { console.error("❌ BigQuery Failed:", error.message); }
}

// =================================================================
// 🚀 MAIN HANDLER
// =================================================================
export const handler = async (event) => {
    console.log("🔥 INCOMING REQUEST:", JSON.stringify(event));
    let lockKey = null;
    let paymentIntentId = null;
    let stripeInstance = null;
    
    // 🟢 NEW: Generate the Bill ID at the start
    const transactionId = randomUUID();

    try {
        if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

        let data = {};
        if (event.body) data = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        else data = event;

        // --- SCENARIO A: UPDATE STATUS (Doctor/Admin Action) ---
        if (event.httpMethod === 'PUT') {
            const { appointmentId, status, patientArrived } = data;
            if (!appointmentId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ message: "Missing ID" }) };
            
            let updateExp = "set lastUpdated = :ts";
            let expValues = { ":ts": new Date().toISOString() };
            let expNames = {};

            if (status) {
                updateExp += ", #s = :status";
                expValues[":status"] = status;
                expNames["#s"] = "status";
            }
            if (patientArrived !== undefined) {
                updateExp += ", patientArrived = :pa";
                expValues[":pa"] = patientArrived;
            }
            
            await docClient.send(new UpdateCommand({
                TableName: TABLE_APPOINTMENTS,
                Key: { appointmentId },
                UpdateExpression: updateExp,
                ExpressionAttributeNames: Object.keys(expNames).length ? expNames : undefined,
                ExpressionAttributeValues: expValues,
                ReturnValues: "ALL_NEW"
            }));
            return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ message: "Updated" }) };
        }

        // --- SCENARIO B: NEW BOOKING (Patient Action) ---
        const { 
            patientId, patientName, doctorId, doctorName, timeSlot, paymentToken, 
            insuranceProvider, policyId, priority = "Low", reason = "General Checkup"
        } = data;
        
        if (!timeSlot || !patientId || !doctorId) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ message: "Missing required booking fields" }) };
        }

        // 1. Data Enrichment
        let patientAge = "N/A";
        let patientAvatar = null;
        try {
            const patientRes = await docClient.send(new GetCommand({ TableName: TABLE_PATIENTS, Key: { userId: patientId } }));
            if (patientRes.Item) {
                patientAvatar = patientRes.Item.avatar || null;
                patientAge = calculateAge(patientRes.Item.dob);
            }
        } catch (err) { console.error("Enrichment Error:", err.message); }

        // 2. Atomic Locking
        const normalizedTime = normalizeTimeSlot(timeSlot);
        lockKey = `${doctorId}#${normalizedTime}`;
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
                return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ message: "This time slot is already taken." }) };
            }
            throw e;
        }

        // 3. Payment Processing
        const BASE_FEE = 5000;
        let amountToCharge = (insuranceProvider && policyId) ? Math.round(BASE_FEE * 0.40) : BASE_FEE;
        let coverageType = (insuranceProvider && policyId) ? "INSURANCE_40_PERCENT" : "NONE";

        const appointmentId = randomUUID();
        const timestamp = new Date().toISOString();
        
        const stripeKey = await getSecret(STRIPE_SECRET_NAME);
        if (stripeKey) {
            stripeInstance = new Stripe(stripeKey);
            try {
                const paymentIntent = await stripeInstance.paymentIntents.create({
                    amount: amountToCharge, 
                    currency: "usd", 
                    payment_method: paymentToken || "pm_card_visa", 
                    confirm: true,
                    // 🟢 NEW: Add billId so Webhook can trace it
                    metadata: { appointmentId, doctorId, patientId, billId: transactionId },
                    automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
                });
                paymentIntentId = paymentIntent.id;
                console.log("💰 Payment Successful:", paymentIntentId);
            } catch (paymentError) {
                console.error("❌ Payment Failed:", paymentError.message);
                await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } }));
                return { statusCode: 402, headers: HEADERS, body: JSON.stringify({ error: "Payment Failed", details: paymentError.message }) };
            }
        }

        // 4. SAVE (APPOINTMENT + TRANSACTION)
        try {
            // A. Save Appointment
            await docClient.send(new PutCommand({
                TableName: TABLE_APPOINTMENTS,
                Item: {
                    appointmentId, 
                    patientId, 
                    patientName, 
                    doctorId, 
                    doctorName, 
                    timeSlot: normalizedTime,
                    status: "CONFIRMED", 
                    paymentStatus: "paid", // "paid" because charge succeeded above
                    paymentId: paymentIntentId || "TEST_MODE", 
                    createdAt: timestamp,
                    insuranceProvider: insuranceProvider || "N/A", 
                    policyId: policyId || "N/A",
                    amountPaid: amountToCharge / 100, 
                    coverageType,
                    priority, 
                    reason, 
                    patientAvatar, 
                    patientAge, 
                    triageStatus: "WAITING"
                },
            }));

            // B. 🟢 NEW: Save Transaction Receipt (This populates the Billing Page)
            await docClient.send(new PutCommand({
                TableName: TABLE_TRANSACTIONS,
                Item: {
                    billId: transactionId,           // Primary Key
                    referenceId: appointmentId,      // Link to Appointment
                    patientId: patientId,            // For PatientIndex GSI
                    doctorId: doctorId,              // For DoctorIndex GSI
                    type: "BOOKING_FEE",
                    amount: amountToCharge / 100,
                    currency: "USD",
                    status: "PAID",
                    createdAt: timestamp,
                    description: `Consultation with ${doctorName}`,
                    paymentIntentId: paymentIntentId || "N/A"
                }
            }));

            console.log("✅ Data Saved: Appointment & Transaction");

        } catch (dbError) {
            console.error("🚨 DB SAVE FAILED. INITIATING REFUND.", dbError);
            if (stripeInstance && paymentIntentId) {
                try { await stripeInstance.refunds.create({ payment_intent: paymentIntentId }); } catch (e) {}
            }
            await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } }));
            return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "System Error. Payment refunded." }) };
        }

        // 5. Async Integrations
        const gcpKey = process.env.GCP_SA_KEY || await getSecret(GOOGLE_KEY_NAME);
        if (gcpKey) {
            console.log("⏳ Starting Async Integrations...");
            try {
                await Promise.all([
                    addToGoogleCalendar({ patientName, doctorName, appointmentId, timeSlot: normalizedTime, priority, reason, patientAge }, gcpKey),
                    sendToBigQuery({
                        transaction_id: transactionId, // 🟢 UPDATED: Use the Bill ID
                        patient_id: patientId,
                        doctor_id: doctorId,
                        amount: amountToCharge / 100,
                        currency: 'USD',
                        status: 'PAID',
                        timestamp: timestamp
                    }, gcpKey)
                ]);
            } catch (err) { console.error("⚠️ Integration Warning:", err); }
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ 
                message: "Appointment Secured", 
                id: appointmentId,
                billId: transactionId, // Return billId for reference
                priority,
                queueStatus: "WAITING"
            }),
        };

    } catch (error) {
        console.error("❌ CRASH:", error);
        if (lockKey) try { await docClient.send(new DeleteCommand({ TableName: TABLE_LOCKS, Key: { lockId: lockKey } })); } catch (e) {}
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    }
};