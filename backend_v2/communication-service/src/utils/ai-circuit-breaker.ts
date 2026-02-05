import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { GoogleAuth } from "google-auth-library";
import { AzureOpenAI } from "openai"; // Pseudo-code import, adjusting for actual SDK usage if needed, usually we use 'openai' package with azure endpoint
import { OpenAI } from "openai";
import { getSSMParameter } from "../config/aws"; // Assuming we have this config
import winston from "winston";

// Logger setup (Placeholder, will be unified later)
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
});

// --- configuration types ---
interface AIResponse {
    text: string;
    provider: string;
    model: string;
}

export class AICircuitBreaker {
    private bedrockClient: BedrockRuntimeClient;
    private azureClient: OpenAI | null = null;
    private googleAuth: GoogleAuth | null = null;

    constructor() {
        this.bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
    }

    /**
     * Primary Entry Point: Try Bedrock -> Vertex -> Azure
     */
    public async generateResponse(prompt: string, logs: string[]): Promise<AIResponse> {
        try {
            return await this.callBedrock(prompt);
        } catch (bedrockError: any) {
            logger.warn("⚠️ Bedrock Failed. Failover to Vertex AI...", { error: bedrockError.message });
            logs.push(`Bedrock Failed: ${bedrockError.message}`);

            try {
                return await this.callVertexAI(prompt);
            } catch (vertexError: any) {
                logger.warn("⚠️ Vertex AI Failed. Failover to Azure OpenAI...", { error: vertexError.message });
                logs.push(`Vertex Failed: ${vertexError.message}`);

                try {
                    return await this.callAzureOpenAI(prompt);
                } catch (azureError: any) {
                    logger.error("❌ ALL AI PROVIDERS FAILED.", { error: azureError.message });
                    throw new Error("AI Service Unavailable: All circuits broken.");
                }
            }
        }
    }

    // --- 1. AWS BEDROCK (Primary) ---
    private async callBedrock(prompt: string): Promise<AIResponse> {
        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 500,
                messages: [{ role: "user", content: prompt }]
            })
        });

        const response = await this.bedrockClient.send(command);
        const body = JSON.parse(new TextDecoder().decode(response.body));

        return {
            text: body.content[0].text,
            provider: "AWS Bedrock",
            model: "Claude 3 Haiku"
        };
    }

    // --- 2. GOOGLE VERTEX AI (First Failover) ---
    private async callVertexAI(prompt: string): Promise<AIResponse> {
        if (!this.googleAuth) {
            const credentials = await getSSMParameter("/mediconnect/prod/gcp/service-account");
            if (credentials) {
                this.googleAuth = new GoogleAuth({
                    credentials: JSON.parse(credentials),
                    scopes: ['https://www.googleapis.com/auth/cloud-platform']
                });
            } else {
                throw new Error("GCP Credentials not found in SSM");
            }
        }

        const client = await this.googleAuth.getClient();
        const accessToken = (await client.getAccessToken()).token;
        const projectId = await this.googleAuth.getProjectId();

        const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-1.5-flash:generateContent`;

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }]
            })
        });

        if (!response.ok) {
            throw new Error(`Vertex API Error: ${response.statusText}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) throw new Error("Invalid Vertex Response");

        return {
            text: text,
            provider: "GCP Vertex AI",
            model: "Gemini 1.5 Flash"
        };
    }

    // --- 3. AZURE OPENAI (Final Failover) ---
    private async callAzureOpenAI(prompt: string): Promise<AIResponse> {
        // Initialize lazy to save cost/startup time if not needed
        if (!this.azureClient) {
            const apiKey = await getSSMParameter("/mediconnect/prod/azure/openai_key", true);
            const endpoint = await getSSMParameter("/mediconnect/prod/azure/openai_endpoint");
            const deployment = await getSSMParameter("/mediconnect/prod/azure/openai_deployment"); // e.g., "gpt-35-turbo"

            if (!apiKey || !endpoint) throw new Error("Azure OpenAI config missing");

            this.azureClient = new OpenAI({
                apiKey: apiKey,
                baseURL: `${endpoint}/openai/deployments/${deployment}`,
                defaultQuery: { 'api-version': '2023-05-15' },
                defaultHeaders: { 'api-key': apiKey }
            });
        }

        const completion = await this.azureClient.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "", // Model is determined by deployment ID in baseURL for Azure
        });

        return {
            text: completion.choices[0].message.content || "",
            provider: "Azure OpenAI",
            model: "GPT-3.5 Turbo"
        };
    }
}
