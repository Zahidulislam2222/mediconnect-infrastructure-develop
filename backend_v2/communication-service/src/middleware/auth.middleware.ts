import { Request, Response, NextFunction } from 'express';
import { JwtRsaVerifier } from "aws-jwt-verify";
import axios from "axios";

let verifier: any;

export const getVerifier = async () => {
    if (!verifier) {
        const poolId = process.env.COGNITO_USER_POOL_ID;
        const clientId = process.env.COGNITO_CLIENT_ID;
        const region = process.env.AWS_REGION || "us-east-1";

        if (!poolId || !clientId || poolId.includes('PLACEHOLDER')) {
            throw new Error("AUTH_NOT_READY: Real Cognito secrets not loaded");
        }

        const issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
        const jwksUrl = `${issuerUrl}/.well-known/jwks.json`;

        try {
            console.log(`Fetching Auth Keys (30s timeout)...`);
            const response = await axios.get(jwksUrl, { timeout: 30000 });
            const jwks = response.data;

            verifier = JwtRsaVerifier.create({
                issuer: issuerUrl,
                audience: clientId,
                tokenUse: "id",
                jwks: jwks
            });
            console.log("✅ Auth Gatekeeper: READY");
        } catch (error: any) {
            console.error("❌ Key Fetch Failed:", error.message);
            throw error;
        }
    }
    return verifier;
};

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Unauthorized: Missing token" });
        }

        const token = authHeader.split(' ')[1];
        const v = await getVerifier();
        const payload = await v.verify(token);

        (req as any).user = payload;
        next();
    } catch (err: any) {
        console.error("Auth Failure:", err.message);
        const status = err.message.includes('AUTH_NOT_READY') ? 503 : 401;
        return res.status(status).json({ error: "Unauthorized" });
    }
};
