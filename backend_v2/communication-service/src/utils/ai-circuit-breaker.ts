import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { GoogleAuth } from "google-auth-library";
import { OpenAI } from "openai";
import { getSSMParameter } from "../config/aws";
import winston from "winston";
import { scrubPII } from "./fhir-mapper";

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
});

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
     * 1. TEXT GENERATION ENTRY POINT
     * Failover: Bedrock -> Vertex -> Azure -> Emergency Fallback
     */
    public async generateResponse(prompt: string, logs: string[]): Promise<AIResponse> {
        const cleanPrompt = scrubPII(prompt);

        try {
            const response = await this.callBedrock(cleanPrompt);
            response.text = scrubPII(response.text);
            return response;
        } catch (bedrockError: any) {
            logger.warn("⚠️ Bedrock Failed. Failover to Vertex AI...");
            logs.push(`Bedrock Failed: ${bedrockError.message}`);

            try {
                const response = await this.callVertexAI(cleanPrompt);
                response.text = scrubPII(response.text);
                return response;
            } catch (vertexError: any) {
                logger.warn("⚠️ Vertex AI Failed. Failover to Azure OpenAI...");
                logs.push(`Vertex Failed: ${vertexError.message}`);

                try {
                    const response = await this.callAzureOpenAI(cleanPrompt);
                    response.text = scrubPII(response.text);
                    return response;
                } catch (azureError: any) {
                    logger.error("❌ ALL AI PROVIDERS FAILED.");
                    // 🟢 PROFESSIONAL RESILIENCE: Emergency Fallback instead of 500 Error
                    return {
                        text: JSON.stringify({
                            risk: "Medium",
                            reason: "AI Clinical Service is temporarily degraded. Standard protocols suggest immediate clinical review."
                        }),
                        provider: "System Recovery",
                        model: "Emergency-Fallback"
                    };
                }
            }
        }
    }

    /**
     * 2. VISION (IMAGING) ENTRY POINT
     * Required for HealthRecords.tsx / imaging.controller.ts
     */
    public async generateVisionResponse(prompt: string, imageBase64: string): Promise<AIResponse> {
        const cleanPrompt = scrubPII(prompt);

        try {
            // Primary: Bedrock Vision (Claude Sonnet)
            return await this.callBedrockVision(cleanPrompt, imageBase64);
        } catch (error: any) {
            logger.warn("⚠️ Bedrock Vision Failed. Failover to Vertex Vision...");
            try {
                // Fallover: Vertex Vision (Gemini Flash)
                return await this.callVertexVision(cleanPrompt, imageBase64);
            } catch (vError: any) {
                logger.error("❌ ALL VISION PROVIDERS FAILED.");
                throw new Error("Imaging AI Service Unavailable");
            }
        }
    }

    // --- PRIVATE PROVIDERS: TEXT ---

    private async callBedrock(prompt: string): Promise<AIResponse> {
        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-4-5-haiku-20251015-v1:0",
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
        return { text: body.content[0].text, provider: "AWS Bedrock", model: "Claude 4.5 Haiku" };
    }

    private async callVertexAI(prompt: string): Promise<AIResponse> {
        const { accessToken, projectId } = await this.getGCPAuth();
        const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`;

        const response = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(`Vertex_Error_${response.status}`);
        return {
            text: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
            provider: "GCP Vertex AI",
            model: "Gemini 2.5 Flash"
        };
    }

    private async callAzureOpenAI(prompt: string): Promise<AIResponse> {
        if (!this.azureClient) {
            const apiKey = await getSSMParameter("/mediconnect/prod/azure/cosmos/primary_key", true);
            const endpoint = await getSSMParameter("/mediconnect/prod/azure/cosmos/endpoint");
            const deployment = "gpt-5-mini";

            this.azureClient = new OpenAI({
                apiKey: apiKey,
                baseURL: `${endpoint}/openai/deployments/${deployment}`,
                defaultQuery: { 'api-version': '2025-11-01-preview' },
                defaultHeaders: { 'api-key': apiKey }
            });
        }

        const completion = await this.azureClient.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "gpt-5-mini",
        });

        return { text: completion.choices[0].message.content || "", provider: "Azure OpenAI", model: "GPT-5-mini" };
    }

    // --- PRIVATE PROVIDERS: VISION ---

    private async callBedrockVision(prompt: string, imageBase64: string): Promise<AIResponse> {
        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0", // Sonnet is superior for Medical Vision
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 1000,
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } }
                    ]
                }]
            })
        });
        const res = await this.bedrockClient.send(command);
        const body = JSON.parse(new TextDecoder().decode(res.body));
        return { text: body.content[0].text, provider: "AWS Bedrock", model: "Claude 3.5 Sonnet Vision" };
    }

    private async callVertexVision(prompt: string, imageBase64: string): Promise<AIResponse> {
        const { accessToken, projectId } = await this.getGCPAuth();
        const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`;

        const response = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    role: "user",
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }
                    ]
                }]
            })
        });
        const data = await response.json();
        return { text: data.candidates?.[0]?.content?.parts?.[0]?.text || "", provider: "GCP Vertex AI", model: "Gemini 2.5 Vision" };
    }

    // --- HELPERS ---

    private async getGCPAuth() {
        if (!this.googleAuth) {
            const saKey = await getSSMParameter("/mediconnect/prod/gcp/service-account", true);
            if (!saKey) throw new Error("GCP_KEY_MISSING");
            this.googleAuth = new GoogleAuth({
                credentials: JSON.parse(saKey),
                scopes: ['https://www.googleapis.com/auth/cloud-platform']
            });
        }
        const client = await this.googleAuth.getClient();
        const token = (await client.getAccessToken()).token;
        const projId = (this.googleAuth as any).projectId || JSON.parse((await getSSMParameter("/mediconnect/prod/gcp/service-account", true))!).project_id;
        return { accessToken: token, projectId: projId };
    }
}