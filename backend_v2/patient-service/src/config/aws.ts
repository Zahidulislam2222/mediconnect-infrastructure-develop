import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client } from "@aws-sdk/client-s3";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const region = process.env.AWS_REGION || "us-east-1";

// Optimization: Shared HTTP Handler to prevent socket exhaustion
const requestHandler = new NodeHttpHandler({
    connectionTimeout: 5000,
    socketTimeout: 5000,
});

// 1. Core Clients
export const s3Client = new S3Client({ region, requestHandler });
export const rekognitionClient = new RekognitionClient({ region, requestHandler });
export const ssmClient = new SSMClient({ region, requestHandler });

// 2. DynamoDB (Encryption at rest enabled by default in AWS)
export const dbClient = new DynamoDBClient({ region, requestHandler });
export const docClient = DynamoDBDocumentClient.from(dbClient, {
    marshallOptions: { removeUndefinedValues: true }
});

const secretsClient = new SecretsManagerClient({ region, requestHandler });
const secretCache: Record<string, string> = {};

/**
 * Robust Secret Fetcher (Fail-Safe)
 * 1. Checks Process Env (Cloud Run / Azure Portal)
 * 2. Checks Memory Cache
 * 3. Fetches from AWS SSM
 */
export const getSSMParameter = async (path: string, isSecure: boolean = true): Promise<string | undefined> => {
    // 1. Priority: Environment Variables
    const envMap: Record<string, string | undefined> = {
        '/mediconnect/db/dynamo_table': process.env.DYNAMO_TABLE,
        '/mediconnect/s3/bucket_name': process.env.BUCKET_NAME,
        '/mediconnect/prod/cognito/client_id': process.env.COGNITO_CLIENT_ID,
        '/mediconnect/prod/cognito/user_pool_id': process.env.COGNITO_USER_POOL_ID,
        '/mediconnect/stripe/keys': process.env.STRIPE_SECRET_KEY,
        '/mediconnect/prod/cleanup/secret': process.env.CLEANUP_SECRET
    };

    if (envMap[path]) return envMap[path];
    if (secretCache[path]) return secretCache[path];

    // 2. Network Fetch (Fail-Safe)
    try {
        const command = new GetParameterCommand({ Name: path, WithDecryption: isSecure });
        const response = await ssmClient.send(command);
        const value = response.Parameter?.Value;
        if (value) {
            secretCache[path] = value;
            return value;
        }
    } catch (error: any) {
        console.warn(`⚠️ SSM Bypass for ${path}: ${error.message}`);
        // Do not crash. Return undefined so the app can try to survive.
        return undefined;
    }
    return undefined;
};

export async function getSecret(secretName: string): Promise<string | null> {
    try {
        const data = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
        if (data.SecretString) {
            try {
                const parsed = JSON.parse(data.SecretString);
                return parsed.secretKey || parsed;
            } catch {
                return data.SecretString;
            }
        }
        return null;
    } catch (err) {
        console.warn(`[AWS Config] Secret ${secretName} not found.`);
        return null;
    }
}