import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { KMSClient } from "@aws-sdk/client-kms";

// 🟢 HIPAA 2026: Hardened timeouts prevent socket-hang data corruption
const requestHandler = { connectionTimeout: 5000, socketTimeout: 5000 };

const clients: Record<string, DynamoDBDocumentClient> = {};
const ssmClients: Record<string, SSMClient> = {};
const snsClients: Record<string, SNSClient> = {};
const kmsClients: Record<string, KMSClient> = {};

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

// 🟢 FIX: SNS Communications must stay in local jurisdiction
export const getRegionalSNSClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (snsClients[r]) return snsClients[r];
    snsClients[r] = new SNSClient({ region: r, requestHandler });
    return snsClients[r];
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