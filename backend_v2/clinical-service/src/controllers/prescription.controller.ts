import { Router, Request, Response } from "express";
import { PDFGenerator } from "../utils/pdf-generator";
import { docClient } from "../config/aws";
import { PutCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const router = Router();
const pdfGen = new PDFGenerator();
const TABLE_RX = "mediconnect-prescriptions";
const TABLE_DRUGS = "mediconnect-drug-interactions";

// POST /prescriptions - Create & Sign
router.post("/", async (req: Request, res: Response) => {
    const { doctorId, patientId, medication, dosage, instructions, doctorName, patientName } = req.body;

    if (!doctorId || !medication || !patientId) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        // 1. Interaction Check (Simplified)
        const drugData = await docClient.send(new GetCommand({
            TableName: TABLE_DRUGS,
            Key: { drugName: medication }
        }));

        // (In real logic, we'd check patient history here as per plan)

        // 2. Prepare Data
        const prescriptionId = uuidv4();
        const timestamp = new Date().toISOString();
        const rxData = {
            prescriptionId,
            patientName: patientName || "Unknown",
            doctorName: doctorName || "Unknown",
            medication,
            dosage,
            instructions,
            timestamp
        };

        // 3. Generate PDF & Sign
        const { pdfUrl, signature } = await pdfGen.generatePrescriptionPDF(rxData);

        // 4. Save to DB
        await docClient.send(new PutCommand({
            TableName: TABLE_RX,
            Item: {
                ...rxData,
                patientId,
                doctorId,
                signature,
                status: "ISSUED",
                pdfUrl: pdfUrl.split("?")[0] // Save base URL
            }
        }));

        res.json({
            message: "Prescription Issued & Signed",
            prescriptionId,
            signature,
            downloadUrl: pdfUrl
        });

    } catch (error: any) {
        console.error("RX Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// GET /prescriptions?patientId=...
router.get("/", async (req: Request, res: Response) => {
    const { patientId } = req.query;
    if (!patientId) return res.status(400).json({ error: "patientId required" });

    try {
        const data = await docClient.send(new QueryCommand({
            TableName: TABLE_RX,
            IndexName: "PatientIndex",
            KeyConditionExpression: "patientId = :pid",
            ExpressionAttributeValues: { ":pid": patientId }
        }));
        res.json(data.Items || []);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export const prescriptionController = router;
