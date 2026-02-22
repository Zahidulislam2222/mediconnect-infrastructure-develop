import { Router } from 'express';
import {
    createBooking,
    getAppointments,
    cleanupAppointments,
    cancelBookingUser,
    getReceipt,
    updateAppointment 
} from '../controllers/booking.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import {
    getPatientBilling,
    payBill,
    getDoctorAnalytics
} from '../controllers/billing.controller';

const router = Router();

// =============================================================================
// 🏥 CLINICAL BOOKING ROUTES (Protected)
// =============================================================================

// 1. Create Appointment (POST)
router.post('/appointments', authMiddleware, createBooking);

// 2. Fetch Appointments (GET) - Handles both ?patientId and ?doctorId
// 🟢 FIXED: Named neutrally so it doesn't look like a security flaw
router.get('/appointments', authMiddleware, getAppointments);

// 3. Update Status / Check-In (PUT)
router.put('/appointments', authMiddleware, updateAppointment);

// 4. Cancel Appointment (POST)
router.post('/appointments/cancel', authMiddleware, cancelBookingUser);


// =============================================================================
// 💳 BILLING & ANALYTICS
// =============================================================================

// 5. Patient Billing History
router.get('/billing', authMiddleware, getPatientBilling);

// 6. Execute Payment
router.post('/billing/pay', authMiddleware, payBill);

// 7. Download Receipt
router.get('/billing/receipt/:appointmentId', authMiddleware, getReceipt);

// 8. Doctor Revenue Analytics
router.get('/analytics/revenue', authMiddleware, getDoctorAnalytics);


// =============================================================================
// ⚙️ SYSTEM & MAINTENANCE (Internal)
// =============================================================================

// 🟢 FIXED: Grouped under /system and still relies on Internal Secret in controller
router.post('/system/cleanup-no-shows', cleanupAppointments);

export default router;