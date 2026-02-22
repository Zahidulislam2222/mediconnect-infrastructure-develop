import { Request, Response } from 'express';
import { getRegionalClient, getSSMParameter } from '../config/aws';
import { QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";
import { writeAuditLog } from '../../../shared/audit';

const TABLE_TRANSACTIONS = process.env.TABLE_TRANSACTIONS || "mediconnect-transactions";

interface AuthRequest extends Request {
    user?: { sub?: string; id?: string };
}

// 🟢 GDPR: Extract legal jurisdiction from headers
export const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

// 1. Fetch Billing History & Balance
export const getPatientBilling = async (req: Request, res: Response) => {
    try {
        const region = extractRegion(req);
        const regionalDb = getRegionalClient(region);
        
        const { patientId } = req.query;
        const authReq = req as AuthRequest;
        const requesterId = authReq.user?.sub || authReq.user?.id;

        // 🛡️ HIPAA SECURITY CHECK
        if (requesterId && requesterId !== patientId) {
            await writeAuditLog(requesterId, String(patientId), "UNAUTHORIZED_BILLING_ACCESS", "Blocked access to financial records", { region, ipAddress: req.ip });
            return res.status(403).json({ message: "Unauthorized access to billing records." });
        }

        const command = new QueryCommand({
            TableName: TABLE_TRANSACTIONS,
            IndexName: "PatientIndex",
            KeyConditionExpression: "patientId = :pid",
            ExpressionAttributeValues: { ":pid": patientId },
            ScanIndexForward: false
        });

        const response = await regionalDb.send(command);
        const transactions = response.Items || [];

        const outstandingBalance = transactions
            .filter(t => t.status === 'PENDING' || t.status === 'DUE' || t.status === 'UNPAID')
            .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

        // 🟢 HIPAA AUDIT LOG
        await writeAuditLog(requesterId || "SYSTEM", String(patientId), "READ_BILLING", "Viewed billing history", { region, ipAddress: req.ip });

        res.status(200).json({ transactions, outstandingBalance, currency: "USD" });

    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// 2. Prepare Secure Stripe Payment
export const payBill = async (req: Request, res: Response) => {
    try {
        const region = extractRegion(req);
        const regionalDb = getRegionalClient(region);

        const { billId, patientId, paymentMethodId } = req.body;
        const authReq = req as AuthRequest;
        const requesterId = authReq.user?.sub || authReq.user?.id;

        if (requesterId && requesterId !== patientId) {
            return res.status(403).json({ message: "Identity mismatch. Payment blocked." });
        }

        const stripeKey = await getSSMParameter("/mediconnect/stripe/keys", region, true);
        if (!stripeKey) throw new Error("Stripe configuration missing.");
        const stripe = new Stripe(stripeKey);

        const response = await regionalDb.send(new GetCommand({
            TableName: TABLE_TRANSACTIONS,
            Key: { billId }
        }));
        const billItem = response.Item;

        if (!billItem || billItem.patientId !== patientId) {
            return res.status(404).json({ message: "Bill not found." });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(Number(billItem.amount) * 100), 
            currency: 'usd',
            payment_method: paymentMethodId,
            confirm: true,
            off_session: false,
            metadata: { billId, patientId, type: billItem.type || "PHARMACY" },
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
        });

        if (paymentIntent.status === 'succeeded') {
            const timestamp = new Date().toISOString();

            await regionalDb.send(new UpdateCommand({
                TableName: TABLE_TRANSACTIONS,
                Key: { billId },
                UpdateExpression: "SET #s = :status, paidAt = :date, paymentIntentId = :pid",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":status": "PAID", ":date": timestamp, ":pid": paymentIntent.id }
            }));

            if (billItem.type === 'PHARMACY' && billItem.referenceId) {
                try {
                    await regionalDb.send(new UpdateCommand({
                        TableName: "mediconnect-prescriptions",
                        Key: { prescriptionId: billItem.referenceId },
                        UpdateExpression: "SET paymentStatus = :p",
                        ExpressionAttributeValues: { ":p": "PAID" }
                    }));
                } catch (e) { console.warn("Could not sync prescription status", e); }
            }

            // 🟢 HIPAA AUDIT LOG
            await writeAuditLog(requesterId || "SYSTEM", String(patientId), "BILL_PAID", `Paid bill ${billId}`, { region, ipAddress: req.ip });
            pushRevenueToBigQuery({
                billId,
                patientId,
                doctorId: billItem.doctorId || "UNKNOWN", // Pass Doctor ID from DB Item
                amount: Number(billItem.amount)
            }, region).catch(console.error);
        }

        res.status(200).json({ success: true, status: paymentIntent.status });

    } catch (error: any) {
        console.error("PayBill Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

export const getDoctorAnalytics = async (req: Request, res: Response) => {
    try {
        const region = extractRegion(req);
        const regionalDb = getRegionalClient(region);

        const { doctorId } = req.query;
        if (!doctorId) return res.status(400).json({ error: "Missing Doctor ID" });

        const command = new QueryCommand({
            TableName: TABLE_TRANSACTIONS,
            IndexName: "DoctorIndex",
            KeyConditionExpression: "doctorId = :did",
            ExpressionAttributeValues: { ":did": doctorId }
        });

        const response = await regionalDb.send(command);
        const allTxs = response.Items || [];

        const doctorSpecificTxs = allTxs.filter(t => t.type === 'BOOKING_FEE' || t.type === 'REFUND');
        const netRevenue = doctorSpecificTxs.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

        const feesCount = doctorSpecificTxs.filter(t => t.type === 'BOOKING_FEE').length;
        const refundsCount = doctorSpecificTxs.filter(t => t.type === 'REFUND').length;
        const finalConsultationCount = Math.max(0, feesCount - refundsCount);

        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const monthlyData: Record<string, number> = {};

        doctorSpecificTxs.forEach(t => {
            if (!t.createdAt) return;
            const month = monthNames[new Date(t.createdAt).getMonth()];
            monthlyData[month] = (monthlyData[month] || 0) + (Number(t.amount) || 0);
        });

        const chartData = Object.entries(monthlyData)
            .map(([month, revenue]) => ({ month, revenue: Math.max(0, revenue) }))
            .sort((a, b) => monthNames.indexOf(a.month) - monthNames.indexOf(b.month));

        // 🟢 HIPAA AUDIT LOG
        await writeAuditLog(String(doctorId), String(doctorId), "READ_ANALYTICS", "Doctor viewed financial analytics", { region, ipAddress: req.ip });

        res.status(200).json({
            totalRevenue: Math.max(0, netRevenue),
            consultationCount: finalConsultationCount,
            chartData: chartData.length > 0 ? chartData : [{ month: monthNames[new Date().getMonth()], revenue: 0 }],
            patientSatisfaction: "4.9"
        });

    } catch (error: any) {
        console.error("Analytics Error:", error);
        res.status(500).json({ error: error.message });
    }
};

// 🟢 GDPR FIX: Push revenue data to regional BigQuery
const pushRevenueToBigQuery = async (txData: any, region: string) => {
    try {
        const saKey = await getSSMParameter("/mediconnect/prod/gcp/service-account", region, true);
        if (!saKey) return;
        const credentials = JSON.parse(saKey);
        const dataset = region.toUpperCase() === 'EU' ? "mediconnect_analytics_eu" : "mediconnect_analytics";
        
        // Ensure you created this table with NUMERIC amount and TIMESTAMP
        const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${credentials.project_id}/datasets/${dataset}/tables/analytics_revenue/insertAll`;

        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" }, 
            body: JSON.stringify({
                rows: [{
                    json: {
                        transaction_id: txData.billId,
                        patient_id: txData.patientId,
                        doctor_id: txData.doctorId, // Ensure this exists in your bill item
                        amount: txData.amount,
                        currency: "USD",
                        status: "PAID",
                        timestamp: new Date().toISOString()
                    }
                }]
            })
        });
    } catch (e) { console.error("BigQuery Revenue Sync Failed"); }
};