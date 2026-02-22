import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { GetParametersCommand } from "@aws-sdk/client-ssm";

import bookingRoutes from './routes/booking.routes';
import { handleStripeWebhook } from './controllers/webhook.controller';
import { getRegionalSSMClient } from './config/aws'; // 🟢 REGIONAL FACTORY

dotenv.config();

const app = express();
app.set('trust proxy', 1); // 🟢 REQUIRED for Rate Limiting behind Azure/GCP Load Balancers

const PORT = process.env.PORT || 8083;

// 🟢 SECURITY: DDoS Protection (100 requests / 15 mins)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: "Too many requests. Please try again later." }
});
app.use(globalLimiter);

// --- 1. COMPLIANT CORS (HIPAA/GDPR) ---
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5173',
    /\.web\.app$/,
    /\.azurecontainerapps\.io$/,
    /\.run\.app$/
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

// --- 2. SECURITY MIDDLEWARE ---
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-User-ID', 'Prefer', 'If-Match', 'x-user-region']
}));
app.options('*', cors());

// 🟢 CRITICAL: Stripe Webhook MUST be raw buffer (Before express.json)
app.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '2mb' }));

// 🟢 HIPAA AUDIT FIX: Secure Identity Logging (Extracts from JWT, not headers)
morgan.token('verified-user', (req: any) => {
    return req.user?.sub || req.user?.id ? `User:${req.user.sub || req.user.id}` : 'Unauthenticated';
});

app.use(morgan((tokens, req, res) => {
    return [
        `[AUDIT]`, tokens.method(req, res), tokens.url(req, res)?.split('?')[0],
        tokens.status(req, res), tokens['response-time'](req, res), 'ms',
        tokens['verified-user'](req, res), `IP:${req.ip}`
    ].join(' ');
}, { skip: (req) => req.url === '/health' || req.method === 'OPTIONS' }));

// --- 3. ROUTES ---
app.get('/health', (req, res) => res.status(200).json({ status: 'UP', service: 'booking-service' }));
app.use('/', bookingRoutes);

// --- 4. 100% COMPLIANT VAULT SYNC ---
async function loadSecrets() {
    const region = process.env.AWS_REGION || 'us-east-1';
    const ssm = getRegionalSSMClient(region);

    try {
        console.log(`🔐 Synchronizing Booking secrets with AWS Vault [${region}]...`);
        const command = new GetParametersCommand({
            Names: [
                '/mediconnect/prod/cognito/user_pool_id',
                '/mediconnect/prod/cognito/client_id',
                '/mediconnect/prod/cognito/user_pool_id_eu',
                '/mediconnect/stripe/keys',      
                '/mediconnect/stripe/webhook_secret'
            ],
            WithDecryption: true
        });

        const { Parameters } = await ssm.send(command);

        if (!Parameters || Parameters.length === 0) throw new Error("No secrets found in Parameter Store.");

        Parameters.forEach(p => {
            if (p.Name?.includes('user_pool_id') && !p.Name.includes('_eu')) process.env.COGNITO_USER_POOL_ID = p.Value;
            if (p.Name?.includes('client_id')) process.env.COGNITO_CLIENT_ID = p.Value;
            if (p.Name?.includes('user_pool_id_eu')) process.env.COGNITO_USER_POOL_ID_EU = p.Value;
            if (p.Name?.includes('stripe/keys')) process.env.STRIPE_SECRET_KEY = p.Value;
            if (p.Name?.includes('webhook_secret')) process.env.STRIPE_WEBHOOK_SECRET = p.Value;
        });

        console.log("✅ AWS Vault Sync Complete.");
    } catch (e: any) {
        console.error(`❌ FATAL: Vault Sync Failed. System cannot start securely.`, e.message);
        process.exit(1);
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