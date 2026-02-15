import { Router, Request, Response } from "express";
import { PDFGenerator } from "../../utils/pdf-generator";
import { docClient } from "../../config/aws";
import { PutCommand, QueryCommand, GetCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { query } from "../../config/db";
import { safeLog, safeError } from '../../../../shared/logger';

const router = Router();
const pdfGen = new PDFGenerator();
const TABLE_RX = "mediconnect-prescriptions";
const TABLE_DRUGS = "mediconnect-drug-interactions";
const TABLE_TRANSACTION = "mediconnect-transactions";
const TABLE_GRAPH = "mediconnect-graph-data"; // 🟢 Added for Care Network
const AUDIT_TABLE = "mediconnect-audit-logs";

const writeAuditLog = async (actorId: string, patientId: string, action: string, details: string) => {
    try {
        await docClient.send(new PutCommand({
            TableName: AUDIT_TABLE,
            Item: {
                logId: uuidv4(),
                timestamp: new Date().toISOString(),
                actorId,
                patientId,
                action,
                details,
                metadata: { platform: "MediConnect-v2", module: "Prescription" }
            }
        }));
    } catch (e) { console.error("Audit Log Failed", e); }
};

// --- LOGIC RESTORATION: Drug Interaction Check ---

const checkInteractionSeverity = async (medication: string) => {
    // In legacy, this checked against a secondary drug or patient history.
    // For this restoration, we check if the drug itself has a "MAJOR" flag 
    // or if it conflicts with a hardcoded "Contraindicated_Med" for demo parity.
    // Ideally, we'd fetch patient's current meds here.

    // Simulating Legacy Logic: "Simplified interaction check (Mock)" from main.py
    // interaction = table.get_item(Key={'drug1_id': drug_id, 'drug2_id': 'EXISTING_MED_ID'}) 

    if (medication === 'INTERACTION_TEST_DRUG') return "MAJOR";

    // Real DB Check
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
    // --- STEP 0. NORMALIZE & VALIDATE ---
    const medicationRaw = req.body.medication || "";
    // 🟢 Fix 1: Force lowercase to prevent "Napa" vs "napa" mismatch
    const medication = medicationRaw.trim().toLowerCase();

    // 🟢 AUTH TOKEN FOR AUDIT
    const authUser = (req as any).user;

    const { doctorId, patientId, dosage, instructions, doctorName, patientName } = req.body;

    if (!doctorId || !medication || !patientId) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // 🟢 SECURITY: Verify Identity
    const isDoctor = authUser['cognito:groups']?.some((g: string) => ['doctor', 'doctors'].includes(g.toLowerCase()));
    if (!isDoctor) return res.status(403).json({ error: "Only doctors can prescribe." });

    try {
        // --- STEP 1. SECURITY: Officer Approval Check (GCP Postgres) ---
        const docCheck = await query("SELECT data->>'isOfficerApproved' as approved FROM doctors WHERE id = $1", [doctorId]);
        if (!docCheck.rows[0] || docCheck.rows[0].approved !== 'true') {
            return res.status(403).json({ error: "Forbidden", message: "Your medical credentials are not verified." });
        }

        // --- STEP 2. SAFETY: Duplication Check (AWS DynamoDB) ---
        // 🟢 Fix 4: Check if patient already has an UNPAID or READY prescription for this drug
        const existingRx = await docClient.send(new QueryCommand({
            TableName: TABLE_RX,
            IndexName: "PatientIndex",
            KeyConditionExpression: "patientId = :pid",
            // Filter out cases where they already have an active lifecycle for this drug
            FilterExpression: "medication = :m AND (#s = :s1 OR #s = :s2)",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
                ":pid": patientId,
                ":m": medication,
                ":s1": "ISSUED",
                ":s2": "READY_FOR_PICKUP"
            }
        }));

        if (existingRx.Items && existingRx.Items.length > 0) {
            return res.status(409).json({
                error: "Duplicate Active Prescription",
                message: "Patient already has an active order for this medication."
            });
        }

        // --- STEP 3. LOGISTICS: Lookup Price ---
        // Use normalized name to find inventory
        const invData = await docClient.send(new GetCommand({
            TableName: "mediconnect-pharmacy-inventory",
            Key: { pharmacyId: "CVS-001", drugId: medication } // 🟢 Inventory must also use lowercase keys!
        }));

        const realPrice = invData.Item?.price || 15.00;

        // --- STEP 4. PREPARE DATA ---
        const prescriptionId = uuidv4();
        const timestamp = new Date().toISOString();
        const rxData = {
            prescriptionId,
            patientName: patientName || "Patient",
            doctorName: doctorName || "Doctor",
            medication, // 🟢 Saved as lowercase
            dosage,
            instructions,
            timestamp,
            price: realPrice,
            // 🟢 Fix: Remove 'stock' column from here. Stock is now a Live Join.
            refillsRemaining: Number(req.body.refills) || 2,
            paymentStatus: "UNPAID"
        };

        // 5. LEGAL: Generate PDF & KMS Sign (AWS)
        const { pdfUrl, signature } = await pdfGen.generatePrescriptionPDF(rxData);

        // --- 6. REVENUE: Create billing record ---
        await docClient.send(new PutCommand({
            TableName: TABLE_TRANSACTION,
            Item: {
                billId: uuidv4(),
                referenceId: prescriptionId,
                patientId: patientId,
                doctorId: doctorId,
                description: `Medication: ${medication}`,
                amount: realPrice,
                status: "PENDING", // 🟢 CHANGE: From "UNPAID" to "PENDING"
                type: "PHARMACY",
                createdAt: new Date().toISOString()
            }
        }));

        // 🟢 FHIR TRANSFORMATION: MedicationRequest
        const fhirResource = {
            resourceType: "MedicationRequest",
            id: prescriptionId,
            status: "active",
            intent: "order",
            medicationCodeableConcept: {
                coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: medication, display: medicationRaw }]
            },
            subject: { reference: `Patient/${patientId}` },
            requester: { reference: `Practitioner/${doctorId}`, display: doctorName },
            dosageInstruction: [{ text: dosage, patientInstruction: instructions }],
            dispenseRequest: {
                numberOfRepeatsAllowed: Number(req.body.refills) || 2,
                quantity: { value: 1, unit: "package" }
            },
            authoredOn: timestamp
        };

        // 7. STORAGE: Save RX to Main Table with FHIR
        await docClient.send(new PutCommand({
            TableName: TABLE_RX,
            Item: {
                ...rxData,
                doctorId,
                patientId,
                signature,
                status: "ISSUED",
                pdfUrl: pdfUrl.split("?")[0],
                isLocked: true, // 🟢 IMMUTABILITY
                resource: fhirResource // 🟢 RAW FHIR JSON
            }
        }));

        await writeAuditLog(authUser.sub, patientId, "CREATE_FHIR_RESOURCE", `Resource: MedicationRequest/${prescriptionId}`);

        try {
            await docClient.send(new PutCommand({
                TableName: TABLE_GRAPH,
                Item: {
                    PK: `PATIENT#${patientId}`,
                    SK: `DRUG#${medication}`, // 🟢 Uses the normalized lowercase name
                    relationship: "takesMedication",
                    doctorName: doctorName,
                    prescribedBy: doctorId,
                    dosage: dosage,
                    lastInteraction: timestamp,
                    createdAt: timestamp
                }
            }));

            // Optional: Link the drug to the doctor's network too
            await docClient.send(new PutCommand({
                TableName: TABLE_GRAPH,
                Item: {
                    PK: `DOCTOR#${doctorId}`,
                    SK: `DRUG#${medication}`,
                    relationship: "prescribed",
                    patientName: patientName || "Patient",
                    createdAt: timestamp
                }
            }));
        } catch (graphError) {
            console.warn("Graph link failed, but prescription was still issued:", graphError);
        }

        // 8. SUCCESS RESPONSE
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
};

export const getPrescriptions = async (req: Request, res: Response) => {
    const authUser = (req as any).user; // 🟢 Auth
    const patientId = req.query.patientId as string;
    const doctorId = req.query.doctorId as string;

    if (!patientId && !doctorId) {
        return res.status(400).json({ error: "patientId or doctorId required" });
    }

    try {
        const params: any = { TableName: TABLE_RX };

        if (patientId) {
            params.IndexName = "PatientIndex";
            params.KeyConditionExpression = "patientId = :id";
            params.ExpressionAttributeValues = { ":id": patientId };
        } else {
            // 🟢 FIXED: Explicitly use the DoctorIndex
            params.IndexName = "DoctorIndex";
            params.KeyConditionExpression = "doctorId = :id";
            params.ExpressionAttributeValues = { ":id": doctorId };
        }

        const data = await docClient.send(new QueryCommand(params));
        const prescriptions = data.Items || [];

        const enhancedPrescriptions = await Promise.all(prescriptions.map(async (rx) => {
            try {
                // 🟢 FIXED: Try exact match first (Case Sensitive), then lowercase
                let inv = await docClient.send(new GetCommand({
                    TableName: "mediconnect-pharmacy-inventory",
                    Key: { pharmacyId: "CVS-001", drugId: rx.medication }
                }));

                if (!inv.Item) {
                    // Fallback to lowercase if exact match fails
                    inv = await docClient.send(new GetCommand({
                        TableName: "mediconnect-pharmacy-inventory",
                        Key: { pharmacyId: "CVS-001", drugId: rx.medication.toLowerCase() }
                    }));
                }

                return {
                    ...rx,
                    liveStock: inv.Item?.stock ?? 0,
                    livePrice: inv.Item?.price ?? rx.price
                };
            } catch (e) {
                return { ...rx, liveStock: 0, livePrice: rx.price };
            }
        }));

        await writeAuditLog(authUser.sub, patientId || "ALL_PATIENTS", "LIST_PRESCRIPTIONS", `Viewed ${prescriptions.length} records`);
        res.json({ prescriptions: enhancedPrescriptions });
    } catch (err: any) {
        console.error("Fetch RX Error:", err.message);
        res.status(500).json({ error: err.message });
    }
};

// 🟢 ADD THESE NEW FUNCTIONS AT THE BOTTOM

export const requestRefill = async (req: Request, res: Response) => {
    const authUser = (req as any).user;
    const { prescriptionId, patientId } = req.body;
    try {
        // 1. Get the current RX
        const rxRes = await docClient.send(new GetCommand({
            TableName: TABLE_RX,
            Key: { prescriptionId }
        }));
        const rx = rxRes.Item;

        // 2. LOGIC: Check counter
        if (rx && rx.refillsRemaining > 0) {
            // PATIENT HAS REFILLS: Just charge them again
            const newBillId = uuidv4();
            await docClient.send(new TransactWriteCommand({
                TransactItems: [
                    {
                        Update: {
                            TableName: TABLE_RX,
                            Key: { prescriptionId },
                            UpdateExpression: "SET #s = :s, refillsRemaining = refillsRemaining - :one, paymentStatus = :unpaid",
                            ExpressionAttributeNames: { "#s": "status" },
                            ExpressionAttributeValues: { ":s": "PENDING", ":one": 1, ":unpaid": "UNPAID" }
                        }
                    },
                    {
                        // 🟢 Update the Graph to show the medication is still active
                        Update: {
                            TableName: TABLE_GRAPH,
                            Key: { PK: `PATIENT#${rx.patientId}`, SK: `DRUG#${rx.medication}` },
                            UpdateExpression: "SET lastInteraction = :now",
                            ExpressionAttributeValues: { ":now": new Date().toISOString() }
                        }
                    },
                    {
                        Put: {
                            TableName: "mediconnect-transactions",
                            Item: {
                                billId: newBillId,
                                referenceId: prescriptionId,
                                patientId: rx.patientId,
                                doctorId: rx.doctorId, // 🟢 ADD THIS for analytics
                                amount: rx.price,
                                description: `Medication: ${rx.medication}`, // 🟢 FIXED: This was missing!
                                status: "PENDING",
                                type: "PHARMACY",
                                createdAt: new Date().toISOString()
                            }
                        }
                    }

                ]
            }));
            await writeAuditLog(authUser.sub, patientId, "REQUEST_REFILL", `Refill for ${prescriptionId} authorized`);
            return res.json({ message: "Refill authorized. Please proceed to payment." });
        }

        // NO REFILLS: Require Doctor Approval (Current Logic)
        await docClient.send(new UpdateCommand({
            TableName: TABLE_RX,
            Key: { prescriptionId },
            UpdateExpression: "set #status = :s, updatedAt = :t",
            ExpressionAttributeValues: { ":s": "REFILL_REQUESTED", ":t": new Date().toISOString() }
        }));
        await writeAuditLog(authUser.sub, patientId, "REQUEST_REFILL_APPROVAL", `Doctor approval needed for ${prescriptionId}`);
        res.json({ message: "Refill request sent to your doctor for approval." });

    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
};

export const generateQR = async (req: Request, res: Response) => {
    const authUser = (req as any).user;
    const { prescriptionId } = req.body;

    try {
        // 1. Check if paid in DynamoDB (Architecture #2 Requirement)
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

        // 2. If paid, update status to READY_FOR_PICKUP
        await docClient.send(new UpdateCommand({
            TableName: "mediconnect-prescriptions",
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
    const authUser = (req as any).user;
    const { prescriptionId, status } = req.body;

    if (!prescriptionId || !status) {
        return res.status(400).json({ error: "prescriptionId and status required" });
    }

    try {
        await docClient.send(new UpdateCommand({
            TableName: "mediconnect-prescriptions",
            Key: { prescriptionId },
            UpdateExpression: "set #s = :status, updatedAt = :time",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
                ":status": status,
                ":time": new Date().toISOString()
            }
        }));

        res.json({ message: `Prescription updated to ${status}` });
        await writeAuditLog(authUser.sub, "UNKNOWN_PATIENT", "UPDATE_STATUS", `Status set to ${status} for ${prescriptionId}`);
    } catch (error: any) {
        console.error("Update RX Error:", error);
        res.status(500).json({ error: error.message });
    }
};
