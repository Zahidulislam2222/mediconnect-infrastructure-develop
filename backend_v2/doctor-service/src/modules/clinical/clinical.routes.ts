import { Router } from "express";
import { createPrescription, getPrescriptions } from "./prescription.controller";
import { getUploadUrl, getViewUrl } from "./ehr.controller";
import { analyzeImage } from "./imaging.controller";
import { authMiddleware } from "../../middleware/auth.middleware";

const router = Router();

// In Doctor Service, we route these as:
// /clinical/prescriptions
// /clinical/ehr
// /clinical/imaging

// Prescriptions
router.post("/prescriptions", authMiddleware, createPrescription);
router.get("/prescriptions", authMiddleware, getPrescriptions);

// EHR
router.post("/ehr/upload-url", authMiddleware, getUploadUrl);
router.post("/ehr/view-url", authMiddleware, getViewUrl);

// Imaging
router.post("/imaging/analyze", authMiddleware, analyzeImage);

export default router;
