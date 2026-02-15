import { Router } from 'express';
import {
    createBooking,
    getAppointments,
    cleanupAppointments,
    cancelBookingUser,
    getReceipt,
    updateAppointment // CHANGED: Import the new atomic function
} from '../controllers/booking.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import {
    getPatientBilling,
    payBill,
    getDoctorAnalytics // CHANGED: Import Analytics Controller
} from '../controllers/billing.controller';

const router = Router();

// --- PUBLIC ROUTES (Protected by Auth Token) ---

// 1. Create Appointment
router.post('/book-appointment', authMiddleware, createBooking);

// 2. Check-In OR Status Update (Queue Movement)
router.put('/book-appointment', authMiddleware, updateAppointment);

// 3. Fetch Appointments
router.get('/doctor-appointments', authMiddleware, getAppointments);

// 4. Cancel Appointment
router.post('/cancel-appointment', authMiddleware, cancelBookingUser);

// 5. Billing (Patient Access Only)
router.get('/billing', authMiddleware, getPatientBilling);
router.post('/pay-bill', authMiddleware, payBill);

// 6. Analytics (Doctor Access Only - NEW ROUTE)
router.get('/analytics', authMiddleware, getDoctorAnalytics);

// --- SYSTEM ROUTES ---
router.post('/cleanup', cleanupAppointments);

// 7. Download Receipt
router.get('/receipt/:appointmentId', authMiddleware, getReceipt);

export default router;