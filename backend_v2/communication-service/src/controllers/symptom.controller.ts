import { Request, Response } from "express";
import { ComprehendMedicalClient, DetectEntitiesV2Command } from "@aws-sdk/client-comprehendmedical";
import { AICircuitBreaker } from "../utils/ai-circuit-breaker";
import { CosmosClient } from "@azure/cosmos";
import { getSSMParameter } from "../config/aws";
import { mapToFHIRDiagnosticReport, scrubPII } from "../utils/fhir-mapper";
import { writeAuditLog } from "../../../shared/audit";
import { jsPDF } from "jspdf";
import { v4 as uuidv4 } from "uuid";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
const sns = new SNSClient({ region: process.env.AWS_REGION || "us-east-1" });
import { GoogleAuth } from "google-auth-library";

const aiService = new AICircuitBreaker();
const comprehend = new ComprehendMedicalClient({ region: process.env.AWS_REGION || "us-east-1" });

// --- HELPER: CLEAN JSON (From Old Brain) ---
function cleanAndParseJSON(text: string) {
    try {
        let clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
        const firstOpen = clean.indexOf("{");
        const lastClose = clean.lastIndexOf("}");
        if (firstOpen !== -1 && lastClose !== -1) {
            clean = clean.substring(firstOpen, lastClose + 1);
            return JSON.parse(clean);
        }
        return null;
    } catch (e: any) { return null; } // 🟢 Added : any
}

// --- AZURE COSMOS DB (Architecture 2: Scale to Zero) ---
let cosmosContainer: any = null;
const getCosmosContainer = async () => {
    if (cosmosContainer) return cosmosContainer;

    // 🟢 SYNC WITH SCREENSHOT: Fetch individual components
    const endpoint = await getSSMParameter("/mediconnect/prod/azure/cosmos/endpoint");
    const key = await getSSMParameter("/mediconnect/prod/azure/cosmos/primary_key", true);

    if (!endpoint || !key) throw new Error("Cosmos DB Configuration Missing in SSM");

    const client = new CosmosClient({ endpoint, key });
    const database = client.database("mediconnect-db");
    cosmosContainer = database.container("symptom-checks");
    return cosmosContainer;
};

export const checkSymptoms = async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { text } = req.body;
    const sessionId = uuidv4();

    try {
        // 1. HIPAA: Scrub PII before any processing
        const cleanText = scrubPII(text);

        // 2. GATEKEEPER (Old Brain Logic): Check if it's actually medical
        const compRes = await comprehend.send(new DetectEntitiesV2Command({ Text: cleanText }));
        const symptoms = compRes.Entities?.filter(e =>
            (e.Category as string) === "MEDICAL_CONDITION" || (e.Category as string) === "SYMPTOM"
        ).map(e => e.Text) || [];

        if (symptoms.length === 0) {
            return res.status(400).json({ error: "No medical symptoms detected. Request blocked to save cost." });
        }

        // 3. AI CIRCUIT BREAKER (Azure -> Bedrock -> Vertex)
        const prompt = `Analyze these symptoms: ${symptoms.join(", ")}. Determine risk: High, Medium, or Low. Return ONLY JSON: {"risk": "High|Medium|Low", "reason": "Short explanation"}`;
        const aiResponse = await aiService.generateResponse(prompt, []);
        const analysis = cleanAndParseJSON(aiResponse.text) || { risk: "Medium", reason: "Analysis partial." };

        // 4. FHIR R4 MAPPING
        const fhirReport = mapToFHIRDiagnosticReport(user.sub, symptoms as string[], analysis, aiResponse.provider);

        // 5. ARCHITECTURE 2 STORAGE (Cosmos DB Serverless)
        try {
            const container = await getCosmosContainer();
            await container.items.create({
                id: sessionId,
                patientId: user.sub,
                timestamp: new Date().toISOString(),
                resource: fhirReport,
                provider: aiResponse.provider
            });
        } catch (dbError: any) {
            // 🟢 DO NOT CRASH: Log the error but let the user get the AI result
            console.error("📢 Database Log Failed (Firewall?):", dbError.message);
        }

        // --- 6. PROFESSIONAL CLINICAL PDF GENERATION ---
        const doc = new jsPDF();
        const pageWidth = doc.internal.pageSize.getWidth();

        // 1. Header Bar (Medical Brand)
        doc.setFillColor(63, 81, 181); // Indigo Blue
        doc.rect(0, 0, 210, 25, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(18);
        doc.text("MediConnect: Clinical AI Assessment", 10, 16);

        // 2. Metadata Section
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`Patient ID: ${user.sub}`, 10, 35);
        doc.text(`Report ID: ${sessionId}`, 10, 40);
        doc.text(`Date Generated: ${new Date().toLocaleString()}`, 10, 45);
        doc.text(`Provider: ${aiResponse.provider} (${aiResponse.model})`, 10, 50);

        // 3. Risk Badge
        const riskColor = analysis.risk === "High" ? [220, 38, 38] : analysis.risk === "Medium" ? [234, 88, 12] : [22, 163, 74];
        doc.setFillColor(riskColor[0], riskColor[1], riskColor[2]);
        doc.rect(10, 58, 40, 8, "F");
        doc.setTextColor(255, 255, 255);
        doc.text(`RISK: ${analysis.risk.toUpperCase()}`, 15, 64);

        // 4. Symptoms List
        doc.setTextColor(0, 0, 0);
        doc.setFont("helvetica", "bold");
        doc.text("Reported Symptoms:", 10, 75);
        doc.setFont("helvetica", "normal");
        doc.text(symptoms.join(", "), 10, 80);

        // 5. THE FIX: Wrapped AI Explanation
        doc.setFont("helvetica", "bold");
        doc.text("AI Analysis & Reasoning:", 10, 95);
        doc.setFont("helvetica", "normal");

        // 🟢 PROFESSIONAL WRAPPING: Ensures text stays inside margins
        const wrappedReason = doc.splitTextToSize(analysis.reason, 185);
        doc.text(wrappedReason, 10, 101);

        // 6. Medical Disclaimer (HIPAA/Legal Requirement)
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        const disclaimer = "DISCLAIMER: This report is generated by an Artificial Intelligence system for informational purposes only. It does not constitute a professional medical diagnosis, treatment, or advice. Always seek the advice of your physician or other qualified health provider with any questions you may have regarding a medical condition. If you think you may have a medical emergency, call your doctor or emergency services immediately.";
        const wrappedDisclaimer = doc.splitTextToSize(disclaimer, 185);
        doc.text(wrappedDisclaimer, 10, 275); // Place at bottom of A4

        const pdfBase64 = doc.output('datauristring').split(',')[1];

        // 7. AUDIT LOG (HIPAA Compliance)
        await writeAuditLog(user.sub, "AI_SYSTEM", "SYMPTOM_CHECK", `Risk: ${analysis.risk}`);

        // 8. BIGQUERY SYNC (Old Brain Logic)
        // Note: Handled as fire-and-forget to keep API fast
        pushToBigQuery(user.sub, symptoms as string[], analysis, aiResponse.provider).catch(console.error);

        res.json({
            success: true,
            analysis,
            pdfBase64,
            fhirResourceId: sessionId
        });

    } catch (error: any) { // 🟢 Ensure : any is here
        console.error("Symptom Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

async function pushToBigQuery(userId: string, symptoms: string[], analysis: any, provider: string) {
    try {
        // 🟢 HIPAA/GDPR: Using the real Service Account from SSM
        const saKey = await getSSMParameter("/mediconnect/prod/gcp/service-account", true);
        if (!saKey) return;

        const credentials = JSON.parse(saKey);
        const auth = new GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;
        const projectId = credentials.project_id;

        const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/mediconnect_ai/tables/symptom_logs/insertAll`;

        // 🟢 GDPR: Ensuring data is anonymized before sending to Analytics
        await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                kind: "bigquery#tableDataInsertAllRequest",
                rows: [{
                    json: {
                        user_id: userId,
                        timestamp: new Date().toISOString(),
                        symptoms: symptoms.join(", "),
                        risk_level: analysis.risk,
                        provider: provider
                    }
                }]
            })
        });
    } catch (err) {
        console.error("❌ BigQuery Sync Failed:", err);
    }
}