import { ComprehendMedicalClient, DetectEntitiesV2Command } from "@aws-sdk/client-comprehendmedical";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { GoogleAuth } from "google-auth-library";
import { v4 as uuidv4 } from "uuid";

// --- CONFIGURATION ---
const REGION = "us-east-1";
const DYNAMO_TABLE = "mediconnect-symptom-logs";
const BEDROCK_MODEL_ID = "us.anthropic.claude-3-5-haiku-20241022-v1:0";// --- BIGQUERY CONFIG ---
const BQ_DATASET = "mediconnect_ai"; 
const BQ_TABLE = "symptom_logs";    

const comprehendClient = new ComprehendMedicalClient({ region: REGION });
const dbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const bedrockClient = new BedrockRuntimeClient({ region: REGION });

const HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST"
};

// --- HELPER: CLEAN JSON ---
function cleanAndParseJSON(text) {
    try {
        let clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
        const firstOpen = clean.indexOf("{");
        const lastClose = clean.lastIndexOf("}");
        if (firstOpen !== -1 && lastClose !== -1) {
            clean = clean.substring(firstOpen, lastClose + 1);
            return JSON.parse(clean);
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function getRiskAssessmentFromBedrock(symptoms) {
    if (!symptoms || symptoms.length === 0) return { risk: "Low", reason: "No symptoms detected." };

    const command = new InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 200,
            messages: [{ role: "user", content: `You are a medical triage AI. Analyze these symptoms: ${symptoms.join(", ")}. 
            Determine the risk level (High, Medium, Low).
            Return ONLY a JSON object: {"risk": "High|Medium|Low", "reason": "Short explanation"}` }]
        })
    });

    try {
        const response = await bedrockClient.send(command);
        const body = JSON.parse(new TextDecoder().decode(response.body));
        const text = body.content[0].text;
        const result = cleanAndParseJSON(text);
        return result || { risk: "Undetermined", reason: "Format Error in AI response" };
    } catch (error) {
        console.error("❌ AWS Bedrock Error:", error.name);
        throw error;
    }
}

async function getRiskAssessmentFromVertex(symptoms, accessToken, projectId) {
    console.log("⚠️ Failover: Calling Google Vertex AI...");
    try {
        // Using Gemini 1.5 Flash (Most Stable)
        const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`;
        
        const response = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ 
                    role: "user",  // 🟢 FIXED: This line is required by Google
                    parts: [{ text: `You are a medical triage AI. Analyze these symptoms: ${symptoms.join(", ")}. 
                    Determine risk: High, Medium, or Low.
                    Return ONLY raw JSON. No markdown.
                    Example: {"risk": "High", "reason": "Patient indicates severe pain."}` }] 
                }]
            })
        });

        const data = await response.json();
        
        if (data.error) {
            console.error("❌ Google API Error:", JSON.stringify(data.error));
            return { risk: "Medium", reason: `Google Error: ${data.error.message}` };
        }

        if (data.candidates && data.candidates[0].content) {
            let rawText = data.candidates[0].content.parts[0].text;
            const result = cleanAndParseJSON(rawText);
            return result || { risk: "Medium", reason: "Google Vertex: " + rawText.substring(0, 100) };
        }
        
        return { risk: "Medium", reason: "Google Vertex: No response generated." };

    } catch (error) {
        console.error("❌ Vertex AI Network Failed:", error);
        return { risk: "Medium", reason: "Hybrid Cloud Connection Failed." };
    }
}

async function logToBigQuery(data, accessToken, projectId) {
    // 🟢 FIXED URL: added /bigquery/v2/
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${BQ_DATASET}/tables/${BQ_TABLE}/insertAll`;
    
    const bqData = {
        kind: "bigquery#tableDataInsertAllRequest",
        rows: [{
            json: {
                user_id: data.userId,
                timestamp: data.timestamp,
                symptoms: data.symptoms.join(", "),
                risk_level: data.riskAssessment.risk,
                provider: data.aiProvider
            }
        }]
    };

    const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(bqData)
    });

    if (response.ok) {
        console.log("✅ BigQuery Insert Success");
        return "Success";
    } else {
        const err = await response.text();
        console.log("BigQuery Fail", err);
        return "Failed"; 
    }
}

export const handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

    try {
        const body = event.body ? JSON.parse(event.body) : event;
        const { text, sessionId, userId } = body;
        console.log(`🚀 Input: "${text}"`);

        const compResponse = await comprehendClient.send(new DetectEntitiesV2Command({ Text: text }));
        const symptoms = compResponse.Entities
            .filter(e => e.Category === "MEDICAL_CONDITION" || e.Category === "SYMPTOM")
            .map(e => e.Text);

        let accessToken = null;
        let projectId = null;
        
        if (process.env.GCP_SA_KEY) {
            try {
                const credentials = JSON.parse(process.env.GCP_SA_KEY);
                projectId = credentials.project_id; 
                
                const auth = new GoogleAuth({
                    credentials,
                    scopes: ['https://www.googleapis.com/auth/cloud-platform']
                });
                const client = await auth.getClient();
                accessToken = (await client.getAccessToken()).token;
            } catch (authError) {
                console.error("Auth Error:", authError);
            }
        }

        let assessment;
        let aiProvider = "AWS Bedrock";

        try {
            assessment = await getRiskAssessmentFromBedrock(symptoms);
        } catch (e) {
            console.warn("⚠️ AWS Failed. Switching to Google Vertex.");
            if (accessToken && projectId) {
                assessment = await getRiskAssessmentFromVertex(symptoms, accessToken, projectId);
                aiProvider = "Google Vertex AI (Fallback)";
            } else {
                assessment = { risk: "Medium", reason: "AWS Failed & No Google Credentials." };
            }
        }

        const timestamp = new Date().toISOString();

        await docClient.send(new PutCommand({
            TableName: DYNAMO_TABLE,
            Item: {
                sessionId: sessionId || uuidv4(),
                timestamp,
                userId: userId || "anonymous",
                symptoms,
                riskAssessment: assessment,
                aiProvider
            }
        }));

        let bqStatus = "Skipped";
        if (accessToken && projectId) {
            bqStatus = await logToBigQuery({
                userId: userId || "anonymous",
                timestamp,
                symptoms,
                riskAssessment: assessment,
                aiProvider
            }, accessToken, projectId);
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                success: true,
                provider: aiProvider,
                risk_analysis: assessment,
                analytics: `BigQuery: ${bqStatus}` 
            })
        };

    } catch (error) {
        console.error("System Error:", error);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    }
};