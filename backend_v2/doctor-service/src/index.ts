import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import doctorRoutes from './routes/doctor.routes';
import { initDb } from './config/db';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8082;

// Security & Middleware
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    noSniff: true,
    frameguard: { action: 'deny' },
    xssFilter: true,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "https://*.amazonaws.com", "https://*.googleapis.com", "https://*.azure.com"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https://*"],
        }
    }
}));

app.use(cors({
    origin: ['http://localhost:8080', 'http://localhost:5173', process.env.FRONTEND_URL || ''],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret']
}));
app.options('*', cors()); // Enable Pre-Flight

app.use(express.json());

// Audit Logging (GDPR - No Sensitive Data)
app.use(morgan((tokens, req, res) => {
    return [
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        tokens.res(req, res, 'content-length'), '-',
        tokens['response-time'](req, res), 'ms',
        `User: ${req.headers['x-user-id'] || 'Guest'}`
    ].join(' ');
}, {
    skip: (req) => req.method === 'OPTIONS'
}));

// Health Key
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP', service: 'doctor-service' });
});

// Routes
// Routes
app.use('/doctors', doctorRoutes);

// MERGED: Clinical Service Routes
import clinicalRoutes from "./modules/clinical/clinical.routes";
app.use('/clinical', clinicalRoutes);

import { safeLog, safeError } from '@shared/logger';

// Start Server
const startServer = async () => {
    try {
        await initDb(); // Initialize DB connection (with retry logic)
        app.listen(Number(PORT), '0.0.0.0', () => {
            safeLog(`🚀 Doctor Service online on port ${PORT} `);
        });
    } catch (error) {
        safeError('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();
