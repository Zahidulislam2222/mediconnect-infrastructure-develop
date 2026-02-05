import { Router } from 'express';
import { createPatient, getDemographics, getProfile, updateProfile, verifyIdentity, deleteProfile } from '../controllers/patient.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Public / Utility
router.get('/stats/demographics', getDemographics);

// Public Registration
router.post('/', createPatient);
router.post('/register-patient', createPatient);

// Protected Routes
router.use(authMiddleware);

router.delete('/me', deleteProfile); // GDPR Right to be Forgotten

router.get('/:id', getProfile);
router.put('/:id', updateProfile);

// Identity Verification
router.post('/identity/verify', verifyIdentity);

export default router;
