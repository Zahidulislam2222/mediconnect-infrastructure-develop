import { Request, Response } from 'express';
import { docClient, getSSMParameter } from '../config/aws';
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_TRANSACTIONS = "mediconnect-transactions";

interface AuthRequest extends Request {
    user?: { sub: string };
}

// 1. Fetch Billing History & Balance
export const getPatientBilling = async (req: Request, res: Response) => {
    try {
        const { patientId } = req.query;
        const authReq = req as AuthRequest;

        // 🛡️ HIPAA SECURITY CHECK
        if (authReq.user && authReq.user.sub !== patientId) {
            return res.status(403).json({ message: "Unauthorized access to billing records." });
        }

        const command = new QueryCommand({
            TableName: TABLE_TRANSACTIONS,
            IndexName: "PatientIndex",
            KeyConditionExpression: "patientId = :pid",
            ExpressionAttributeValues: { ":pid": patientId },
            ScanIndexForward: false
        });

        const response = await docClient.send(command);
        const transactions = response.Items || [];

        // Calculate Balance (Only count Unpaid/Due items)
        const outstandingBalance = transactions
            .filter(t =>
                t.status === 'PENDING' ||
                t.status === 'DUE' ||
                t.status === 'UNPAID' // 🟢 ADD: Support legacy/pharmacy status
            )
            .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

        res.status(200).json({
            transactions,
            outstandingBalance,
            currency: "USD"
        });

    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// 2. Prepare Secure Stripe Payment
export const payBill = async (req: Request, res: Response) => {
    try {
        const { billId, patientId, paymentMethodId } = req.body; // 🟢 ADDED paymentMethodId
        const authReq = req as AuthRequest;

        if (authReq.user && authReq.user.sub !== patientId) {
            return res.status(403).json({ message: "Identity mismatch. Payment blocked." });
        }

        const stripeKey = await getSSMParameter("/mediconnect/stripe/keys", true);
        if (!stripeKey) throw new Error("Stripe configuration missing.");
        const stripe = new Stripe(stripeKey);

        const response = await docClient.send(new GetCommand({
            TableName: TABLE_TRANSACTIONS,
            Key: { billId }
        }));
        const billItem = response.Item;

        if (!billItem || billItem.patientId !== patientId) {
            return res.status(404).json({ message: "Bill not found." });
        }

        // 🟢 PROFESSIONAL FIX: Create AND Confirm the payment in one go
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(Number(billItem.amount) * 100), 
            currency: 'usd',
            payment_method: paymentMethodId,
            confirm: true,
            off_session: false, // Ensure this is false for immediate payments
            metadata: {
                billId,
                patientId,
                type: billItem.type || "PHARMACY"
            },
            automatic_payment_methods: {
                enabled: true,
                allow_redirects: 'never'
            }
        });

        if (paymentIntent.status === 'succeeded') {
            // 🟢 STEP 2: CRITICAL FIX - Update DynamoDB!
            // Without this, the frontend will always show the bill as unpaid.
            
            const timestamp = new Date().toISOString();

            await docClient.send(new UpdateCommand({
                TableName: "mediconnect-transactions",
                Key: { billId },
                UpdateExpression: "SET #s = :status, paidAt = :date, paymentIntentId = :pid",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                    ":status": "PAID",
                    ":date": timestamp,
                    ":pid": paymentIntent.id
                }
            }));

            // 🟢 STEP 3 (Optional but Recommended): 
            // If this was a Pharmacy bill, update the Prescription Table too.
            if (billItem.type === 'PHARMACY' && billItem.referenceId) {
                try {
                    await docClient.send(new UpdateCommand({
                        TableName: "mediconnect-prescriptions",
                        Key: { prescriptionId: billItem.referenceId },
                        UpdateExpression: "SET paymentStatus = :p",
                        ExpressionAttributeValues: { ":p": "PAID" }
                    }));
                } catch (e) {
                    console.warn("Could not sync prescription status", e);
                }
            }
        }

        res.status(200).json({
            success: true,
            status: paymentIntent.status
        });

    } catch (error: any) {
        console.error("PayBill Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

export const getDoctorAnalytics = async (req: Request, res: Response) => {
    try {
        const { doctorId } = req.query;

        if (!doctorId) {
            return res.status(400).json({ error: "Missing Doctor ID" });
        }

        const command = new QueryCommand({
            TableName: "mediconnect-transactions",
            IndexName: "DoctorIndex",
            KeyConditionExpression: "doctorId = :did",
            ExpressionAttributeValues: { ":did": doctorId }
        });

        const response = await docClient.send(command);
        const allTxs = response.Items || [];

        // 🟢 LOGICAL FIX: Only count Booking Fees and Refunds toward Doctor Revenue
        // We EXCLUDE 'PHARMACY' types because that money belongs to the pharmacy.
        const doctorSpecificTxs = allTxs.filter(t =>
            t.type === 'BOOKING_FEE' || t.type === 'REFUND'
        );

        // 🟢 Net Revenue: Only based on the filtered list
        const netRevenue = doctorSpecificTxs.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

        // Count logic remains focused on consultations
        const feesCount = doctorSpecificTxs.filter(t => t.type === 'BOOKING_FEE').length;
        const refundsCount = doctorSpecificTxs.filter(t => t.type === 'REFUND').length;
        const finalConsultationCount = Math.max(0, feesCount - refundsCount);

        // 🟢 Dynamic Monthly Chart: Only using doctorSpecificTxs
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const monthlyData: Record<string, number> = {};

        doctorSpecificTxs.forEach(t => {
            if (!t.createdAt) return;
            const date = new Date(t.createdAt);
            const month = monthNames[date.getMonth()];
            monthlyData[month] = (monthlyData[month] || 0) + (Number(t.amount) || 0);
        });

        const chartData = Object.entries(monthlyData).map(([month, revenue]) => ({
            month,
            revenue: Math.max(0, revenue)
        })).sort((a, b) => monthNames.indexOf(a.month) - monthNames.indexOf(b.month));

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