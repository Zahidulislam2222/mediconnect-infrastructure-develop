import { Request, Response, NextFunction } from 'express';
import { JwtRsaVerifier } from "aws-jwt-verify";
import axios from "axios";

let verifier: any;

const getVerifier = async () => {
    if (!verifier) {
        // These must be provided via AWS SSM or .env for each service
        const userPoolId = process.env.COGNITO_USER_POOL_ID;
        const clientId = process.env.COGNITO_CLIENT_ID;
        const region = process.env.AWS_REGION || "us-east-1";

        if (!userPoolId || !clientId) {
            throw new Error("AUTH_ERROR: Cognito secrets missing in environment");
        }

        const issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
        const jwksUrl = `${issuerUrl}/.well-known/jwks.json`;

        try {
            // HIPAA Requirement: Secure Key Fetching with robust timeout
            const response = await axios.get(jwksUrl, { timeout: 30000 });
            const jwks = response.data;

            // GDPR Requirement: Strict signature verification
            verifier = JwtRsaVerifier.create({
                issuer: issuerUrl,
                audience: clientId,
                tokenUse: "id",
                jwks: jwks
            });

            console.log(`✅ Auth Gatekeeper Active [${region}]`);
        } catch (error: any) {
            console.error("❌ Auth Initialization Failed:", error.message);
            throw error;
        }
    }
    return verifier;
};

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Access Denied: No Token" });
        }

        const token = authHeader.split(' ')[1];
        const v = await getVerifier();

        // This is where HIPAA/GDPR 'Identity Verification' happens
        const payload = await v.verify(token);

        // Attach user to request for role-based access control (RBAC)
        (req as any).user = payload;
        next();
    } catch (err: any) {
        console.error("❌ Unauthorized Access Attempt:", err.message);
        return res.status(401).json({ error: "Access Denied: Invalid Session" });
    }
};