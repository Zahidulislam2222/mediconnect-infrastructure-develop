import { Request, Response, NextFunction } from 'express';
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { writeAuditLog } from "../../../shared/audit";

let verifier: any;

export const getVerifier = async () => {
    if (!verifier) {
        const poolId = process.env.COGNITO_USER_POOL_ID;
        const clientId = process.env.COGNITO_CLIENT_ID;

        if (!poolId || !clientId || poolId.includes('PLACEHOLDER')) {
            return null;
        }

        verifier = CognitoJwtVerifier.create({
            userPoolId: poolId,
            tokenUse: "id",
            clientId: clientId,
            // 👇 ADD OR UPDATE THIS SECTION
            fetchOptions: {
                timeout: 10000 // Change 1500 or 5000 to 10000 (10 seconds)
            }
        });
    }
    return verifier;
};

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    // 🟢 1. INTERNAL SERVICE BYPASS (Check Query Parameter)
    if (req.query.internal_call === 'true') {
        console.log("✅ AWS Internal Call detected via Query. Bypassing Auth.");
        return next();
    }

    // 🟢 2. WebSocket Trust-AWS Bypass (For Handshake)
    const apiEvent = (req as any).apiGateway?.event || req.body;
    const awsAuthorizer = apiEvent?.requestContext?.authorizer;

    if (awsAuthorizer && (awsAuthorizer.sub || awsAuthorizer.principalId)) {
        console.log(`✅ Trusting AWS Identity: ${awsAuthorizer.sub || awsAuthorizer.principalId}`);
        (req as any).user = {
            sub: awsAuthorizer.sub || awsAuthorizer.principalId,
            role: awsAuthorizer.role || "patient",
            email: awsAuthorizer.email || ""
        };
        return next(); 
    }

    // 🟢 2. Existing Header Logic (Starts here)
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Missing token" });
        }

        const token = authHeader.split(' ')[1];
        const v = await getVerifier();

        if (!v) throw new Error("AUTH_NOT_READY");

        let payload;
        try {
            // Attempt strict verification
            payload = await v.verify(token);
        } catch (verifyError: any) {
            if (process.env.NODE_ENV === 'development' && verifyError.message.includes('fetch')) {
                console.warn("⚠️  DEV MODE: Network blocked Cognito. Using unsafe local decode.");
                const base64 = token.split('.')[1];
                const decoded = JSON.parse(Buffer.from(base64, 'base64').toString());

                // 🟢 PROFESSIONAL FIX: Look for standard Cognito role keys in the raw token
                const role = decoded["custom:role"] ||
                    (decoded["cognito:groups"] ? decoded["cognito:groups"][0] : null) ||
                    "doctor"; // Default to doctor for local testing if needed

                payload = { ...decoded, "custom:role": role };
            } else {
                throw verifyError;
            }
        }

        // Attach User to Request
        (req as any).user = {
    ...payload,
    sub: payload.sub || payload.id, // Fallback if one is missing
    role: payload["custom:role"] || (payload["cognito:groups"] ? payload["cognito:groups"][0] : "patient")
};

        next();
    } catch (err: any) {
        if (!err.message.includes('AUTH_NOT_READY')) {
            console.error("Auth Failure:", err.message);
            await writeAuditLog("SYSTEM", "UNKNOWN", "UNAUTHORIZED_ACCESS_ATTEMPT", err.message);
        }
        const status = err.message.includes('AUTH_NOT_READY') ? 503 : 401;
        return res.status(status).json({ error: "Unauthorized" });
    }
};