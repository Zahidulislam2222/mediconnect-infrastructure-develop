import { Router } from "express";
import { getVitals } from "./vitals";
import { triggerEmergency } from "./emergency";
import { authMiddleware } from "../../middleware/auth.middleware";

const router = Router();

// 🟢 SECURITY: Apply Auth Middleware Globally for this Module
router.use(authMiddleware);

// Routes
router.get('/vitals', getVitals);
router.post('/emergency', triggerEmergency);

export default router;