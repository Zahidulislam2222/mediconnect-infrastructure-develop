import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import patientRoutes from './routes/patient.routes';

dotenv.config();

const app = express();


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

app.use(express.json({ limit: '10mb' })); // For base64 images

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

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', service: 'patient-service' });
});

// Routes
// Routes
app.use('/patients', patientRoutes);

// MERGED: Booking Service Routes
import bookingRoutes from "./modules/booking/booking.routes";
app.use('/appointments', bookingRoutes);

// MERGED: IoT Service Routes (Vitals)
import iotRoutes from "./modules/iot/iot.routes";
app.use('/vitals', iotRoutes);

// The Vault: Secure Startup Strategy
async function loadSecrets() {
    if (process.env.NODE_ENV === 'development') return;

    const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    try {
        const command = new GetParametersCommand({
            Names: [
                '/mediconnect/db/dynamo_table',
                '/mediconnect/s3/bucket_name',
                '/mediconnect/db/dynamo_table',
                '/mediconnect/s3/bucket_name',
                '/mediconnect/prod/cognito/client_id',
                '/mediconnect/prod/cognito/user_pool_id'
            ],
            WithDecryption: true
        });
        const { Parameters } = await ssm.send(command);

        Parameters?.forEach(param => {
            if (param.Name === '/mediconnect/db/dynamo_table') process.env.DYNAMO_TABLE = param.Value;
            if (param.Name === '/mediconnect/s3/bucket_name') process.env.BUCKET_NAME = param.Value;
            if (param.Name === '/mediconnect/prod/cognito/client_id') process.env.COGNITO_CLIENT_ID = param.Value;
            if (param.Name === '/mediconnect/prod/cognito/user_pool_id') process.env.COGNITO_USER_POOL_ID = param.Value;
        });
        console.log("✅ Secrets loaded from Vault");
        console.log('DEBUG: Loaded Cognito ID:', process.env.COGNITO_CLIENT_ID ? 'EXISTS' : 'MISSING');
    } catch (error) {
        console.error("❌ Failed to load secrets:", error);
        // Continue even if failed? Depends on strictness. For now, log error.
    }
}

import { safeLog, safeError } from '@shared/logger';

// Start Server
const PORT = process.env.PORT || 8080;

app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🚀 Service online on port ${PORT}`);
});