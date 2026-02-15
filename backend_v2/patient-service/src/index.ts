import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { connect } from 'mqtt';
import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { ssmClient } from './config/aws';
import { initDb } from './config/db';
import patientRoutes from './routes/patient.routes';
import iotRoutes from "./modules/iot/iot.routes";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 8081;

// --- 1. COMPLIANT CORS ---
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5173',
    /\.web\.app$/,
    /\.azurecontainerapps\.io$/,
    /\.run\.app$/ // Allow Cloud Run domains
];

if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true }
});

// --- 2. SECURITY MIDDLEWARE (HIPAA) ---
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "https://*.amazonaws.com", "https://*.googleapis.com", "wss://*.amazonaws.com"],
            imgSrc: ["'self'", "data:", "https://*"],
        }
    }
}));

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-User-ID', 'Prefer']
}));

app.use(express.json({ limit: '10mb' }));

// Audit Logging (GDPR/HIPAA)
app.use(morgan((tokens, req, res) => {
    return [
        `[AUDIT]`, tokens.method(req, res), tokens.url(req, res),
        tokens.status(req, res), tokens['response-time'](req, res), 'ms',
        `User: ${req.headers['x-user-id'] || 'Guest'}`, `IP: ${req.ip}`
    ].join(' ');
}, { skip: (req) => req.url === '/health' }));

// Health Check
app.get('/health', (req, res) => res.json({ status: 'UP', service: 'patient-service' }));

// --- 3. ROUTES ---
app.use('/patients', patientRoutes);
app.use('/vitals', iotRoutes);

// --- 4. SECRETS & STARTUP ---
async function loadSecrets() {
    const keyHint = process.env.AWS_ACCESS_KEY_ID ? "PRESENT" : "MISSING";
    console.log(`🔎 Boot Check: AWS Creds [${keyHint}] | Region [${process.env.AWS_REGION || 'us-east-1'}]`);

    try {
        const command = new GetParametersCommand({
            Names: [
                '/mediconnect/prod/db/dynamo_table',
                '/mediconnect/prod/s3/patient_identity_bucket',
                '/mediconnect/prod/cognito/client_id',
                '/mediconnect/prod/cognito/user_pool_id',
                '/mediconnect/prod/stripe/secret_key',
                '/mediconnect/prod/cleanup/secret',
                '/mediconnect/prod/mqtt/endpoint'
            ],
            WithDecryption: true
        });
        const { Parameters } = await ssmClient.send(command);

        Parameters?.forEach((p: any) => {
            if (p.Name === '/mediconnect/db/dynamo_table' && !process.env.DYNAMO_TABLE) process.env.DYNAMO_TABLE = p.Value;
            if (p.Name === '/mediconnect/prod/s3/patient_identity_bucket' && !process.env.BUCKET_NAME) process.env.BUCKET_NAME = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/client_id' && !process.env.COGNITO_CLIENT_ID) process.env.COGNITO_CLIENT_ID = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/user_pool_id' && !process.env.COGNITO_USER_POOL_ID) process.env.COGNITO_USER_POOL_ID = p.Value;
            if (p.Name === '/mediconnect/prod/stripe/secret_key' && !process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = p.Value;
            if (p.Name === '/mediconnect/prod/mqtt/endpoint' && !process.env.MQTT_BROKER_URL) process.env.MQTT_BROKER_URL = p.Value;
        });
        console.log("✅ Config Sync Complete.");
    } catch (e: any) {
        console.warn(`⚠️ Config Sync Bypass: ${e.message}. Using System Env Vars.`);
    }
}

// MQTT Bridge
const startIoTBridge = () => {
    if (!process.env.MQTT_BROKER_URL) return;
    const mqttClient = connect(process.env.MQTT_BROKER_URL);
    mqttClient.on('connect', () => {
        console.log("📡 Connected to AWS IoT");
        mqttClient.subscribe('mediconnect/vitals/#');
    });
    mqttClient.on('message', (topic, message) => {
        try {
            const payload = JSON.parse(message.toString());
            const patientId = topic.split('/').pop();
            io.to(`patient_${patientId}`).emit('vital_update', { ...payload, timestamp: new Date().toISOString() });
        } catch (e) { console.error("MQTT Parse Error"); }
    });
    io.on('connection', (socket) => socket.on('join_monitoring', (pid) => socket.join(`patient_${pid}`)));
};

// Start
const start = async () => {
    try {
        await loadSecrets();
        
        app.use('/', patientRoutes);
        app.use('/', iotRoutes);
        
        startIoTBridge();

        httpServer.listen(Number(PORT), '0.0.0.0', () => {
            console.log(`🚀 Patient Service Production Ready on port ${PORT}`);
        });
    } catch (err: any) {
        console.error("Fatal Startup Error:", err.message);
        process.exit(1);
    }
};

start();