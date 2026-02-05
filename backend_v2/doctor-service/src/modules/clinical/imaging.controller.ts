import { Request, Response } from "express";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({ region: "us-east-1" });

export const analyzeImage = async (req: Request, res: Response) => {
    const { imageBase64, prompt } = req.body;

    if (!imageBase64) {
        return res.status(400).json({ error: "No image data" });
    }

    try {
        // AI Analysis via Bedrock (Claude 3 Vision)
        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 300,
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: prompt || "Analyze this medical image." },
                        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } }
                    ]
                }]
            })
        });

        const response = await bedrockClient.send(command);
        const body = JSON.parse(new TextDecoder().decode(response.body));

        res.json({
            analysis: body.content ? body.content[0].text : "Analysis Complete", // Safe access
            timestamp: new Date().toISOString()
        });

    } catch (error: any) {
        console.error("Imaging Error:", error);
        res.status(500).json({ error: error.message });
    }
};
