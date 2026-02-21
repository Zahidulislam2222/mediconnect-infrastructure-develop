import { GetParameterCommand } from "@aws-sdk/client-ssm";

// 🟢 ARCHITECTURE FIX: Import everything from the Shared Factory.
// This completely eliminates "Code Drift" between microservices.
import { 
    getRegionalClient, 
    getRegionalS3Client, 
    getRegionalRekognitionClient, 
    getRegionalSNSClient,
    getRegionalSSMClient,
    COGNITO_CONFIG 
} from "../../../shared/aws-config";

// 🟢 Re-export the factories so `doctor.controller.ts` doesn't break its imports.
export { 
    getRegionalClient, 
    getRegionalS3Client, 
    getRegionalRekognitionClient, 
    getRegionalSNSClient,
    COGNITO_CONFIG
};

// 🟢 GDPR FIX: 'docClient' export is PERMANENTLY DELETED. 
// Developers can no longer accidentally save EU data to the US by using a static default.

// =========================================================================
// 🔐 DOCTOR-SERVICE SPECIFIC SECRETS CACHE
// =========================================================================

const secretCache: Record<string, string> = {};

export const getSSMParameter = async (path: string, isSecure: boolean = true): Promise<string | undefined> => {
    
    // 1. Reactive Check: Environment Variables First
    const envMap: Record<string, string | undefined> = {
        '/mediconnect/prod/kms/signing_key_id': process.env.KMS_KEY_ID,
        '/mediconnect/prod/cognito/client_id': COGNITO_CONFIG.US.CLIENT_DOCTOR,
        '/mediconnect/prod/cognito/user_pool_id': COGNITO_CONFIG.US.USER_POOL_ID,
        '/mediconnect/prod/cognito/user_pool_id_eu': COGNITO_CONFIG.EU.USER_POOL_ID
    };

    if (envMap[path] && envMap[path] !== '') return envMap[path];
    
    // 2. Cache Check: Prevent rate-limiting from AWS SSM
    if (secretCache[path]) return secretCache[path];

    // 3. Network Fetch using the Shared Regional Client (Default to US for Global Secrets)
    try {
        const ssmClient = getRegionalSSMClient('us-east-1');
        const command = new GetParameterCommand({ Name: path, WithDecryption: isSecure });
        const response = await ssmClient.send(command);
        const value = response.Parameter?.Value;
        
        if (value) {
            secretCache[path] = value;
            return value;
        }
    } catch (error: any) {
        console.warn(`⚠️ AWS SSM Fetch Failed for ${path}: ${error.message}`);
        return undefined;
    }
};