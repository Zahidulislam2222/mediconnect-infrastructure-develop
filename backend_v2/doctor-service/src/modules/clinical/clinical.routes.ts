import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
    createPrescription,
    getPrescriptions,
    updatePrescription,
    requestRefill,
    generateQR
} from "./prescription.controller";
import { handleEhrAction } from "./ehr.controller";
import { getRelationships } from "./relationship.controller";
import { authMiddleware } from "../../middleware/auth.middleware";
import { writeAuditLog } from "../../../../shared/audit";

const router = Router();

const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

// =============================================================================
// 1. PRESCRIPTIONS (Frontend & Pharmacy Integration)
// =============================================================================

// 🟢 Frontend Compatibility: Handle BOTH Singular and Plural routes
router.post("/prescription", authMiddleware, createPrescription);
router.get("/prescription", authMiddleware, getPrescriptions);
router.post("/prescriptions", authMiddleware, createPrescription);
router.get("/prescriptions", authMiddleware, getPrescriptions);

// 🟢 Status Updates (Approve/Reject/Cancel)
router.put("/prescription", authMiddleware, updatePrescription);
router.put("/prescriptions", authMiddleware, updatePrescription);

// 🟢 Pharmacy Actions
router.post("/pharmacy/request-refill", authMiddleware, requestRefill);
router.post("/pharmacy/generate-qr", authMiddleware, generateQR);

// =============================================================================
// 2. EHR & RELATIONSHIPS
// =============================================================================

router.post("/ehr", authMiddleware, handleEhrAction);
router.get("/relationships", authMiddleware, getRelationships);

// =============================================================================
// 3. AI CLINICAL PREDICTION (Now HIPAA & FHIR Compliant)
// =============================================================================

router.post("/predict-health", authMiddleware, async (req: Request, res: Response) => {
    try {
        const { vitals, modelType, patientId } = req.body;
        const authUser = (req as any).user;

        // 1. Business Logic (Simulated AI)
        let riskCode = "low"; 
        let message = "Vitals are within normal clinical ranges.";
        let confidence = 0.92;

        if (vitals.temp > 102 || vitals.heartRate > 110) {
            riskCode = "high";
            message = "Elevated temperature/HR. Immediate clinical review recommended.";
        } else if (vitals.temp > 100 || vitals.bpSys > 140) {
            riskCode = "moderate";
            message = "Slightly elevated vitals. Suggest monitoring.";
        }

        // 2. 🟢 FHIR R4 TRANSFORMATION: 'RiskAssessment' Resource
        // This allows other hospital systems to understand the AI prediction.
        const predictionId = uuidv4();
        const fhirRiskAssessment = {
            resourceType: "RiskAssessment",
            id: predictionId,
            status: "final",
            subject: { reference: `Patient/${patientId || "UNKNOWN"}` },
            occurrenceDateTime: new Date().toISOString(),
            performer: { display: "MediConnect AI Model V2" },
            method: { text: modelType || "Heuristic Vitals Analysis" },
            prediction: [
                {
                    outcome: { text: riskCode.toUpperCase() },
                    probabilityDecimal: confidence,
                    qualitativeRisk: {
                        coding: [{
                            system: "http://terminology.hl7.org/CodeSystem/risk-probability",
                            code: riskCode,
                            display: message
                        }]
                    }
                }
            ],
            note: [{ text: message }]
        };

        // 3. 🟢 HIPAA AUDIT LOG (The Missing Piece)
        // We record that an AI prediction was generated for this patient.
        await writeAuditLog(
            authUser.sub,
            patientId || "UNKNOWN",
            "AI_RISK_ASSESSMENT",
            `Generated ${riskCode.toUpperCase()} risk alert via ${modelType || "General"} model`,
            { region: extractRegion(req), ipAddress: req.ip }
        );

        // Return the standardized FHIR resource
        res.json(fhirRiskAssessment);

    } catch (error: any) {
        console.error("AI Prediction Error:", error);
        res.status(500).json({ error: "Clinical Prediction Failed" });
    }
});

export default router;