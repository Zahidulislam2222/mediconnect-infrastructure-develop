import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import doctorRoutes from './routes/doctor.routes';
import clinicalRoutes from "./modules/clinical/clinical.routes";
import { initDb } from './config/db';
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { safeLog, safeError } from '../../shared/logger';

dotenv.config();

const app = express();
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
    // Added 'Prefer' and 'If-Match' for FHIR standard compatibility
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-User-ID', 'Prefer', 'If-Match']
}));
app.options('*', cors());

// HIPAA Requirement: Limit payload size to prevent DoS
app.use(express.json({ limit: '2mb' }));

// HIPAA/GDPR Audit Logging: Capture User Context
app.use(morgan((tokens, req, res) => {
    return [
        `[AUDIT]`,
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        tokens['response-time'](req, res), 'ms',
        `User: ${req.headers['x-user-id'] || 'anonymous'}`,
        `IP: ${req.ip}`
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
    // DIAGNOSTIC LOG (Masked for Security)
    const keyHint = process.env.AWS_ACCESS_KEY_ID ? `${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...` : 'MISSING';
    console.log(`🔎 Boot Check: AWS ID [${keyHint}] in [${process.env.AWS_REGION || 'us-east-1'}]`);

    // If no credentials at all, don't even try SSM (avoid timeout)
    if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID.includes('PLACEHOLDER')) {
        console.warn("⚠️ No AWS Credentials found. Relying on Azure Portal Environment Variables.");
        return;
    }

    const ssm = new SSMClient({ 
        region: process.env.AWS_REGION || 'us-east-1',
        // Hard limit: If AWS doesn't respond in 2s, we proceed with Azure values
        requestHandler: { connectionTimeout: 2000 }
    });

    try {
        console.log("🔐 Synchronizing secrets with AWS Vault...");
        const command = new GetParametersCommand({
            Names: [
                '/mediconnect/prod/kms/signing_key_id',
                '/mediconnect/prod/cognito/client_id',
                '/mediconnect/prod/cognito/user_pool_id',
                '/mediconnect/prod/gcp/sql/public_ip',
                '/mediconnect/prod/gcp/sql/db_user',
                '/mediconnect/prod/db/master_password'
            ],
            WithDecryption: true
        });

        const { Parameters } = await ssm.send(command);

        Parameters?.forEach(p => {
            // PROFESSIONAL LOGIC: Do not overwrite if Azure Portal already has a value
            if (p.Name === '/mediconnect/prod/kms/signing_key_id' && !process.env.KMS_KEY_ID) process.env.KMS_KEY_ID = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/client_id' && !process.env.COGNITO_CLIENT_ID) process.env.COGNITO_CLIENT_ID = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/user_pool_id' && !process.env.COGNITO_USER_POOL_ID) process.env.COGNITO_USER_POOL_ID = p.Value;
            if (p.Name === '/mediconnect/prod/gcp/sql/public_ip' && !process.env.DB_HOST) process.env.DB_HOST = p.Value;
            if (p.Name === '/mediconnect/prod/gcp/sql/db_user' && !process.env.DB_USER) process.env.DB_USER = p.Value;
            if (p.Name === '/mediconnect/prod/db/master_password' && !process.env.DB_PASSWORD) process.env.DB_PASSWORD = p.Value;
        });
        console.log("✅ AWS Vault Sync Complete.");
    } catch (e: any) {
        // HIPAA COMPLIANCE: Fail Open on vault access, Fail Closed on DB access.
        // We log the error but do NOT crash. The initDb() function will catch issues later.
        console.warn(`⚠️ Vault Sync Bypass: ${e.message}. Using System Environment Variables.`);
    }
}

// --- 5. START SERVER ---
const startServer = async () => {
    try {
        await loadSecrets();
        await initDb(); 
        app.listen(Number(PORT), '0.0.0.0', () => {
            safeLog(`🚀 Doctor Service Production Ready on port ${PORT} `);
        });
    } catch (error: any) {
        safeError('❌ FATAL: Application failed to start:', error.message);
        process.exit(1); // Standard Unix exit code for failure
    }
};

startServer();