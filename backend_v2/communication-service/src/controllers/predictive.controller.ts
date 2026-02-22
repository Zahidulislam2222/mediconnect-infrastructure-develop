import { Request, Response } from "express";
import { AICircuitBreaker } from "../utils/ai-circuit-breaker";
import { getRegionalDB } from "../utils/db-adapter";
import { getSSMParameter } from "../config/aws"; 
import { writeAuditLog } from "../../../shared/audit";
import { v4 as uuidv4 } from "uuid";
import axios from 'axios';

const aiService = new AICircuitBreaker();

const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

export const predictRisk = async (req: Request, res: Response) => {
    const doctor = (req as any).user;
    const { patientId, vitals, modelType } = req.body;
    const predictionId = uuidv4();
    const userRegion = extractRegion(req);

    const isDoctor = doctor.role === 'practitioner' || doctor.role === 'doctor' || doctor['cognito:groups']?.includes('doctor');
    
    if (!isDoctor) {
        await writeAuditLog(doctor.sub, patientId, "UNAUTHORIZED_AI_ACCESS", "Blocked non-doctor prediction attempt", { region: userRegion, ipAddress: req.ip });
        return res.status(403).json({ error: "Access Denied: Practitioner role required." });
    }

    try {
        const clinicalContext = `Model Type: ${modelType} | Vitals: Temp: ${vitals.temperature}°F, HR: ${vitals.heartRate} BPM, BP: ${vitals.systolicBP}/${vitals.diastolicBP}, RR: ${vitals.respRate}, Age: ${vitals.age}`;

        const prompt = `Act as a clinical data scientist. Analyze these vitals: ${clinicalContext}. Provide a Risk Assessment following this EXACT JSON format: {"riskScore": number (0-100), "riskLevel": "Low" | "Medium" | "High", "clinicalJustification": "string", "recommendedIntervention": "string"}. Return ONLY JSON. No markdown.`;

        const aiResponse = await aiService.generateResponse(prompt, [], userRegion);
        const cleanJson = aiResponse.text.replace(/```json/g, "").replace(/```/g, "").trim();
        const analysis = JSON.parse(cleanJson);

        const fhirRiskAssessment = {
            resourceType: "RiskAssessment",
            id: predictionId, status: "final",
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

        try {
            const db = getRegionalDB(userRegion);
            await db.save("predictive-analysis", {
                id: predictionId, 
                patientId, 
                doctorId: doctor.sub,
                modelType, 
                vitals, 
                analysis, 
                resource: fhirRiskAssessment,
                provider: aiResponse.provider, 
                timestamp: new Date().toISOString()
            });
        } catch (dbError: any) { 
            console.error(`📢 Database Save Failed [${userRegion}]:`, dbError.message); 
        }

        await writeAuditLog(doctor.sub, patientId, "CLINICAL_AI_PREDICTION", `Model: ${modelType}`, { region: userRegion, ipAddress: req.ip });

        res.json({ success: true, predictionId, analysis, fhirResource: fhirRiskAssessment, provider: aiResponse.provider });

    } catch (error: any) {
        console.error("Predictive Error:", error);
        res.status(500).json({ error: "Predictive analysis failed", details: error.message });
    }
};

export const summarizeConsultation = async (req: Request, res: Response) => {
    const { transcript, patientId } = req.body;
    const doctor = (req as any).user;
    const userRegion = extractRegion(req);

    if (!transcript || transcript.length < 20) return res.status(400).json({ error: "Transcript too short to summarize." });

    try {
        const prompt = `Act as a medical scribe. Convert this transcript into a clinical SOAP Note: ${transcript.substring(0, 3000)}`; 
        const aiResponse = await aiService.generateResponse(prompt, [], userRegion);
        const soapNote = aiResponse.text;

        // 🟢 SECURITY/STABILITY FIX: Fail gracefully if Doctor Service is down
        if (process.env.DOCTOR_SERVICE_URL) {
            try {
                await axios.post(`${process.env.DOCTOR_SERVICE_URL}/ehr`, {
                    action: "add_clinical_note", patientId: patientId,
                    note: soapNote, title: `AI Scribe Summary - ${new Date().toLocaleDateString()}`
                }, {
                    headers: { 
                        Authorization: req.headers.authorization,
                        'x-user-region': userRegion 
                    },
                    timeout: 5000 // 🟢 Prevent indefinite hanging
                });
            } catch (axiosError) {
                console.warn("⚠️ EHR Sync Failed, but Summary Generated.");
            }
        }

        await writeAuditLog(doctor.sub, patientId, "AI_SCRIBE_SUMMARY", "Generated SOAP Note", { region: userRegion, ipAddress: req.ip });

        res.json({ success: true, summary: soapNote });
    } catch (error: any) {
        console.error("Summarization Error:", error);
        res.status(500).json({ error: "Failed to generate summary" });
    }
};