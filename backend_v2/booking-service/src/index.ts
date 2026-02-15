import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import bookingRoutes from './routes/booking.routes';
import { handleStripeWebhook } from './controllers/webhook.controller';
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8083;

// --- 1. COMPLIANT CORS (HIPAA/GDPR) ---
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5173',
    /\.web\.app$/,           // Firebase Production
    /\.azurecontainerapps\.io$/ // Azure Inter-service
];

if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}

// --- 2. SECURITY & MIDDLEWARE ---
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // HSTS 1 Year
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "https://*.amazonaws.com", "https://*.googleapis.com", "https://*.azure.com", "https://*.stripe.com"],
            scriptSrc: ["'self'", "https://*.stripe.com"],
            imgSrc: ["'self'", "data:", "https://*"],
        }
    }
}));

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    // Added FHIR and internal headers
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-User-ID', 'Prefer', 'If-Match']
}));
app.options('*', cors());

// 🟢 CRITICAL: Stripe Webhook (Must stay BEFORE express.json)
app.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '2mb' })); // Limit payload size

// HIPAA Audit Logging
app.use(morgan((tokens, req, res) => {
    return [
        `[AUDIT]`,
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        tokens['response-time'](req, res), 'ms',
        `User: ${req.headers['x-user-id'] || 'Guest'}`,
        `IP: ${req.ip}`
    ].join(' ');
}, {
    skip: (req) => req.method === 'OPTIONS' || req.url === '/health'
}));

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP', service: 'booking-service', timestamp: new Date().toISOString() });
});

// Routes
app.use('/', bookingRoutes);

// --- 3. FAIL-SAFE SECRETS LOADER ---
async function loadSecrets() {
    // 1. Diagnostic Check
    const keyHint = process.env.AWS_ACCESS_KEY_ID ? `${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...` : 'MISSING';
    console.log(`🔎 Boot Check: AWS ID [${keyHint}] in [${process.env.AWS_REGION || 'us-east-1'}]`);

    // 2. Early Exit if no keys (Relies on Azure Portal Manual Vars)
    if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID.includes('PLACEHOLDER')) {
        console.warn("⚠️ No AWS Credentials found. Relying on Azure Portal Environment Variables.");
        return;
    }

    const ssm = new SSMClient({ 
        region: process.env.AWS_REGION || 'us-east-1',
        requestHandler: { connectionTimeout: 2000 } // Don't hang startup
    });

    try {
        console.log("🔐 Attempting to sync secrets from AWS Vault...");
        const command = new GetParametersCommand({
            Names: [
                '/mediconnect/prod/cognito/user_pool_id',
                '/mediconnect/prod/cognito/client_id',
                '/mediconnect/stripe/secret_key',      
                '/mediconnect/stripe/webhook_secret',
                // Database secrets needed for Google Calendar Sync
                '/mediconnect/prod/gcp/sql/public_ip',
                '/mediconnect/prod/gcp/sql/db_user',
                '/mediconnect/prod/db/master_password'
            ],
            WithDecryption: true
        });
        const { Parameters } = await ssm.send(command);

        Parameters?.forEach(p => {
            // PROFESSIONAL: Only set if not already defined (Azure Portal wins)
            if (p.Name === '/mediconnect/prod/cognito/user_pool_id' && !process.env.COGNITO_USER_POOL_ID) process.env.COGNITO_USER_POOL_ID = p.Value;
            if (p.Name === '/mediconnect/prod/cognito/client_id' && !process.env.COGNITO_CLIENT_ID) process.env.COGNITO_CLIENT_ID = p.Value;
            if (p.Name === '/mediconnect/stripe/secret_key' && !process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = p.Value;
            if (p.Name === '/mediconnect/stripe/webhook_secret' && !process.env.STRIPE_WEBHOOK_SECRET) process.env.STRIPE_WEBHOOK_SECRET = p.Value;
            
            // Map DB secrets for Calendar Sync
            if (p.Name === '/mediconnect/prod/gcp/sql/public_ip' && !process.env.DB_HOST) process.env.DB_HOST = p.Value;
            if (p.Name === '/mediconnect/prod/gcp/sql/db_user' && !process.env.DB_USER) process.env.DB_USER = p.Value;
            if (p.Name === '/mediconnect/prod/db/master_password' && !process.env.DB_PASSWORD) process.env.DB_PASSWORD = p.Value;
        });
        console.log("✅ AWS Vault Sync Complete.");
    } catch (e: any) {
        console.warn(`⚠️ Vault Sync Bypass: ${e.message}. Using System Environment Variables.`);
    }
}

const startServer = async () => {
    try {
        await loadSecrets();
        app.listen(Number(PORT), '0.0.0.0', () => {
            console.log(`🚀 Booking Service Production Ready on port ${PORT}`);
        });
    } catch (error) {
        console.error("❌ FATAL: Failed to start Booking Service:", error);
        process.exit(1);
    }
};

startServer();