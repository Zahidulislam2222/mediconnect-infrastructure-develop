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
import { getSignedIoTUrl } from './utils/iot-signer'; // 🟢 IMPORT THE SIGNER

import patientRoutes from './routes/patient.routes';
import iotRoutes from "./modules/iot/iot.routes";
import { handleEmergencyDetection } from './modules/iot/emergency';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

// 🟢 SECURITY: DDoS Protection
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: "Too many requests. Please try again later." }
});
app.use(globalLimiter);

const httpServer = createServer(app);
const PORT = process.env.PORT || 8081;

// --- 1. COMPLIANT CORS ---
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5173',
    /\.web\.app$/,
    /\.azurecontainerapps\.io$/,
    /\.run\.app$/
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true }
});

// --- 2. SECURITY MIDDLEWARE ---
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
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

app.use(express.json({ limit: '2mb' }));

// HIPAA Logging
morgan.token('verified-user', (req: any) => {
    return req.user?.id ? `User:${req.user.id}` : 'Unauthenticated';
});
app.use(morgan((tokens, req, res) => {
    return [
        `[AUDIT]`, tokens.method(req, res), tokens.url(req, res),
        tokens.status(req, res), tokens['response-time'](req, res), 'ms',
        tokens['verified-user'](req, res), `IP:${req.ip}`
    ].join(' ');
}, { skip: (req) => req.url === '/health' || req.method === 'OPTIONS' }));


// --- 3. 100% COMPLIANT VAULT SYNC ---
async function loadSecrets() {
    const region = process.env.AWS_REGION || 'us-east-1';
    const ssm = getRegionalSSMClient(region);

    try {
        console.log(`🔐 Synchronizing secrets with AWS Vault [${region}]...`);

        // Batch 1: Infrastructure
        const cmdInfra = new GetParametersCommand({
            Names: [
                '/mediconnect/prod/db/dynamo_table',
                '/mediconnect/prod/s3/patient_identity_bucket',
                '/mediconnect/prod/mqtt/endpoint',
                '/mediconnect/prod/sns/topic_arn_us',
                '/mediconnect/prod/sns/topic_arn_eu'
            ],
            WithDecryption: true
        });

        // Batch 2: Identity
        const cmdIdentity = new GetParametersCommand({
            Names: [
                '/mediconnect/prod/cognito/user_pool_id',
                '/mediconnect/prod/cognito/client_id_patient',
                '/mediconnect/prod/cognito/client_id_doctor',
                '/mediconnect/prod/cognito/client_id_us_patient',
                '/mediconnect/prod/cognito/client_id_us_doctor',
                '/mediconnect/prod/cognito/user_pool_id_eu',
                '/mediconnect/prod/cognito/client_id_eu_patient',
                '/mediconnect/prod/cognito/client_id_eu_doctor'
            ],
            WithDecryption: true
        });

        const [infraRes, identityRes] = await Promise.all([
            ssm.send(cmdInfra),
            ssm.send(cmdIdentity)
        ]);

        const allParams = [...(infraRes.Parameters || []), ...(identityRes.Parameters || [])];

        if (allParams.length === 0) {
            throw new Error("No secrets found in Parameter Store.");
        }

        allParams.forEach((p: any) => {
            if (p.Name.includes('dynamo_table')) process.env.DYNAMO_TABLE = p.Value;
            if (p.Name.includes('patient_identity_bucket')) process.env.BUCKET_NAME = p.Value;
            if (p.Name.includes('mqtt/endpoint')) process.env.MQTT_BROKER_URL = p.Value;
            if (p.Name.includes('topic_arn_us')) process.env.SNS_TOPIC_ARN_US = p.Value;
            if (p.Name.includes('topic_arn_eu')) process.env.SNS_TOPIC_ARN_EU = p.Value;
            
            if (p.Name.endsWith('/cognito/user_pool_id')) process.env.COGNITO_USER_POOL_ID_US = p.Value;
            if (p.Name.endsWith('/client_id_patient')) process.env.COGNITO_CLIENT_ID = p.Value; 
            if (p.Name.endsWith('/client_id_doctor')) process.env.COGNITO_CLIENT_ID_DOCTOR_LOCAL = p.Value; 

            if (p.Name.endsWith('/client_id_us_patient')) process.env.COGNITO_CLIENT_ID_US_PATIENT = p.Value;
            if (p.Name.endsWith('/client_id_us_doctor')) process.env.COGNITO_CLIENT_ID_US_DOCTOR = p.Value;

            if (p.Name.includes('user_pool_id_eu')) process.env.COGNITO_USER_POOL_ID_EU = p.Value;
            if (p.Name.includes('client_id_eu_patient')) process.env.COGNITO_CLIENT_ID_EU_PATIENT = p.Value;
            if (p.Name.includes('client_id_eu_doctor')) process.env.COGNITO_CLIENT_ID_EU_DOCTOR = p.Value;
        });

        if (!process.env.COGNITO_CLIENT_ID_US_PATIENT) process.env.COGNITO_CLIENT_ID_US_PATIENT = process.env.COGNITO_CLIENT_ID;
        if (!process.env.COGNITO_CLIENT_ID_US_DOCTOR) process.env.COGNITO_CLIENT_ID_US_DOCTOR = process.env.COGNITO_CLIENT_ID_DOCTOR_LOCAL;

        console.log("✅ AWS Vault Sync Complete.");
    } catch (e: any) {
        safeError(`❌ FATAL: Vault Sync Failed. System cannot start securely.`, e.message);
        process.exit(1);
    }
}

// --- 4. IOT BRIDGE (AUTHENTICATED) ---
const startIoTBridge = () => {
    if (!process.env.MQTT_BROKER_URL) {
        console.warn("⚠️ MQTT Bridge Skipped: No Broker URL Found");
        return;
    }

    try {
        console.log(`📡 Calculating Secure SigV4 Connection...`);
        
        // 🟢 THE FIX: Sign the URL using AWS Access Keys
        const signedUrl = getSignedIoTUrl(
            process.env.MQTT_BROKER_URL,
            process.env.AWS_REGION || 'us-east-1',
            process.env.AWS_ACCESS_KEY_ID || '',
            process.env.AWS_SECRET_ACCESS_KEY || '',
            process.env.AWS_SESSION_TOKEN
        );

        const mqttClient = connect(signedUrl, {
            connectTimeout: 5000,
            reconnectPeriod: 5000,
            protocol: 'wss' // Force Secure WebSocket
        });
        
        mqttClient.on('connect', () => {
            console.log("✅ Connected to AWS IoT Core (Securely Signed)");
            mqttClient.subscribe('mediconnect/vitals/#');
        });

        mqttClient.on('error', (err) => {
            console.error("⚠️ MQTT Error:", err.message);
        });

        mqttClient.on('message', async (topic, message) => {
            try {
                const payload = JSON.parse(message.toString());
                const patientId = topic.split('/').pop() || "unknown";
                const heartRate = Number(payload.heartRate);
                const region = payload.region || "us-east-1";

                if (heartRate > 150) {
                    await handleEmergencyDetection(patientId, heartRate, 'EMERGENCY_AUTO_IOT', region);
                    io.to(`patient_${patientId}`).emit('critical_vital_alert', {
                        message: "High Heart Rate Detected!", heartRate, level: "CRITICAL"
                    });
                }
                io.to(`patient_${patientId}`).emit('vital_update', { ...payload, timestamp: new Date().toISOString() });
            } catch (e) { console.error("Message Error"); }
        });

        io.on('connection', (socket) => {
            socket.on('join_monitoring', (pid) => socket.join(`patient_${pid}`));
        });
    } catch (error: any) {
        console.error("❌ Failed to initialize IoT Bridge:", error.message);
    }
};

// --- 5. START SERVER ---
const startServer = async () => {
    try {
        await loadSecrets();
        
        app.get('/health', (req, res) => res.status(200).json({ status: 'UP', service: 'patient-service' }));
        app.use('/', patientRoutes);
        app.use('/', iotRoutes);
        
        startIoTBridge();

        httpServer.listen(Number(PORT), '0.0.0.0', () => {
            safeLog(`🚀 Patient Service Production Ready on port ${PORT}`);
        });
    } catch (err: any) {
        const errMsg = err?.message || JSON.stringify(err);
        safeError('❌ FATAL: Application failed to start:', errMsg);
        process.exit(1);
    }
};

startServer();