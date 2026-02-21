import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { KMSClient } from "@aws-sdk/client-kms";
// 🟢 FIX: Added missing imports for AI and Notifications
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { SNSClient } from "@aws-sdk/client-sns";

const REGION = process.env.AWS_REGION || "us-east-1";
export const ssmClient = new SSMClient({ region: REGION });

// 🟢 HIPAA 2026: Hardened connection timeouts
const requestHandler = { connectionTimeout: 5000, socketTimeout: 5000 };

// Cache for Regional Instances
const clients: Record<string, DynamoDBDocumentClient> = {};
const s3Clients: Record<string, S3Client> = {};
const kmsClients: Record<string, KMSClient> = {};
const ssmClients: Record<string, SSMClient> = {};
// 🟢 FIX: Added cache for missing clients
const rekClients: Record<string, RekognitionClient> = {};
const snsClients: Record<string, SNSClient> = {};

// --- FACTORIES ---

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

// 🟢 FIX: Added Missing Rekognition Factory (Solves Error #1)
export const getRegionalRekognitionClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (rekClients[r]) return rekClients[r];
    rekClients[r] = new RekognitionClient({ region: r, requestHandler });
    return rekClients[r];
};

// 🟢 FIX: Added Missing SNS Factory (Solves Error #2)
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

export const getRegionalSSMClient = (region: string = "us-east-1") => {
    const r = region.toUpperCase() === 'EU' ? 'eu-central-1' : 'us-east-1';
    if (ssmClients[r]) return ssmClients[r];
    ssmClients[r] = new SSMClient({ region: r, requestHandler });
    return ssmClients[r];
};

export const COGNITO_CONFIG: Record<string, any> = {
    US: {
        REGION: 'us-east-1',
        USER_POOL_ID: process.env.COGNITO_USER_POOL_ID_US || process.env.COGNITO_USER_POOL_ID,
        CLIENT_PATIENT: process.env.COGNITO_CLIENT_ID_US_PATIENT || process.env.COGNITO_CLIENT_ID,
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
        console.error(`❌ [VAULT_ERROR][${region.toUpperCase()}] Access Denied or Missing: ${path}`);
        return undefined;
    }
};