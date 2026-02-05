import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import bookingRoutes from './routes/booking.routes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8083;

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

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP', service: 'booking-service' });
});

// Routes
app.use('/appointments', bookingRoutes);

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
            console.log(`Booking Service running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();
