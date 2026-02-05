import { Router } from 'express';
import * as DoctorController from '../controllers/doctor.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Doctor Profile Routes
// Public Registration
router.post('/', DoctorController.createDoctor);
router.post('/register-doctor', DoctorController.createDoctor);

// Protected Routes
router.use(authMiddleware);

router.get('/:id', DoctorController.getDoctor);
router.put('/:id', DoctorController.updateDoctor);

// Schedule Routes
router.get('/:id/schedule', DoctorController.getSchedule);
router.post('/:id/schedule', DoctorController.updateSchedule);

// Verification
router.post('/:id/diploma/verify', DoctorController.verifyDiploma);

export default router;
