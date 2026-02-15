import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { chatController } from "./controllers/chat.controller";
import { videoController } from "./controllers/video.controller";
import { getSSMParameter } from "./config/aws";
import { authMiddleware } from './middleware/auth.middleware';
import { checkSymptoms } from "./controllers/symptom.controller";
import { predictRisk, summarizeConsultation } from "./controllers/predictive.controller";
import { analyzeClinicalImage } from "./controllers/imaging.controller";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8084;

// --- 1. COMPLIANT CORS (FHIR/HIPAA) ---
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5173',
    /\.web\.app$/,
    /\.azurecontainerapps\.io$/
];

if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}

// --- 2. SECURITY MIDDLEWARE ---
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // Strict Transport Security
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
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    // FHIR Headers (Prefer, If-Match) + Internal Security Headers
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-User-ID', 'Prefer', 'If-Match']
}));
app.options('*', cors());

app.use(express.json({ limit: '50mb' })); // High limit for Clinical Images

// GDPR/HIPAA Audit Logging
app.use(morgan((tokens, req, res) => {
    return [
        `[AUDIT]`,
        tokens.method(req, res),
        tokens.url(req, res)?.split('?')[0], // Don't log query params (might contain PII)
        tokens.status(req, res),
        tokens['response-time'](req, res), 'ms',
        `User: ${(req as any).user?.sub || 'Guest'}`,
        `IP: ${req.ip}`
    ].join(' ');
}, {
    skip: (req) => req.method === 'OPTIONS' || req.url === '/health'
}));

// --- 3. PUBLIC HEALTH CHECK (Azure Liveness Probe) ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: "UP",
        service: "communication-service",
        timestamp: new Date().toISOString()
    });
});

// --- 4. SECURE STARTUP & ROUTES ---
const startServer = async () => {
    // DIAGNOSTIC: Check if AWS Keys exist (Masked)
    const keyCheck = process.env.AWS_ACCESS_KEY_ID ? "PRESENT" : "MISSING";
    console.log(`🔎 Boot Check: AWS Creds [${keyCheck}] | Region [${process.env.AWS_REGION || 'us-east-1'}]`);

    try {
        console.log("🔐 Initializing Communication Service Configuration...");

        // Fail-Safe Secret Loading
        // Only fetch if NOT already in env (Prevents overwriting Azure Manual Vars)
        if (!process.env.COGNITO_USER_POOL_ID) {
            const poolId = await getSSMParameter("/mediconnect/prod/cognito/user_pool_id");
            if (poolId) process.env.COGNITO_USER_POOL_ID = poolId;
        }
        if (!process.env.COGNITO_CLIENT_ID) {
            const clientId = await getSSMParameter("/mediconnect/prod/cognito/client_id");
            if (clientId) process.env.COGNITO_CLIENT_ID = clientId;
        }
        if (!process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID) {
    throw new Error("CRITICAL_SECURITY_CONFIG_MISSING: Authentication will fail. Check AWS Credentials/SSM.");
}

        // 🛡️ Apply Identity Protection to ALL routes below
        app.use(authMiddleware);

        // Core Communication Routes
        app.use("/chat", chatController);
        app.use("/video", videoController);

        // AI Clinical Suite (HIPAA: Ensure inputs are de-identified in controller)
        app.post("/chat/symptom-check", checkSymptoms);
        app.post("/chat/predict-health", predictRisk);
        app.post("/chat/analyze-image", analyzeClinicalImage);
        app.post("/predict/summarize", summarizeConsultation);

        app.listen(Number(PORT), '0.0.0.0', () => {
            console.log(`🚀 Communication Service Production Ready on port ${PORT}`);
        });

    } catch (error: any) {
        console.error("❌ CRITICAL: Failed to start Communication Service:", error.message);
        // Fail-Safe: Don't exit. The container stays alive so you can debug via Azure Console.
        // It serves the health check but logs the error.
        app.listen(Number(PORT), '0.0.0.0', () => {
            console.warn(`⚠️ Service started in DEGRADED mode due to startup error.`);
        });
    }
};

startServer();

export default app;