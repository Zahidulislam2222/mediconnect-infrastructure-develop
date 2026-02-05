import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { chatController, handleWebSocketConnection } from "./controllers/chat.controller";
import { videoController } from "./controllers/video.controller";
import { getSSMParameter } from "./config/aws";
import { authMiddleware, getVerifier } from './middleware/auth.middleware';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

// --- ROUTES ---
// app.use((req, res, next) => authMiddleware(req, res, next)); // Moved to startServer

app.use("/chat", chatController);
app.use("/video", videoController);

app.get("/health", (req, res) => {
    res.json({ status: "OK", service: "Communication Hub" });
});

// --- WEBSOCKET HANDLING ---
// import { getVerifier } from "./middleware/auth.middleware"; // Removed duplicate

wss.on("connection", async (ws, req) => {
    // 1. Handshake Auth
    const token = req.url?.split("token=")[1]; // Simple query param extraction
    if (!token) {
        ws.close(1008, "Token missing");
        return;
    }

    try {
        const v = await getVerifier();
        if (v) {
            await v.verify(token); // Throws if invalid
            handleWebSocketConnection(ws, req);
        }
    } catch (err) {
        console.error("WS Auth Failed:", err);
        ws.close(1008, "Authentication Failed");
    }
});

const PORT = process.env.PORT || 8084;

const startServer = async () => {
    try {
        if (!process.env.COGNITO_USER_POOL_ID || process.env.COGNITO_USER_POOL_ID.includes('PLACEHOLDER')) {
            console.log("Loading Secrets from SSM...");
            const poolId = await getSSMParameter("/mediconnect/prod/cognito/user_pool_id");
            const clientId = await getSSMParameter("/mediconnect/prod/cognito/client_id");

            if (poolId) process.env.COGNITO_USER_POOL_ID = poolId;
            if (clientId) process.env.COGNITO_CLIENT_ID = clientId;
        }

        // Apply Auth Middleware Here (Runtime) to ensure imports are ready
        app.use((req, res, next) => authMiddleware(req, res, next));

        server.listen(PORT, () => {
            console.log(`🚀 Communication Service running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();
