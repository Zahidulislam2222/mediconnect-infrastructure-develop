import { Request, Response } from "express";
import { AICircuitBreaker } from "../utils/ai-circuit-breaker";
import { CosmosClient } from "@azure/cosmos";
import { getSSMParameter } from "../config/aws";
import { scrubPII } from "../utils/fhir-mapper";
import { writeAuditLog } from "../../../shared/audit";
import { v4 as uuidv4 } from "uuid";
import axios from 'axios';

const aiService = new AICircuitBreaker();

// --- ARCHITECTURE 2: AZURE COSMOS DB (Serverless Scale-to-Zero) ---
let cosmosContainer: any = null;
const getCosmosContainer = async () => {
    if (cosmosContainer) return cosmosContainer;
    const endpoint = await getSSMParameter("/mediconnect/prod/azure/cosmos/endpoint");
    const key = await getSSMParameter("/mediconnect/prod/azure/cosmos/primary_key", true);

    if (!endpoint || !key) throw new Error("Cosmos Config Missing");

    const client = new CosmosClient({ endpoint, key });
    // Note: Ensuring we use the verified database name from your portal
    const database = client.database("mediconnect-db");
    cosmosContainer = database.container("predictive-analysis");
    return cosmosContainer;
};

/**
 * AI Risk Analysis Controller (Sepsis, Readmission, No-Show)
 * Compliance: FHIR R4 RiskAssessment, HIPAA Audit, GDPR Privacy
 */
export const predictRisk = async (req: Request, res: Response) => {
    const doctor = (req as any).user;
    const { patientId, vitals, modelType } = req.body;
    const predictionId = uuidv4();

    // 1. SECURITY: Ensure only Practitioners (Doctors) can run predictive models
    const isDoctor = doctor.role === 'practitioner' || doctor.role === 'doctor';
    const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

    if (!isDoctor && !isDev) {
        return res.status(403).json({ error: "Access Denied: Practitioner role required for clinical prediction." });
    }

    try {
        // 2. DATA PREP: Structured Vitals for the AI Prompt
        const clinicalContext = `
            Model Type: ${modelType} (Sepsis Risk | Readmission | No-Show)
            Patient Vitals:
            - Temp: ${vitals.temperature}°F
            - Heart Rate: ${vitals.heartRate} BPM
            - Blood Pressure: ${vitals.systolicBP}/${vitals.diastolicBP}
            - Respiratory Rate: ${vitals.respRate}
            - Age: ${vitals.age}
        `;

        const prompt = `
            Act as a clinical data scientist. Analyze these vitals: ${clinicalContext}.
            Provide a Risk Assessment following this EXACT JSON format:
            {
                "riskScore": number (0-100),
                "riskLevel": "Low" | "Medium" | "High",
                "clinicalJustification": "string",
                "recommendedIntervention": "string"
            }
            Return ONLY JSON. No markdown.
        `;

        // 3. CIRCUIT BREAKER (Azure GPT-5-mini Primary -> Fallbacks)
        const aiResponse = await aiService.generateResponse(prompt, []);

        // Clean markdown and parse
        const cleanJson = aiResponse.text.replace(/```json/g, "").replace(/```/g, "").trim();
        const analysis = JSON.parse(cleanJson);

        // 4. FHIR R4 MAPPING (RiskAssessment Resource)
        const fhirRiskAssessment = {
            resourceType: "RiskAssessment",
            id: predictionId,
            status: "final",
            subject: { reference: `Patient/${patientId}` },
            performer: { reference: `Practitioner/${doctor.sub}` },
            occurrenceDateTime: new Date().toISOString(),
            prediction: [{
                probabilityDecimal: analysis.riskScore / 100,
                qualitativeRisk: { text: analysis.riskLevel },
                rationale: analysis.clinicalJustification
            }],
            note: [{ text: analysis.recommendedIntervention }]
        };

        // 5. ARCHITECTURE 2 STORAGE (Cosmos DB)
        try {
            const container = await getCosmosContainer();
            await container.items.create({
                id: predictionId,
                patientId,
                doctorId: doctor.sub,
                modelType,
                vitals: vitals, // Numeric data only (HIPAA safe)
                analysis,
                resource: fhirRiskAssessment,
                provider: aiResponse.provider,
                timestamp: new Date().toISOString()
            });
        } catch (dbError: any) {
            console.error("📢 Database save failed, but proceeding with result:", dbError.message);
        }

        // 6. HIPAA AUDIT LOG
        await writeAuditLog(doctor.sub, "CLINICAL_AI", "PREDICTIVE_ANALYSIS", `Model: ${modelType}, Patient: ${patientId}`);

        // 7. RESPONSE
        res.json({
            success: true,
            predictionId,
            analysis,
            fhirResource: fhirRiskAssessment,
            provider: aiResponse.provider
        });

    } catch (error: any) {
        console.error("Predictive Error:", error);
        res.status(500).json({ error: "Predictive analysis failed", details: error.message });
    }
};

export const summarizeConsultation = async (req: Request, res: Response) => {
    const { transcript, appointmentId, patientId } = req.body;
    const doctor = (req as any).user;

    if (!transcript || transcript.length < 20) {
        return res.status(400).json({ error: "Transcript too short to summarize." });
    }

    try {
        const prompt = `
            Act as a medical scribe. Convert this doctor-patient transcript into a professional 
            SOAP Note (Subjective, Objective, Assessment, Plan).
            
            Transcript:
            ${transcript}

            Return only the SOAP note text. Be concise and professional. 
            Do not include names, only 'Patient' and 'Doctor'.
        `;

        const aiResponse = await aiService.generateResponse(prompt, []);
        const soapNote = aiResponse.text;

        // 🟢 SAVE TO EHR (Doctor Service)
        // Note: Communication service calls Doctor service internally
        await axios.post(`${process.env.DOCTOR_SERVICE_URL}/ehr`, {
            action: "add_clinical_note",
            patientId: patientId,
            note: soapNote,
            title: `AI Scribe Summary - ${new Date().toLocaleDateString()}`
        }, {
            headers: { Authorization: req.headers.authorization }
        });

        res.json({ success: true, summary: soapNote });
    } catch (error: any) {
        console.error("Summarization Error:", error);
        res.status(500).json({ error: "Failed to generate summary" });
    }
};