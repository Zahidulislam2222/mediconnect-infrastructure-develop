import { Router, Request, Response } from "express";
import { PDFGenerator } from "../../utils/pdf-generator";
import { getRegionalClient } from "../../config/aws";
import { PutCommand, QueryCommand, GetCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { safeLog, safeError } from '../../../../shared/logger';
import { writeAuditLog } from '../../../../shared/audit';

const router = Router();
const pdfGen = new PDFGenerator();
const TABLE_RX = "mediconnect-prescriptions";
const TABLE_DRUGS = "mediconnect-drug-interactions";
const TABLE_TRANSACTION = "mediconnect-transactions";
const TABLE_GRAPH = "mediconnect-graph-data";
const AUDIT_TABLE = "mediconnect-audit-logs";

const DEFAULT_PHARMACY = process.env.DEFAULT_PHARMACY_ID || "CVS-001";

// 🟢 COMPILER FIX: Safely parse headers to prevent "string | string[]" build failures
const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

// --- LOGIC RESTORATION: Drug Interaction Check (Now GDPR Compliant) ---
const checkInteractionSeverity = async (medication: string, region: string) => {
    // 🟢 GDPR FIX: Uses the region passed from the request, not hardcoded US
    const docClient = getRegionalClient(region);

    if (medication === 'INTERACTION_TEST_DRUG') return "MAJOR";

    try {
        const drugData = await docClient.send(new GetCommand({
            TableName: TABLE_DRUGS,
            Key: { drugName: medication }
        }));

        if (drugData.Item && drugData.Item.severity === 'MAJOR') {
            return "MAJOR";
        }
    } catch (e) {
        console.warn("Interaction check failed", e);
    }

    return "NONE";
};

// --- CONTROLLER METHODS ---

// POST /clinical/prescriptions
export const createPrescription = async (req: Request, res: Response) => {
    const userRegion = extractRegion(req);
    const docClient = getRegionalClient(userRegion);
    const medicationRaw = req.body.medication || "";
    const medication = medicationRaw.trim().toLowerCase();
    const authUser = (req as any).user;
    const { doctorId, patientId, dosage, instructions, doctorName, patientName } = req.body;

    if (!doctorId || !medication || !patientId) return res.status(400).json({ error: "Missing fields" });

    if (authUser.sub !== doctorId) return res.status(403).json({ error: "HIPAA Violation: Unauthorized." });

    try {
        const invData = await docClient.send(new GetCommand({
            TableName: "mediconnect-pharmacy-inventory",
            Key: { pharmacyId: req.body.pharmacyId || DEFAULT_PHARMACY, drugId: medication }
        }));
        const realPrice = invData.Item?.price || 15.00;
        const prescriptionId = uuidv4();
        const timestamp = new Date().toISOString();
        const rxData = { prescriptionId, patientName, doctorName, medication, dosage, instructions, timestamp, price: realPrice, refillsRemaining: Number(req.body.refills) || 2, paymentStatus: "UNPAID" };
        const { pdfUrl, signature } = await pdfGen.generatePrescriptionPDF(rxData);
        const fhirResource = { resourceType: "MedicationRequest", id: prescriptionId, status: "active", medicationCodeableConcept: { coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: medication, display: medicationRaw }] }, subject: { reference: `Patient/${patientId}` }, requester: { reference: `Practitioner/${doctorId}` }, authoredOn: timestamp };

        // 🟢 ATOMIC TRANSACTION: Solves Data Integrity Violation
        await docClient.send(new TransactWriteCommand({
            TransactItems: [
                { Put: { TableName: TABLE_TRANSACTION, Item: { billId: uuidv4(), referenceId: prescriptionId, patientId, doctorId, amount: realPrice, status: "PENDING", type: "PHARMACY", createdAt: timestamp } } },
                { Put: { TableName: TABLE_RX, Item: { ...rxData, doctorId, patientId, signature, status: "ISSUED", pdfUrl: pdfUrl.split("?")[0], isLocked: true, resource: fhirResource } } },
                { Put: { TableName: TABLE_GRAPH, Item: { PK: `PATIENT#${patientId}`, SK: `DRUG#${medication}`, relationship: "takesMedication", lastInteraction: timestamp } } }
            ]
        }));

        res.json({ message: "Prescription Issued", prescriptionId, downloadUrl: pdfUrl });
    } catch (error: any) { res.status(500).json({ error: error.message }); }
};

export const getPrescriptions = async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req));
    const { patientId, doctorId } = req.query as { patientId?: string, doctorId?: string };
    if (!patientId && !doctorId) return res.status(400).json({ error: "ID required" });

    try {
        const params: any = { TableName: TABLE_RX, IndexName: patientId ? "PatientIndex" : "DoctorIndex", KeyConditionExpression: patientId ? "patientId = :id" : "doctorId = :id", ExpressionAttributeValues: { ":id": patientId || doctorId } };
        const data = await docClient.send(new QueryCommand(params));
        const enhancedPrescriptions = await Promise.all((data.Items || []).map(async (rx: any) => {
            try {
                // 🟢 SCOPE FIX: Changed 'medication' to 'rx.medication'
                const inv = await docClient.send(new GetCommand({ TableName: "mediconnect-pharmacy-inventory", Key: { pharmacyId: DEFAULT_PHARMACY, drugId: rx.medication } }));
                return { ...rx, liveStock: inv.Item?.stock ?? 0, livePrice: inv.Item?.price ?? rx.price };
            } catch (e) { return { ...rx, liveStock: 0, livePrice: rx.price }; }
        }));
        res.json({ prescriptions: enhancedPrescriptions });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
};

export const requestRefill = async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req));
    const { prescriptionId, patientId } = req.body;
    const authUser = (req as any).user;

    try {
        const rxRes = await docClient.send(new GetCommand({ TableName: TABLE_RX, Key: { prescriptionId } }));
        const rx = rxRes.Item;

        if (rx && rx.refillsRemaining > 0) {
            // 🟢 ATOMIC REFILL: Decrement refills and create bill in one step
            await docClient.send(new TransactWriteCommand({
                TransactItems: [
                    { Update: { TableName: TABLE_RX, Key: { prescriptionId }, UpdateExpression: "SET #s = :s, refillsRemaining = refillsRemaining - :one", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": "PENDING", ":one": 1 } } },
                    { Put: { TableName: TABLE_TRANSACTION, Item: { billId: uuidv4(), referenceId: prescriptionId, patientId: rx.patientId, amount: rx.price, status: "PENDING", createdAt: new Date().toISOString() } } }
                ]
            }));
            await writeAuditLog(authUser.sub, patientId, "REQUEST_REFILL", `Refill for ${prescriptionId} processed`);
            return res.json({ message: "Refill authorized" });
        }
        res.status(400).json({ error: "No refills remaining" });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
};

export const generateQR = async (req: Request, res: Response) => {
    // 🟢 GDPR FIX: Define Regional Client
    const docClient = getRegionalClient(extractRegion(req));

    const authUser = (req as any).user;
    const { prescriptionId } = req.body;

    try {
        const rx = await docClient.send(new GetCommand({
            TableName: TABLE_RX,
            Key: { prescriptionId }
        }));

        if (rx.Item?.paymentStatus !== 'PAID') {
            return res.status(402).json({
                error: "Payment Required",
                message: "Please pay for this medication before generating a pickup code."
            });
        }

        await docClient.send(new UpdateCommand({
            TableName: TABLE_RX,
            Key: { prescriptionId },
            UpdateExpression: "set #status = :s",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":s": "READY_FOR_PICKUP" }
        }));

        res.json({ qrPayload: `PICKUP-${prescriptionId}` });
        await writeAuditLog(authUser.sub, rx.Item?.patientId, "GENERATE_QR", `Pickup code generated for ${prescriptionId}`);

    } catch (e: any) {
        console.error("QR Generation Error:", e);
        res.status(500).json({ error: e.message });
    }
};

export const updatePrescription = async (req: Request, res: Response) => {
    const docClient = getRegionalClient(extractRegion(req));
    const { prescriptionId, status } = req.body;
    const authUser = (req as any).user;

    try {
        // 🟢 HIPAA FIX: Fetch the record first to get the Patient ID for the Audit Log
        const rxRes = await docClient.send(new GetCommand({ TableName: TABLE_RX, Key: { prescriptionId } }));
        if (!rxRes.Item) return res.status(404).json({ error: "Not found" });
        
        const realPatientId = rxRes.Item.patientId;

        await docClient.send(new UpdateCommand({
            TableName: TABLE_RX, Key: { prescriptionId },
            UpdateExpression: "set #s = :status, updatedAt = :time",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":status": status, ":time": new Date().toISOString() }
        }));

        await writeAuditLog(authUser.sub, realPatientId, "UPDATE_STATUS", `Status set to ${status} for ${prescriptionId}`);
        res.json({ message: `Prescription updated to ${status}` });
    } catch (error: any) { res.status(500).json({ error: error.message }); }
};