import { Request, Response, NextFunction } from 'express';
import { JwtRsaVerifier } from "aws-jwt-verify";
import axios from "axios";

let verifier: any;

const getVerifier = async () => {
    if (!verifier) {
        const userPoolId = process.env.COGNITO_USER_POOL_ID;
        const clientId = process.env.COGNITO_CLIENT_ID;
        const region = process.env.AWS_REGION || "us-east-1";

        if (!userPoolId || !clientId) {
            throw new Error("AUTH_ERROR: Cognito secrets missing in environment");
        }

        const issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
        const jwksUrl = `${issuerUrl}/.well-known/jwks.json`;

        try {
            const response = await axios.get(jwksUrl, { timeout: 30000 });
            const jwks = response.data;

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
    // 1. Allow OPTIONS requests for local CORS
    if (req.method === 'OPTIONS') return next();

    // 🟢 FIX: Define token OUTSIDE the try block so 'catch' can see it
    let token = "";

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: "No Authorization Header found" });
        }

        // 🟢 Assign value to the outer variable
        token = authHeader.split(' ')[1];
        
        const v = await getVerifier();
        const payload = await v.verify(token);

        const groups = payload["cognito:groups"] || [];
        const rawRole = groups.length > 0 ? groups[0].toLowerCase() : 'patient';

        (req as any).user = {
            id: payload.sub,
            email: payload.email,
            role: (rawRole === 'provider' || rawRole === 'doctor') ? 'doctor' : 'patient'
        };

        return next();
    } catch (err: any) {
        console.error("JWT Error:", err.message);
        
        // 🟢 DEBUGGING: Now this will work because 'token' is available
        return res.status(401).json({ 
            error: "AUTH_DEBUG_FAIL", 
            details: err.message,
            received_token_preview: token ? (token.substring(0, 10) + "...") : "NO_TOKEN",
            server_client_id: process.env.COGNITO_CLIENT_ID, 
            server_pool_id: process.env.COGNITO_USER_POOL_ID
        });
    }
};