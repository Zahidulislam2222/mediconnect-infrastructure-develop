import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import doctorRoutes from './routes/doctor.routes';
import clinicalRoutes from "./modules/clinical/clinical.routes";
import rateLimit from 'express-rate-limit';

import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { safeLog, safeError } from '../../shared/logger';
// 🟢 ARCHITECTURE FIX: Use Shared Factory for Regional Secret Loading
import { getRegionalSSMClient } from './config/aws';

dotenv.config();

const app = express();

// 🟢 SECURITY: DDoS Protection (100 requests / 15 mins)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: "Too many requests. Please try again later." }
});
app.use(globalLimiter);
const PORT = process.env.PORT || 8082;

// --- 1. COMPLIANT CORS (HIPAA/GDPR) ---
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5173',
    /\.web\.app$/,               // Firebase
    /\.azurecontainerapps\.io$/  // Azure Internal
];

if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}

// --- 2. SECURITY MIDDLEWARE (STRICT COMPLIANCE) ---
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // 1 Year HSTS
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-User-ID', 'Prefer', 'If-Match', 'x-user-region']
}));
app.options('*', cors());

// HIPAA Requirement: Limit payload size to prevent DoS
app.use(express.json({ limit: '2mb' }));

/**
 * 🟢 HIPAA AUDIT FIX: Secure Identity Logging
 * We no longer trust 'req.headers'. We check 'req.user' which comes from the Verified Token.
 */
morgan.token('verified-user', (req: any) => {
    return req.user?.sub ? `User:${req.user.sub}` : 'Unauthenticated';
});

app.use(morgan((tokens, req, res) => {
    return [
        `[AUDIT]`,
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        tokens['response-time'](req, res), 'ms',
        tokens['verified-user'](req, res), // 🟢 The Fix
        `IP:${req.ip}`
    ].join(' ');
}, {
    skip: (req) => req.method === 'OPTIONS'
}));

// Professional Health Check (Azure Liveness Probe)
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'UP', 
        service: 'doctor-service',
        timestamp: new Date().toISOString()
    });
});

// --- 3. ROUTE MOUNTING ---
app.use('/', doctorRoutes);
app.use('/', clinicalRoutes);

// --- 4. SECRETS LOADER (Resilient Architecture) ---
async function loadSecrets() {
    // Determine Region from Env (Default US)
    const region = process.env.AWS_REGION || 'us-east-1';
    
    // 🟢 INFRA FIX: Use Regional Factory (Prevents Cross-Region Dependency)
    const ssm = getRegionalSSMClient(region);

    try {
        console.log(`🔐 Synchronizing secrets with AWS Vault [${region}]...`);
        const command = new GetParametersCommand({
            Names: [
                '/mediconnect/prod/kms/signing_key_id',
                // US Identity
                '/mediconnect/prod/cognito/client_id',
                '/mediconnect/prod/cognito/user_pool_id',
                // EU Identity (GDPR)
                '/mediconnect/prod/cognito/user_pool_id_eu',
                // Shared Infrastructure
                '/mediconnect/prod/db/dynamo_table'
            ],
            WithDecryption: true
        });

        const { Parameters } = await ssm.send(command);

        if (!Parameters || Parameters.length === 0) {
            throw new Error("No secrets found in Parameter Store.");
        }

        Parameters?.forEach((p: any) => {
    if (p.Name && p.Name.includes('kms/signing_key_id')) process.env.KMS_KEY_ID = p.Value;
            
            // Map US
            if (p.Name === '/mediconnect/prod/cognito/client_id') process.env.COGNITO_CLIENT_ID = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/user_pool_id') process.env.COGNITO_USER_POOL_ID = p.Value;
            
            // Map EU
            if (p.Name === '/mediconnect/prod/cognito/user_pool_id_eu') process.env.COGNITO_USER_POOL_ID_EU = p.Value;
        });
        console.log("✅ AWS Vault Sync Complete.");
    } catch (e: any) {
        // 🟢 HIPAA AVAILABILITY FIX: Fail Fast
        // If we cannot load secrets, we MUST crash. A zombie server is dangerous.
        safeError(`❌ FATAL: Vault Sync Failed. System cannot start securely.`, e.message);
        process.exit(1); 
    }
}

// --- 5. START SERVER ---
const startServer = async () => {
    try {
        // 1. Load Secrets (Blocking Operation)
        await loadSecrets();

        // 2. Start Listener
        app.listen(Number(PORT), '0.0.0.0', () => {
            safeLog(`🚀 Doctor Service Production Ready on port ${PORT} `);
        });
    } catch (error: any) {
        safeError('❌ FATAL: Application failed to start:', error.message);
        process.exit(1); 
    }
};

startServer();// Triggering deployment fix
// Triggering deployment fix
