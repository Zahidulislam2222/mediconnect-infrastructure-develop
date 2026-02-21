import { Request, Response, NextFunction } from 'express';
import { JwtRsaVerifier } from "aws-jwt-verify";
import axios from "axios";
// 🟢 ARCHITECTURE FIX: Import the Multi-Region Config Bridge
import { COGNITO_CONFIG } from '../config/aws';
import { writeAuditLog } from '../../../shared/audit';

// 🟢 GDPR FIX: Regional Cache Map (Instead of a single global variable)
// This ensures US tokens verify against US keys, and EU tokens against EU keys.
const verifiers: Record<string, any> = {};

const getVerifier = async (userRegion: string) => {
    // 1. Normalize Region
    const regionKey = userRegion?.toUpperCase().includes('EU') ? 'EU' : 'US';
    
    // 2. Check Cache for this SPECIFIC region
    if (verifiers[regionKey]) {
        return verifiers[regionKey];
    }

    console.log(`🔒 Initializing Auth Gatekeeper for Region: ${regionKey}`);

    // 3. Select Correct Infrastructure (GDPR Data Sovereignty)
    const config = COGNITO_CONFIG[regionKey];
    
    // Safety Check: Ensure secrets exist
    if (!config.USER_POOL_ID || !config.CLIENT_DOCTOR) {
        throw new Error(`AUTH_CONFIG_MISSING: No Cognito configuration found for ${regionKey}`);
    }

    const issuerUrl = `https://cognito-idp.${config.REGION}.amazonaws.com/${config.USER_POOL_ID}`;
    const jwksUrl = `${issuerUrl}/.well-known/jwks.json`;

    try {
        console.log(`🔑 Fetching JWKS from ${issuerUrl} (30s timeout)...`);
        
        // 4. Resilience: Manual fetch to bypass library timeouts in Cloud Run/Azure
        const response = await axios.get(jwksUrl, { timeout: 30000 });
        const jwks = response.data;

        // 5. Create Verifier
        const verifier = JwtRsaVerifier.create({
            issuer: issuerUrl,
            audience: config.CLIENT_DOCTOR, // Strict Role Isolation (Only Doctors)
            tokenUse: "id",
            jwks: jwks // Inject keys directly
        });

        // 6. Save to Regional Cache
        verifiers[regionKey] = verifier;
        console.log(`✅ Auth Gatekeeper READY for ${regionKey}`);
        
        return verifier;

    } catch (error: any) {
        console.error(`❌ Critical Auth Failure for ${regionKey}:`, error.message);
        throw error;
    }
};

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Unauthorized: Missing token" });
        }

        const token = authHeader.split(' ')[1];
        
        // 🟢 COMPILER FIX: Safely parse header array to string
        const rawRegion = req.headers['x-user-region'];
        const userRegion = Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");

        // 🟢 GDPR LOGIC: Get the correct verifier for this user's region
        const v = await getVerifier(userRegion);
        
        // Verify Token (Crypto Check)
        const payload = await v.verify(token);

        // 🟢 2026 SECURITY ENFORCEMENT: Explicit Group Check
        const groups = payload['cognito:groups'] || [];
        const isAuthorizedDoctor = groups.includes('doctor') || groups.includes('doctors');

        if (!isAuthorizedDoctor) {
            await writeAuditLog(payload.sub, "SYSTEM", "UNAUTHORIZED_ACCESS_DENIED", "User attempted to access doctor-service without being in 'doctor' group", {
                region: userRegion,
                ipAddress: req.ip,
                role: "REJECTED_CLIENT"
            });
            return res.status(403).json({ error: "Access Denied: High-security role required." });
        }

        // 🟢 CONTEXT INJECTION: Attach Region and Claims to Request
        // This allows downstream controllers to enforce HIPAA/GDPR rules
        (req as any).user = { 
            ...payload, 
            region: userRegion,
            // Helper to check roles easily later
            isDoctor: payload['cognito:groups']?.includes('doctor') || payload['cognito:groups']?.includes('doctors')
        };
        
        next();

    } catch (err: any) {
        console.error("Auth Middleware Blocked Request:", err.message);
        
        // Distinguish between Server Error (503) and User Error (401)
        if (err.message.includes('AUTH_CONFIG_MISSING') || err.message.includes('timeout')) {
            return res.status(503).json({ error: "Service unavailable during auth initialization" });
        }
        
        return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
    }
};