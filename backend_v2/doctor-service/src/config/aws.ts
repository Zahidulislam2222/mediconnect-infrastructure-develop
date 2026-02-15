import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";

// Universal Clients
export const ssmClient = new SSMClient({ region: REGION });
export const dbClient = new DynamoDBClient({ region: REGION });
export const docClient = DynamoDBDocumentClient.from(dbClient);

// Cache for secrets to reduce SSM calls
const secretCache: Record<string, string> = {};

/**
 * Validates 'The Vault' access via SSM Parameter Store.
 * @param path SSM Parameter Path (e.g., /mediconnect/prod/stripe/key)
 * @param isSecure If true, decrypts the parameter
 */
export const getSSMParameter = async (path: string, isSecure: boolean = false): Promise<string | undefined> => {
    // 🟢 REACTIVE FIX: Check memory cache first
    const envMap: Record<string, string | undefined> = {
        '/mediconnect/prod/kms/signing_key_id': process.env.KMS_KEY_ID,
        '/mediconnect/prod/cognito/client_id': process.env.COGNITO_CLIENT_ID,
        '/mediconnect/prod/cognito/user_pool_id': process.env.COGNITO_USER_POOL_ID
    };

    if (envMap[path]) return envMap[path];
    if (secretCache[path]) return secretCache[path];

    try {
        const command = new GetParameterCommand({ Name: path, WithDecryption: isSecure });
        const response = await ssmClient.send(command);
        const value = response.Parameter?.Value;
        if (value) secretCache[path] = value;
        return value;
    } catch (error) {
        console.error(`Failed to fetch SSM parameter: ${path}`, error);
        return undefined;
    }
};
