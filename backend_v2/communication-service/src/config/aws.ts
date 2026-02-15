import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";

// 1. Singleton Clients (Performance Optimization)
export const ssmClient = new SSMClient({ region: REGION });
// HIPAA: DynamoDB encrypts at rest by default.
export const dbClient = new DynamoDBClient({ region: REGION });
export const docClient = DynamoDBDocumentClient.from(dbClient, {
    marshallOptions: { removeUndefinedValues: true }
});

// 2. Memory Cache (Cost & Latency Optimization)
const secretCache: Record<string, string> = {};

/**
 * Robust Secret Fetcher
 * Priority: 
 * 1. Process Environment (Azure Portal) - The "Source of Truth"
 * 2. Memory Cache - Speed
 * 3. AWS SSM - Centralized Vault
 */
export const getSSMParameter = async (path: string, isSecure: boolean = true): Promise<string | undefined> => {
    // 1. Check Azure Portal / Local Env Override
    const envMap: Record<string, string | undefined> = {
        '/mediconnect/prod/cognito/user_pool_id': process.env.COGNITO_USER_POOL_ID,
        '/mediconnect/prod/cognito/client_id': process.env.COGNITO_CLIENT_ID
    };

    if (envMap[path]) return envMap[path];
    
    // 2. Check Cache
    if (secretCache[path]) return secretCache[path];

    // 3. Fetch from AWS (Fail-Safe)
    try {
        const command = new GetParameterCommand({ Name: path, WithDecryption: isSecure });
        const response = await ssmClient.send(command);
        const value = response.Parameter?.Value;
        
        if (value) {
            secretCache[path] = value;
            return value;
        }
    } catch (error: any) {
        // Log warning but do not crash. This allows the app to survive transient AWS failures.
        console.warn(`⚠️ SSM Bypass for ${path}: ${error.message}`);
        return undefined;
    }
    return undefined;
};