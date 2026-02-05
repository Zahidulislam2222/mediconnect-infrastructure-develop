import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { vitalsHandler } from "./handlers/vitals";
import { emergencyHandler } from "./handlers/emergency";
import { analyticsHandler } from "./handlers/analytics";
import { authMiddleware } from "./middleware/auth.middleware";

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

// --- ROUTES (Simulating Lambda Event Sources via REST) ---
app.use(authMiddleware); // Protect all routes

// 1. Get Vitals
app.get("/vitals", async (req, res) => {
    try {
        // Convert Express req to Lambda Event style if needed, or just write handler to accept standard args
        // For simplicity, handler is adapted to Express here
        const result = await vitalsHandler(req.query);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Emergency Trigger
app.post("/emergency", async (req, res) => {
    try {
        const result = await emergencyHandler(req.body);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Analytics (Simulated Stream Trigger)
// In production, this is triggered by DynamoDB Streams, not an HTTP endpoint.
// We expose it here for verification/testing purposes.
app.post("/analytics/trigger", async (req, res) => {
    try {
        const result = await analyticsHandler(req.body); // Expects DynamoDB Stream Event structure in body
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/health", (req, res) => {
    res.json({ status: "OK", service: "IoT & Analytics Service" });
});

const PORT = process.env.PORT || 8086;

const startServer = async () => {
    try {
        if (!process.env.COGNITO_USER_POOL_ID || process.env.COGNITO_USER_POOL_ID.includes('PLACEHOLDER')) {
            console.log("Loading Secrets from SSM...");
            const { getSSMParameter } = await import("./config/aws");
            const poolId = await getSSMParameter("/mediconnect/prod/cognito/user_pool_id");
            const clientId = await getSSMParameter("/mediconnect/prod/cognito/client_id");

            if (poolId) process.env.COGNITO_USER_POOL_ID = poolId;
            if (clientId) process.env.COGNITO_CLIENT_ID = clientId;
        }

        app.listen(PORT, () => {
            console.log(`🚀 IoT Service running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();
