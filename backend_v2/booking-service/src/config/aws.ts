import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";

// 🟢 HIPAA 2026: Hardened connection timeouts (Multi-Cloud Resiliency)
const requestHandler = { connectionTimeout: 5000, socketTimeout: 5000 };

// Cache for Regional Instances
const clients: Record<string, DynamoDBDocumentClient> = {};
const ssmClients: Record<string, SSMClient> = {};
const kmsClients: Record<string, KMSClient> = {};
const secretsClients: Record<string, SecretsManagerClient> = {};

export const getRegionalClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (clients[r]) return clients[r];

    const client = new DynamoDBClient({ region: r, requestHandler });
    clients[r] = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true, convertEmptyValues: true }
    });
    return clients[r];
};

export const getRegionalSSMClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (ssmClients[r]) return ssmClients[r];
    ssmClients[r] = new SSMClient({ region: r, requestHandler });
    return ssmClients[r];
};

export const getRegionalSecretsClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (secretsClients[r]) return secretsClients[r];
    secretsClients[r] = new SecretsManagerClient({ region: r, requestHandler });
    return secretsClients[r];
};

export const getRegionalKMSClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (kmsClients[r]) return kmsClients[r];
    kmsClients[r] = new KMSClient({ region: r, requestHandler });
    return kmsClients[r];
};

export const COGNITO_CONFIG: any = {
    US: {
        REGION: 'us-east-1',
        USER_POOL_ID: process.env.COGNITO_USER_POOL_ID_US || process.env.COGNITO_USER_POOL_ID,
        CLIENT_PATIENT: process.env.COGNITO_CLIENT_ID_US_PATIENT,
        CLIENT_DOCTOR: process.env.COGNITO_CLIENT_ID_US_DOCTOR
    },
    EU: {
        REGION: 'eu-central-1',
        USER_POOL_ID: process.env.COGNITO_USER_POOL_ID_EU,
        CLIENT_PATIENT: process.env.COGNITO_CLIENT_ID_EU_PATIENT,
        CLIENT_DOCTOR: process.env.COGNITO_CLIENT_ID_EU_DOCTOR
    }
};

const secretCache: Record<string, string> = {};

// 🟢 FIX: Secure Regional Stripe & Database Keys Fetcher
export const getSSMParameter = async (path: string, region: string = "us-east-1", isSecure: boolean = true): Promise<string | undefined> => {
    const cacheKey = `${region}:${path}`;
    if (secretCache[cacheKey]) return secretCache[cacheKey];

    try {
        const regionalSsm = getRegionalSSMClient(region);
        const command = new GetParameterCommand({ Name: path, WithDecryption: isSecure });
        const response = await regionalSsm.send(command);
        const value = response.Parameter?.Value;

        if (value) {
            secretCache[cacheKey] = value; 
        }
        return value;
    } catch (error: any) {
        console.error(`❌ [VAULT_ERROR][${region.toUpperCase()}] SSM Fetch Failed: ${path}`);
        return undefined;
    }
};

// 🟢 FIX: Secure Regional Secrets Manager (For Stripe Webhooks)
export async function getSecret(secretName: string, region: string = "us-east-1"): Promise<string | null> {
    try {
        const regionalSecrets = getRegionalSecretsClient(region);
        const data = await regionalSecrets.send(new GetSecretValueCommand({ SecretId: secretName }));
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
        console.error(`❌ [VAULT_ERROR][${region.toUpperCase()}] Secret Fetch Failed: ${secretName}`);
        return null;
    }
}