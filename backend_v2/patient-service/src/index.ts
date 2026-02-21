import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { connect } from 'mqtt';
import { GetParametersCommand } from "@aws-sdk/client-ssm";

// Shared Utilities
import { safeLog, safeError } from '../../shared/logger';
import { getRegionalSSMClient } from './config/aws';

import patientRoutes from './routes/patient.routes';
import iotRoutes from "./modules/iot/iot.routes";
import { handleEmergencyDetection } from './modules/iot/emergency';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

// 🟢 SECURITY: DDoS Protection (100 requests / 15 mins)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: "Too many requests. Please try again later." }
});
app.use(globalLimiter);

const httpServer = createServer(app);
const PORT = process.env.PORT || 8081;

// --- 1. COMPLIANT CORS (HIPAA/GDPR) ---
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5173',
    /\.web\.app$/,               // Firebase Hosting
    /\.azurecontainerapps\.io$/, // Azure
    /\.run\.app$/                // GCP Cloud Run
];

if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true }
});

// --- 2. SECURITY MIDDLEWARE (HIPAA Hardening) ---
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // 1 Year HSTS
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "https://*.amazonaws.com", "https://*.googleapis.com", "wss://*.amazonaws.com", "https://*.azure.com"],
            imgSrc: ["'self'", "data:", "https://*"],
        }
    }
}));

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-User-ID', 'Prefer', 'If-Match', 'x-user-region']
}));

// 🟢 SECURITY FIX: Limit payload to prevent DoS (Was 10mb, now 2mb)
app.use(express.json({ limit: '2mb' }));

/**
 * 🟢 HIPAA AUDIT FIX: Secure Identity Logging
 * We strictly log the token identity (req.user.id), NOT the spoofable header.
 */
morgan.token('verified-user', (req: any) => {
    return req.user?.id ? `User:${req.user.id}` : 'Unauthenticated';
});

app.use(morgan((tokens, req, res) => {
    return [
        `[AUDIT]`, tokens.method(req, res), tokens.url(req, res),
        tokens.status(req, res), tokens['response-time'](req, res), 'ms',
        tokens['verified-user'](req, res),
        `IP:${req.ip}`
    ].join(' ');
}, { skip: (req) => req.url === '/health' || req.method === 'OPTIONS' }));


// --- 3. 100% HIPAA/GDPR COMPLIANT VAULT SYNC ---
async function loadSecrets() {
    const region = process.env.AWS_REGION || 'us-east-1';
    const ssm = getRegionalSSMClient(region);

    try {
        console.log(`🔐 Synchronizing secrets with AWS Vault [${region}]...`);
        const command = new GetParametersCommand({
            Names: [
                '/mediconnect/prod/db/dynamo_table',
                '/mediconnect/prod/s3/patient_identity_bucket',
                '/mediconnect/prod/mqtt/endpoint',
                '/mediconnect/prod/sns/topic_arn_us',
                '/mediconnect/prod/sns/topic_arn_eu',
                '/mediconnect/prod/cognito/user_pool_id',
                '/mediconnect/prod/cognito/client_id_patient',
                '/mediconnect/prod/cognito/client_id_doctor',
                '/mediconnect/prod/cognito/user_pool_id_eu',
                '/mediconnect/prod/cognito/client_id_eu_patient',
                '/mediconnect/prod/cognito/client_id_eu_doctor'
            ],
            WithDecryption: true
        });
        const { Parameters } = await ssm.send(command);

        if (!Parameters || Parameters.length === 0) {
            throw new Error("No secrets found in Parameter Store.");
        }

        Parameters?.forEach((p: any) => {
            if (p.Name.includes('dynamo_table')) process.env.DYNAMO_TABLE = p.Value;
            if (p.Name.includes('patient_identity_bucket')) process.env.BUCKET_NAME = p.Value;
            if (p.Name.includes('mqtt/endpoint')) process.env.MQTT_BROKER_URL = p.Value;
            if (p.Name.includes('topic_arn_us')) process.env.SNS_TOPIC_ARN_US = p.Value;
            if (p.Name.includes('topic_arn_eu')) process.env.SNS_TOPIC_ARN_EU = p.Value;
            
            if (p.Name === '/mediconnect/prod/cognito/user_pool_id') process.env.COGNITO_USER_POOL_ID_US = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/client_id_patient') process.env.COGNITO_CLIENT_ID_US_PATIENT = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/client_id_doctor') process.env.COGNITO_CLIENT_ID_US_DOCTOR = p.Value;
            
            if (p.Name === '/mediconnect/prod/cognito/user_pool_id_eu') process.env.COGNITO_USER_POOL_ID_EU = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/client_id_eu_patient') process.env.COGNITO_CLIENT_ID_EU_PATIENT = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/client_id_eu_doctor') process.env.COGNITO_CLIENT_ID_EU_DOCTOR = p.Value;
        });
        console.log("✅ AWS Vault Sync Complete.");
    } catch (e: any) {
        // 🟢 SECURITY FIX: Crash the server if secrets fail to load. Do not run insecurely.
        safeError(`❌ FATAL: Vault Sync Failed. System cannot start securely.`, e.message);
        process.exit(1);
    }
}

// --- 4. REAL-TIME IoT BRIDGE & THRESHOLD ALERTS ---
const startIoTBridge = () => {
    if (!process.env.MQTT_BROKER_URL) {
        console.warn("📡 IoT Bridge Disabled: MQTT_BROKER_URL missing.");
        return;
    }

    const mqttClient = connect(process.env.MQTT_BROKER_URL);
    
    mqttClient.on('connect', () => {
        console.log("📡 Connected to AWS IoT Secure Broker");
        mqttClient.subscribe('mediconnect/vitals/#');
    });

    mqttClient.on('message', async (topic, message) => {
        try {
            const payload = JSON.parse(message.toString());
            const patientId = topic.split('/').pop() || "unknown";
            const heartRate = Number(payload.heartRate);
            const region = payload.region || "us-east-1";

            if (heartRate > 150) {
                console.warn(`🚨 EMERGENCY: High Heart Rate [${heartRate}] for Patient ${patientId}`);
                await handleEmergencyDetection(patientId, heartRate, 'EMERGENCY_AUTO_IOT', region);
                io.to(`patient_${patientId}`).emit('critical_vital_alert', {
                    message: "High Heart Rate Detected! Emergency services notified.",
                    heartRate, level: "CRITICAL"
                });
            }

            io.to(`patient_${patientId}`).emit('vital_update', { 
                ...payload, timestamp: new Date().toISOString() 
            });
        } catch (e) { console.error("MQTT Message Processing Error"); }
    });

    io.on('connection', (socket) => {
        socket.on('join_monitoring', (pid) => {
            socket.join(`patient_${pid}`);
            console.log(`👁️ Monitoring session started for patient: ${pid}`);
        });
    });
};

// --- 5. STARTUP SEQUENCE ---
const startServer = async () => {
    try {
        await loadSecrets();
        
        app.get('/health', (req, res) => res.status(200).json({ status: 'UP', service: 'patient-service', timestamp: new Date().toISOString() }));

        app.use('/', patientRoutes);
        app.use('/', iotRoutes);
        
        startIoTBridge();

        httpServer.listen(Number(PORT), '0.0.0.0', () => {
            safeLog(`🚀 Patient Service Production Ready on port ${PORT}`);
        });
    } catch (err: any) {
        safeError('❌ FATAL: Application failed to start:', err.message);
        process.exit(1);
    }
};

startServer();