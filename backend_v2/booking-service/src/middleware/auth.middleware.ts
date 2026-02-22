import { Request, Response, NextFunction } from 'express';
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { COGNITO_CONFIG } from '../config/aws';
import { writeAuditLog } from "../../../shared/audit";

// 🟢 REGIONAL CACHE: We keep two verifiers alive in memory
const verifiers: Record<string, any> = {
    'us-east-1': null,
    'eu-central-1': null
};

// 🟢 GDPR HELPER: Determine which pool to check
const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    const r = Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
    return r.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
};

const getVerifier = async (region: string) => {
    if (verifiers[region]) return verifiers[region];

    const config = region === 'eu-central-1' ? COGNITO_CONFIG.EU : COGNITO_CONFIG.US;

    if (!config.USER_POOL_ID || !config.CLIENT_PATIENT) {
        throw new Error(`AUTH_CRASH: Missing Cognito Config for ${region}`);
    }

    // 🟢 SECURE: Strict verification against specific Regional Pool
    verifiers[region] = CognitoJwtVerifier.create({
        userPoolId: config.USER_POOL_ID,
        tokenUse: "id",
        clientId: [config.CLIENT_PATIENT, config.CLIENT_DOCTOR], // Allow both apps
        groups: null, // We check groups manually logic
    });

    return verifiers[region];
};

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Unauthorized: Missing token" });
        }

        const token = authHeader.split(' ')[1];
        
        // 1. Identify Jurisdiction (GDPR)
        const region = extractRegion(req);
        
        // 2. Get the Correct Verifier (US or EU)
        const v = await getVerifier(region);

        // 3. Verify Token (Crypto Check)
        const payload = await v.verify(token);

        // 4. Attach Verified User
        (req as any).user = {
            sub: payload.sub,
            email: payload.email,
            // 🟢 NORMALIZE GROUPS: Handle Cognito array vs Single string
            role: payload["custom:role"] || (payload["cognito:groups"] ? payload["cognito:groups"][0] : "patient"),
            region: region // Pass this down so controllers know where to route data
        };

        next();
    } catch (err: any) {
        // 🟢 HIPAA AUDIT: Log the intrusion attempt
        const ip = req.ip || req.headers['x-forwarded-for'] || 'UNKNOWN';
        const region = extractRegion(req);
        
        console.error(`❌ Auth Failed [${region}]:`, err.message);
        
        // Don't log "Token Expired" spam, only actual attacks/failures
        if (!err.message.includes('expired')) {
            await writeAuditLog("SYSTEM", "UNKNOWN", "AUTH_FAILURE", `Token rejection: ${err.message}`, { region, ipAddress: String(ip) });
        }

        const status = err.message.includes('AUTH_CRASH') ? 503 : 401;
        return res.status(status).json({ error: "Unauthorized" });
    }
};