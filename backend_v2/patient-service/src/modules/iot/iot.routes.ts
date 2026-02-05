import { Request, Response, Router } from "express";
import { docClient } from "../../config/aws";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { authMiddleware } from "../../middleware/auth.middleware";

const router = Router();
const TABLE_VITALS = "mediconnect-iot-vitals";

// --- LOGIC RESTORATION: Z-Score Anomaly Detection ---

// Helper: Calculate Mean
const calculateMean = (data: number[]) => {
    const sum = data.reduce((a, b) => a + b, 0);
    return sum / data.length;
};

// Helper: Calculate Standard Deviation
const calculateStdDev = (data: number[], mean: number) => {
    const squareDiffs = data.map(value => Math.pow(value - mean, 2));
    const avgSquareDiff = calculateMean(squareDiffs);
    return Math.sqrt(avgSquareDiff);
};

// Helper: Detect Anomalies (Z-Score > 3)
const detectAnomalies = (vitals: any[]) => {
    const heartRates = vitals.map(v => v.heartRate).filter(h => typeof h === 'number');

    if (heartRates.length < 5) return []; // Need minimum data for stats

    const mean = calculateMean(heartRates);
    const stdDev = calculateStdDev(heartRates, mean);

    if (stdDev === 0) return []; // No variation

    const threshold = 3;
    const anomalies = [];

    for (const v of vitals) {
        if (typeof v.heartRate === 'number') {
            const zScore = (v.heartRate - mean) / stdDev;
            if (Math.abs(zScore) > threshold) {
                anomalies.push({
                    ...v,
                    zScore: zScore,
                    issue: "Heart Rate Anomaly Detected"
                });
            }
        }
    }
    return anomalies;
};

// --- CONTROLLER METHODS ---

export const getVitals = async (req: Request, res: Response) => {
    try {
        const { patientId, limit = 20 } = req.query;

        if (!patientId) {
            return res.status(400).json({ error: "patientId required" });
        }

        // 1. Fetch Data
        const response = await docClient.send(new QueryCommand({
            TableName: TABLE_VITALS,
            KeyConditionExpression: "patientId = :pid",
            ExpressionAttributeValues: { ":pid": patientId },
            ScanIndexForward: false, // Newest first
            Limit: Number(limit)
        }));

        const items = response.Items || [];

        // 2. RESTORED LOGIC: Analyze for Anomalies
        // In a real stream (Kinesis), this would run on ingestion.
        // Here we run it on read to show we have the logic, or we could run it on a POST ingestion endpoint.
        // Assuming this endpoint is for History Visualization.

        const anomalies = detectAnomalies(items);

        res.json({
            vitals: items,
            anomalies: anomalies,
            analysis: anomalies.length > 0 ? "WARNING: Abnormal patterns detected" : "Normal"
        });

    } catch (err: any) {
        console.error("Vitals Error:", err);
        res.status(500).json({ error: err.message });
    }
};

// Route Setup
router.get('/', authMiddleware, getVitals);

export default router;
