import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const region = process.env.AWS_REGION || "us-east-1";

// 1. DynamoDB
const dbClient = new DynamoDBClient({ region });
export const docClient = DynamoDBDocumentClient.from(dbClient);

// 2. Secrets & SSM
const secretsClient = new SecretsManagerClient({ region });
const ssmClient = new SSMClient({ region });

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
        console.warn(`Secret ${secretName} not found`);
        return null;
    }
}

export async function getSSMParameter(name: string, withDecryption: boolean = false): Promise<string | undefined> {
    try {
        const command = new GetParameterCommand({
            Name: name,
            WithDecryption: withDecryption,
        });
        const response = await ssmClient.send(command);
        return response.Parameter?.Value;
    } catch (error) {
        console.error(`Failed to fetch SSM parameter ${name}:`, error);
        return undefined;
    }
}
