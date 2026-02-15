import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const region = process.env.AWS_REGION || "us-east-1";

// 1. DynamoDB (Singleton)
// HIPAA: Encryption at rest is handled by AWS DynamoDB by default
const dbClient = new DynamoDBClient({ region });
export const docClient = DynamoDBDocumentClient.from(dbClient, {
    marshallOptions: { removeUndefinedValues: true }
});

// 2. Secrets & SSM Clients
const secretsClient = new SecretsManagerClient({ region });
const ssmClient = new SSMClient({ region });

// Cache to prevent expensive API calls on every request
const paramCache: Record<string, string> = {};

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
        console.warn(`⚠️ AWS Secret ${secretName} not found. Returning null.`);
        return null;
    }
}

export async function getSSMParameter(name: string, withDecryption: boolean = false): Promise<string | undefined> {
    // 1. Check Local Environment First (Azure Portal Override)
    // This mapping ensures Manual Settings take priority over AWS
    const envMap: Record<string, string | undefined> = {
        '/mediconnect/prod/cognito/user_pool_id': process.env.COGNITO_USER_POOL_ID,
        '/mediconnect/prod/cognito/client_id': process.env.COGNITO_CLIENT_ID,
        '/mediconnect/stripe/keys': process.env.STRIPE_SECRET_KEY,
        '/mediconnect/stripe/secret_key': process.env.STRIPE_SECRET_KEY,
        '/mediconnect/prod/db/master_password': process.env.DB_PASSWORD,
        '/mediconnect/prod/gcp/sql/db_user': process.env.DB_USER
    };

    if (envMap[name]) return envMap[name];

    // 2. Check Memory Cache
    if (paramCache[name]) return paramCache[name];

    // 3. Fetch from AWS (Fail-Safe)
    try {
        const command = new GetParameterCommand({ Name: name, WithDecryption: withDecryption });
        const response = await ssmClient.send(command);
        if (response.Parameter?.Value) {
            paramCache[name] = response.Parameter.Value;
            return response.Parameter.Value;
        }
    } catch (error: any) {
        // Log warning but do not crash. Return undefined so caller can handle it.
        console.warn(`⚠️ SSM Fetch Failed for ${name}: ${error.message}`);
        return undefined;
    }
    return undefined;
}