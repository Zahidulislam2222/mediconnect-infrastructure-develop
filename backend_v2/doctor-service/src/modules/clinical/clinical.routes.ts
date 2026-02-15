import { Router } from "express";
import {
    createPrescription,
    getPrescriptions,
    updatePrescription,
    requestRefill,   // 🟢 Import this
    generateQR       // 🟢 Import this
} from "./prescription.controller";
import { getUploadUrl, getViewUrl } from "./ehr.controller";
import { authMiddleware } from "../../middleware/auth.middleware";
import { handleEhrAction } from "./ehr.controller";
import { getRelationships } from "./relationship.controller";

const router = Router();

// --- PRESCRIPTIONS ---
// 🟢 Handle BOTH Singular (Frontend uses this) and Plural
router.post("/prescription", authMiddleware, createPrescription);
router.get("/prescription", authMiddleware, getPrescriptions);
router.post("/prescriptions", authMiddleware, createPrescription);
router.get("/prescriptions", authMiddleware, getPrescriptions);

// 🟢 NEW: Handles the "Approve" button and status updates
router.put("/prescription", authMiddleware, updatePrescription);
router.put("/prescriptions", authMiddleware, updatePrescription);

// --- PHARMACY (New) ---
// 🟢 Add these routes so buttons work
router.post("/pharmacy/request-refill", authMiddleware, requestRefill);
router.post("/pharmacy/generate-qr", authMiddleware, generateQR);

// --- EHR ---
router.post("/ehr", authMiddleware, handleEhrAction);
router.get("/relationships", authMiddleware, getRelationships);

// Add this under the IMAGING section
router.post("/predict-health", authMiddleware, (req, res) => {
    const { vitals, modelType } = req.body;

    // 🟢 Simulated Medical Logic
    let risk = "LOW";
    let message = "Vitals are within normal clinical ranges.";

    if (vitals.temp > 102 || vitals.heartRate > 110) {
        risk = "HIGH";
        message = "Elevated temperature and heart rate detected. Immediate clinical review recommended.";
    } else if (vitals.temp > 100 || vitals.bpSys > 140) {
        risk = "MODERATE";
        message = "Slightly elevated vitals. Suggest monitoring and follow-up consultation.";
    }

    res.json({
        confidence: 0.92,
        modelType,
        output: { risk, message }
    });
});

export default router;