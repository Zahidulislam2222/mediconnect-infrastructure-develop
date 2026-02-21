import { Request, Response, NextFunction } from 'express';
import { JwtRsaVerifier } from "aws-jwt-verify";
import axios from "axios";
import { COGNITO_CONFIG } from '../config/aws';

const verifiers: Record<string, any> = {};

const getVerifier = async (userRegion: string) => {
    const regionKey = userRegion?.toUpperCase().includes('EU') ? 'EU' : 'US';
    
    if (verifiers[regionKey]) return verifiers[regionKey];

    const config = COGNITO_CONFIG[regionKey];
    
    // 🛡️ SECURITY FIX: Explicit check to prevent empty string bypass
    if (!config.USER_POOL_ID || !config.CLIENT_PATIENT) {
        throw new Error(`AUTH_CONFIG_MISSING: Missing Cognito config for ${regionKey}`);
    }

    const issuerUrl = `https://cognito-idp.${config.REGION}.amazonaws.com/${config.USER_POOL_ID}`;
    const jwksUrl = `${issuerUrl}/.well-known/jwks.json`;

    try {
        // Axios manual fetch prevents Cloud Run / Azure Container Apps timeout bugs
        const response = await axios.get(jwksUrl, { timeout: 30000 });
        const verifier = JwtRsaVerifier.create({
            issuer: issuerUrl,
            // 🟢 INTEROPERABILITY FIX: Allow BOTH Patient Tokens AND Doctor Tokens
            audience: [config.CLIENT_PATIENT, config.CLIENT_DOCTOR].filter(Boolean),
            tokenUse: "id",
            jwks: response.data
        });

        verifiers[regionKey] = verifier;
        return verifier;
    } catch (error: any) {
        throw new Error(`Failed to initialize JWKS for ${regionKey}`);
    }
};

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Unauthorized: Missing token" });
        }

        const token = authHeader.split(' ')[1];
        
        // Safely parse header array to string
        const rawRegion = req.headers['x-user-region'];
        const userRegion = Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");

        // Get strict regional verifier
        const v = await getVerifier(userRegion);
        const payload = await v.verify(token);

        // 🟢 CONTEXT INJECTION & FHIR MAPPING
        const groups = payload['cognito:groups'] || [];
        const isDoctor = groups.includes('doctor') || groups.includes('doctors');
        const isPatient = groups.includes('patient') || groups.includes('patients');

        if (!isDoctor && !isPatient) {
            return res.status(403).json({ error: "Access Denied: Unrecognized User Role" });
        }

        (req as any).user = { 
            id: payload.sub,
            email: payload.email,
            fhirId: payload["custom:fhir_id"] || payload.sub,
            region: userRegion,
            isDoctor,
            isPatient
        };
        
        next();

    } catch (err: any) {
        console.error("Auth Middleware Blocked Request:", err.message);
        return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
    }
};