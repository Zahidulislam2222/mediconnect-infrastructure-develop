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

export default router;