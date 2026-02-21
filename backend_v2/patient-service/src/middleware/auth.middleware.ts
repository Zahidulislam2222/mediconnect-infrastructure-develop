import { Request, Response, NextFunction } from 'express';
import { CognitoJwtVerifier } from "aws-jwt-verify";

/**
 * 🛡️ ARCHITECTURE #2: GLOBAL MULTI-REGION VERIFIER
 * This middleware supports both US and EU Cognito Pools.
 * It implements a "Primary-Secondary" fallback to allow Doctors
 * to cross regions legally while keeping Patients locked to their region.
 */

// 1. Define Verifiers for each Region (Static initialization for performance)
const verifierUS = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID_US || "us-east-1_fUslfc7kL",
    tokenUse: "id", // We use ID tokens for rich profile data (Role/FHIR ID)
    clientId: process.env.COGNITO_CLIENT_ID_US || "",
});

const verifierEU = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID_EU || "eu-central-1_xxxxxxxxx",
    tokenUse: "id",
    clientId: process.env.COGNITO_CLIENT_ID_EU || "",
});

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') return next();

    let token = "";
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Missing or malformed Authorization header" });
    }

    token = authHeader.split(' ')[1];

    // Detect target region from header (Frontend must send 'US' or 'EU')
    const userRegion = (req.headers['x-user-region'] as string) || 'US';

    try {
        // 🧪 ATTEMPT 1: Verify with the user's selected Home Region
        const primaryVerifier = userRegion.toUpperCase() === 'EU' ? verifierEU : verifierUS;
        const payload = await primaryVerifier.verify(token);

        // Map payload to standard req.user object
        setReqUser(req, payload, userRegion);
        return next();

    } catch (err: any) {
        // 🧪 ATTEMPT 2: CROSS-BORDER DOCTOR VISITOR FALLBACK
        // If the primary region failed, it might be a doctor from the other region
        try {
            const secondaryVerifier = userRegion.toUpperCase() === 'EU' ? verifierUS : verifierEU;
            const payload = await secondaryVerifier.verify(token);

            // 🛑 SECURITY GATE: Only Doctors/Admins can cross borders
            const groups = payload["cognito:groups"] || [];
            const isDoctor = groups.some((g: string) => 
                ['doctor', 'provider', 'admin'].includes(g.toLowerCase())
            );

            if (!isDoctor) {
                throw new Error("Patient data residency violation: EU patients cannot be accessed by US patient tokens.");
            }

            // Success: Validating a "Visiting Doctor"
            setReqUser(req, payload, userRegion);
            return next();

        } catch (finalErr: any) {
            console.error(`[AUTH_FAIL] Region: ${userRegion} | Error: ${finalErr.message}`);
            return res.status(401).json({
                error: "Unauthorized",
                details: "Invalid token for this region or restricted cross-border access.",
                hint: "Ensure you are targeting the correct region header: x-user-region"
            });
        }
    }
};

/**
 * Helper to normalize Cognito payload into Express Request user
 */
function setReqUser(req: Request, payload: any, region: string) {
    const groups = payload["cognito:groups"] || [];
    const rawRole = groups.length > 0 ? groups[0].toLowerCase() : 'patient';

    (req as any).user = {
        id: payload.sub,
        email: payload.email,
        // FHIR Compliance: Extract the FHIR ID from the custom attribute we created
        fhirId: payload["custom:fhir_id"] || payload.sub,
        // Normalize Role
        role: (rawRole === 'provider' || rawRole === 'doctor') ? 'doctor' : 'patient',
        region: region.toUpperCase()
    };
}