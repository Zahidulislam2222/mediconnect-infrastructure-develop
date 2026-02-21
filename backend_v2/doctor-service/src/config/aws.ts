import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { KMSClient } from "@aws-sdk/client-kms";

// Keep your existing setup
const REGION = process.env.AWS_REGION || "us-east-1";
export const ssmClient = new SSMClient({ region: REGION });

const requestHandler = { connectionTimeout: 5000, socketTimeout: 5000 };

// 🟢 REGIONAL DYNAMODB FACTORY (GDPR Compliance)
const clients: Record<string, DynamoDBDocumentClient> = {};
const s3Clients: Record<string, S3Client> = {};
const kmsClients: Record<string, KMSClient> = {};
const ssmClients: Record<string, SSMClient> = {};

export const getRegionalClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (clients[r]) return clients[r];

    const client = new DynamoDBClient({ region: r, requestHandler });
    clients[r] = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true, convertEmptyValues: true }
    });
    return clients[r];
};

export const getRegionalS3Client = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (s3Clients[r]) return s3Clients[r];

    s3Clients[r] = new S3Client({ region: r, requestHandler });
    return s3Clients[r];
};

// Default static client for US-only legacy tasks (Kept to prevent breaking)
export const docClient = getRegionalClient('US');

export const getRegionalKMSClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (kmsClients[r]) return kmsClients[r];

    kmsClients[r] = new KMSClient({ region: r, requestHandler });
    return kmsClients[r];
};

export const getRegionalSSMClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (ssmClients[r]) return ssmClients[r];

    ssmClients[r] = new SSMClient({ region: r, requestHandler });
    return ssmClients[r];
};

// 🟢 THE FIX: Add this export so auth.middleware.ts stops crashing
export const COGNITO_CONFIG: any = {
    US: {
        REGION: 'us-east-1',
        // Fallback logic: Try specific US var, then generic var
        USER_POOL_ID: process.env.COGNITO_USER_POOL_ID_US || process.env.COGNITO_USER_POOL_ID,
        CLIENT_DOCTOR: process.env.COGNITO_CLIENT_ID_US_DOCTOR || process.env.COGNITO_CLIENT_ID,
    },
    EU: {
        REGION: 'eu-central-1',
        USER_POOL_ID: process.env.COGNITO_USER_POOL_ID_EU,
        CLIENT_DOCTOR: process.env.COGNITO_CLIENT_ID_EU_DOCTOR,
    }
};

// Secret Cache logic remains unchanged
const secretCache: Record<string, string> = {};

export const getSSMParameter = async (path: string, isSecure: boolean = false): Promise<string | undefined> => {
    // 🟢 REACTIVE FIX: Check memory cache first
    const envMap: Record<string, string | undefined> = {
        '/mediconnect/prod/kms/signing_key_id': process.env.KMS_KEY_ID,
        '/mediconnect/prod/cognito/client_id': COGNITO_CONFIG.US.CLIENT_DOCTOR,
        '/mediconnect/prod/cognito/user_pool_id': COGNITO_CONFIG.US.USER_POOL_ID,
        '/mediconnect/prod/cognito/user_pool_id_eu': COGNITO_CONFIG.EU.USER_POOL_ID
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