import { Router } from "express";
import { authMiddleware } from "../middleware/auth.middleware";
import { analyzeClinicalImage } from "../controllers/imaging.controller";
import { predictRisk, summarizeConsultation } from "../controllers/predictive.controller";
import { checkSymptoms } from "../controllers/symptom.controller";

const router = Router();

// =============================================================================
// 🧠 CLINICAL AI ROUTES (HIPAA & GDPR Protected)
//Base Path: /api/v1/communication/ai
// =============================================================================

// 1. Radiology/Dermatology Vision Analysis
// POST /ai/imaging
router.post("/imaging", authMiddleware, analyzeClinicalImage);

// 2. Predictive Risk (Sepsis, Readmission)
// POST /ai/predict
router.post("/predict", authMiddleware, predictRisk);

// 3. Clinical Scribe (Summarize Transcript)
// POST /ai/summarize
router.post("/summarize", authMiddleware, summarizeConsultation);

// 4. Symptom Checker (Patient Triage)
// POST /ai/symptoms
router.post("/symptoms", authMiddleware, checkSymptoms);

export const aiRoutes = router;