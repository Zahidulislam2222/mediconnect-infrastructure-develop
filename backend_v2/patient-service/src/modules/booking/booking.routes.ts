import { Router } from 'express';
import { createBooking, getAppointments, cleanupAppointments } from './booking.controller';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

// Protected User Routes
router.post('/', authMiddleware, createBooking);
router.get('/', authMiddleware, getAppointments);

// Internal System Route (Protected by x-internal-secret in controller)
router.post('/cleanup', cleanupAppointments);

export default router;
