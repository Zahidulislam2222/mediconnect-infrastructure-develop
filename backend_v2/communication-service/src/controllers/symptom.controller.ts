import { Request, Response } from "express";
import { ComprehendMedicalClient, DetectEntitiesV2Command } from "@aws-sdk/client-comprehendmedical";
import { AICircuitBreaker } from "../utils/ai-circuit-breaker";
import { getRegionalDB } from "../utils/db-adapter";
import { getSSMParameter } from "../config/aws";
import { mapToFHIRDiagnosticReport, scrubPII } from "../utils/fhir-mapper";
import { writeAuditLog } from "../../../shared/audit";
import { jsPDF } from "jspdf";
import { v4 as uuidv4 } from "uuid";
import { GoogleAuth } from "google-auth-library";

const aiService = new AICircuitBreaker();

// 🟢 GDPR FIX: Extract Region Helper
const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

// --- HELPER: CLEAN JSON ---
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
    } catch (e: any) { return null; }
}

export const checkSymptoms = async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { text } = req.body;
    const sessionId = uuidv4();
    const userRegion = extractRegion(req);

    try {
        // 1. HIPAA: Scrub PII before any processing
        const cleanText = scrubPII(text);

        // 2. GATEKEEPER (Region-Aware AWS Comprehend)
        // 🟢 GDPR FIX: Ensure NLP processing happens in the correct jurisdiction
        // Note: Use 'eu-west-1' (Ireland) if 'eu-central-1' lacks Medical service, ensuring it stays in EU.
        const targetAwsRegion = userRegion.toUpperCase() === 'EU' ? 'eu-west-1' : 'us-east-1';
        const regionalComprehend = new ComprehendMedicalClient({ region: targetAwsRegion });

        const compRes = await regionalComprehend.send(new DetectEntitiesV2Command({ Text: cleanText }));
        const symptoms = compRes.Entities?.filter(e =>
            (e.Category as string) === "MEDICAL_CONDITION" || (e.Category as string) === "SYMPTOM"
        ).map(e => e.Text) || [];

        if (symptoms.length === 0) {
            return res.status(400).json({ error: "No medical symptoms detected." });
        }

        // 3. AI CIRCUIT BREAKER (Azure -> Bedrock -> Vertex)
        const prompt = `Analyze these symptoms: ${symptoms.join(", ")}. Determine risk: High, Medium, or Low. Return ONLY JSON: {"risk": "High|Medium|Low", "reason": "Short explanation"}`;
        const aiResponse = await aiService.generateResponse(prompt, [], userRegion);
        const analysis = cleanAndParseJSON(aiResponse.text) || { risk: "Medium", reason: "Analysis partial." };

        // 4. FHIR R4 MAPPING
        const fhirReport = mapToFHIRDiagnosticReport(user.sub, symptoms as string[], analysis, aiResponse.provider);

        // 5. ARCHITECTURE 2 STORAGE
        // 🟢 POLYGLOT SAVE: Azure Cosmos (US) or Google Firestore (EU)
        try {
            const db = getRegionalDB(userRegion);
            await db.save("symptom-checks", {
                id: sessionId,
                patientId: user.sub,
                timestamp: new Date().toISOString(),
                resource: fhirReport,
                provider: aiResponse.provider,
                region: userRegion
            });
        } catch (dbError: any) {
            console.error(`📢 Database Save Failed [${userRegion}]:`, dbError.message);
        }

        // --- 6. PROFESSIONAL CLINICAL PDF GENERATION ---
        const doc = new jsPDF();
        
        doc.setFillColor(63, 81, 181);
        doc.rect(0, 0, 210, 25, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(18);
        doc.text("MediConnect: Clinical AI Assessment", 10, 16);

        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`Patient ID: ${user.sub}`, 10, 35);
        doc.text(`Report ID: ${sessionId}`, 10, 40);
        doc.text(`Date Generated: ${new Date().toLocaleString()}`, 10, 45);
        doc.text(`Provider: ${aiResponse.provider}`, 10, 50);

        const riskColor = analysis.risk === "High" ? [220, 38, 38] : analysis.risk === "Medium" ? [234, 88, 12] : [22, 163, 74];
        doc.setFillColor(riskColor[0], riskColor[1], riskColor[2]);
        doc.rect(10, 58, 40, 8, "F");
        doc.setTextColor(255, 255, 255);
        doc.text(`RISK: ${analysis.risk.toUpperCase()}`, 15, 64);

        doc.setTextColor(0, 0, 0);
        doc.setFont("helvetica", "bold");
        doc.text("Reported Symptoms:", 10, 75);
        doc.setFont("helvetica", "normal");
        doc.text(symptoms.join(", "), 10, 80);

        doc.setFont("helvetica", "bold");
        doc.text("AI Analysis & Reasoning:", 10, 95);
        doc.setFont("helvetica", "normal");

        const wrappedReason = doc.splitTextToSize(analysis.reason, 185);
        doc.text(wrappedReason, 10, 101);

        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        const disclaimer = "DISCLAIMER: This report is generated by an Artificial Intelligence system for informational purposes only. It does not constitute a professional medical diagnosis.";
        const wrappedDisclaimer = doc.splitTextToSize(disclaimer, 185);
        doc.text(wrappedDisclaimer, 10, 275);

        const pdfBase64 = doc.output('datauristring').split(',')[1];

        // 7. AUDIT LOG (HIPAA Compliance)
        // 🟢 HIPAA FIX: Include IP and Region
        await writeAuditLog(user.sub, "AI_SYSTEM", "SYMPTOM_CHECK", `Risk: ${analysis.risk}`, {
            region: userRegion,
            ipAddress: req.ip
        });

        // 8. BIGQUERY SYNC (Async)
        pushToBigQuery(user.sub, symptoms as string[], analysis, aiResponse.provider, userRegion).catch(console.error);

        res.json({
            success: true,
            analysis,
            pdfBase64,
            fhirResourceId: sessionId
        });

    } catch (error: any) {
        console.error("Symptom Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

async function pushToBigQuery(userId: string, symptoms: string[], analysis: any, provider: string, region: string) {
    try {
        // 🟢 GDPR FIX: Use Region to fetch the correct Service Account Key from Vault
        const saKey = await getSSMParameter("/mediconnect/prod/gcp/service-account", region, true);
        if (!saKey) return;

        const credentials = JSON.parse(saKey);
        const auth = new GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;
        const projectId = credentials.project_id;

        const datasetName = region.toUpperCase() === 'EU' ? 'mediconnect_ai_eu' : 'mediconnect_ai';
const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${datasetName}/tables/symptom_logs/insertAll`;

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
                        provider: provider,
                        region: region // 🟢 LOGGING REGION
                    }
                }]
            })
        });
    } catch (err) {
        console.error("❌ BigQuery Sync Failed:", err);
    }
}