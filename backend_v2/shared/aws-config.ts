import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { SNSClient } from "@aws-sdk/client-sns";
import { SSMClient } from "@aws-sdk/client-ssm";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { KMSClient } from "@aws-sdk/client-kms";

/**
 * 🏛️ MAIN INGREDIENTS (COGNITO 2026 VAULT)
 * 🟢 SECURITY FIX: Hardcoded IDs removed. System will fail securely if ENV is missing.
 */
export const COGNITO_CONFIG = {
    US: {
        REGION: 'us-east-1',
        // 🟢 FIX: 'get' forces it to read the env AFTER the vault has synced
        get USER_POOL_ID() { return process.env.COGNITO_USER_POOL_ID_US || process.env.COGNITO_USER_POOL_ID || '' },
        get CLIENT_PATIENT() { return process.env.COGNITO_CLIENT_ID_US_PATIENT || '' }, 
        get CLIENT_DOCTOR() { return process.env.COGNITO_CLIENT_ID_US_DOCTOR || process.env.COGNITO_CLIENT_ID || '' },
    },
    EU: {
        REGION: 'eu-central-1',
        get USER_POOL_ID() { return process.env.COGNITO_USER_POOL_ID_EU || '' },
        get CLIENT_PATIENT() { return process.env.COGNITO_CLIENT_ID_EU_PATIENT || '' },
        get CLIENT_DOCTOR() { return process.env.COGNITO_CLIENT_ID_EU_DOCTOR || '' },
    }
};

/**
 * 🟢 HIPAA 2026 High Availability (HA) Configuration
 * Fixes Multi-Cloud (Azure/GCP) Cold Starts and Socket Hangs.
 */
const requestHandler = new NodeHttpHandler({
    connectionTimeout: 5000,
    socketTimeout: 5000,
});

// AWS SDK v3 standard config for resiliency
const awsConfigBase = {
    requestHandler,
    maxAttempts: 3, // 🟢 HIPAA Requirement: Automatic retries on network blips
};

/**
 * 🟢 GDPR STRICT ROUTING
 * Maps frontend headers strictly to the two physical legal jurisdictions.
 */
const normalizeRegion = (region: string = "us-east-1"): string => {
    const r = region?.toUpperCase();
    return (r === 'EU' || r === 'EU-CENTRAL-1') ? 'eu-central-1' : 'us-east-1';
};

// Memory Cache for Regional Instances
const clients: any = {
    ddb: {} as Record<string, DynamoDBDocumentClient>,
    s3: {} as Record<string, S3Client>,
    rek: {} as Record<string, RekognitionClient>,
    sns: {} as Record<string, SNSClient>,
    ssm: {} as Record<string, SSMClient>,
    kms: {} as Record<string, KMSClient>
};

// =========================================================================
// 🏭 REGIONAL FACTORIES (NO STATIC CLIENTS ALLOWED)
// =========================================================================

export const getRegionalClient = (region: string = "us-east-1"): DynamoDBDocumentClient => {
    const target = normalizeRegion(region);
    if (clients.ddb[target]) return clients.ddb[target];

    const client = new DynamoDBClient({ ...awsConfigBase, region: target });
    clients.ddb[target] = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true, convertEmptyValues: true }
    });
    return clients.ddb[target];
};

export const getRegionalS3Client = (region: string = "us-east-1"): S3Client => {
    const target = normalizeRegion(region);
    if (clients.s3[target]) return clients.s3[target];
    clients.s3[target] = new S3Client({ ...awsConfigBase, region: target });
    return clients.s3[target];
};

export const getRegionalRekognitionClient = (region: string = "us-east-1"): RekognitionClient => {
    const target = normalizeRegion(region);
    if (clients.rek[target]) return clients.rek[target];
    clients.rek[target] = new RekognitionClient({ ...awsConfigBase, region: target });
    return clients.rek[target];
};

export const getRegionalSNSClient = (region: string = "us-east-1"): SNSClient => {
    const target = normalizeRegion(region);
    if (clients.sns[target]) return clients.sns[target];
    clients.sns[target] = new SNSClient({ ...awsConfigBase, region: target });
    return clients.sns[target];
};

export const getRegionalSSMClient = (region: string = "us-east-1"): SSMClient => {
    const target = normalizeRegion(region);
    if (clients.ssm[target]) return clients.ssm[target];
    clients.ssm[target] = new SSMClient({ ...awsConfigBase, region: target });
    return clients.ssm[target];
};

export const getRegionalKMSClient = (region: string = "us-east-1"): KMSClient => {
    const target = normalizeRegion(region);
    if (clients.kms[target]) return clients.kms[target];
    clients.kms[target] = new KMSClient({ ...awsConfigBase, region: target });
    return clients.kms[target];
};