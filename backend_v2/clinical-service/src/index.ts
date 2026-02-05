import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { prescriptionController } from "./controllers/prescription.controller";
import { imagingController } from "./controllers/imaging.controller";
import { ehrController } from "./controllers/ehr.controller";
import { authMiddleware } from "./middleware/auth.middleware";

dotenv.config();

const app = express();

// Security & Logging
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

app.use(express.json({ limit: "50mb" })); // Increased limit for Image Base64

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

// --- ROUTES ---
app.use(authMiddleware); // Protect all routes

app.use("/prescriptions", prescriptionController);
app.use("/imaging", imagingController);
app.use("/ehr", ehrController);

app.get("/health", (req, res) => {
    res.json({ status: "OK", service: "Clinical & Ops Service" });
});

const PORT = process.env.PORT || 8085;

const startServer = async () => {
    try {
        // Load Secrets if not in development (or force load if needed)
        // Check if we are missing critical env vars
        if (!process.env.COGNITO_USER_POOL_ID || process.env.COGNITO_USER_POOL_ID.includes('PLACEHOLDER')) {
            console.log("Loading Secrets from SSM...");
            const { getSSMParameter } = await import("./config/aws");
            const poolId = await getSSMParameter("/mediconnect/prod/cognito/user_pool_id");
            const clientId = await getSSMParameter("/mediconnect/prod/cognito/client_id");

            if (poolId) process.env.COGNITO_USER_POOL_ID = poolId;
            if (clientId) process.env.COGNITO_CLIENT_ID = clientId;
        }

        app.listen(PORT, () => {
            console.log(`🚀 Clinical Service running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();
