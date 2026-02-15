import { Router } from 'express';
import * as DoctorController from '../controllers/doctor.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// ==========================================
// 1. DOCTOR PROFILE ROUTES
// ==========================================

// Create Doctor (Public)
router.post('/doctors', DoctorController.createDoctor);
router.post('/register-doctor', DoctorController.createDoctor);

// 🟢 FIX: Add GET route for Dashboard Profile Load
// This maps /register-doctor?id=... to getDoctor
router.get('/register-doctor', authMiddleware, DoctorController.getDoctor);

// Get Doctor Directory (Protected)
router.get('/doctors', authMiddleware, DoctorController.getDoctors);

// Get Specific Doctor (Protected)
router.get('/doctors/:id', authMiddleware, DoctorController.getDoctor);

// Update Doctor (Protected)
router.put('/doctors/:id', authMiddleware, DoctorController.updateDoctor);

// ==========================================
// 2. SCHEDULE ROUTES
// ==========================================
router.get('/doctors/:id/schedule', authMiddleware, DoctorController.getSchedule);
router.post('/doctors/:id/schedule', authMiddleware, DoctorController.updateSchedule);

// ==========================================
// 3. VERIFICATION ROUTES
// ==========================================
router.post('/doctors/:id/verify-diploma', authMiddleware, DoctorController.verifyDiploma);

// ==========================================
// 4. GOOGLE CALENDAR ROUTES (🟢 NEW)
// ==========================================
router.get('/doctors/:id/calendar/status', authMiddleware, DoctorController.getCalendarStatus);
router.get('/doctors/auth/google', authMiddleware, DoctorController.connectGoogleCalendar);
router.get('/doctors/auth/google/callback', DoctorController.googleCallback); // Callback handles its own state
router.delete('/doctors/:id/calendar', authMiddleware, DoctorController.disconnectGoogleCalendar);

export default router;