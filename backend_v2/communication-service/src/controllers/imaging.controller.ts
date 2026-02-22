import { Request, Response } from "express";
import { AICircuitBreaker } from "../utils/ai-circuit-breaker";
import { getRegionalDB } from "../utils/db-adapter";
import { getSSMParameter } from "../config/aws";
import { scrubPII, mapToFHIRImagingReport } from "../utils/fhir-mapper";
import { writeAuditLog } from "../../../shared/audit";
import { v4 as uuidv4 } from "uuid";
import { jsPDF } from "jspdf";

const aiService = new AICircuitBreaker();

// 🟢 GDPR FIX: Extract region for Azure Cosmos DB routing
const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

export const analyzeClinicalImage = async (req: Request, res: Response) => {
    const doctor = (req as any).user;
    const { imageBase64, prompt, patientId } = req.body;
    const reportId = uuidv4();
    const userRegion = extractRegion(req);

    const isAuthorized = doctor.role === 'practitioner' || doctor.role === 'doctor' || doctor.role === 'patient';

    if (!isAuthorized) {
        await writeAuditLog(doctor.sub, patientId || "UNKNOWN", "UNAUTHORIZED_AI_ACCESS", "Blocked AI Vision access", { region: userRegion, ipAddress: req.ip });
        return res.status(403).json({ error: "Unauthorized: Clinical Vision tools restricted." });
    }

    if (!imageBase64 || !patientId) return res.status(400).json({ error: "Missing image or patient ID." });

    try {
        const cleanPrompt = scrubPII(prompt || "Perform a detailed clinical analysis of this imaging scan. Identify anomalies.");

        // CIRCUIT BREAKER (Vision Mode)
        const aiResponse = await aiService.generateVisionResponse(cleanPrompt, imageBase64, userRegion);
        const analysisText = aiResponse.text;

        // FHIR R4 MAPPING
        const fhirReport = mapToFHIRImagingReport(patientId, doctor.sub, analysisText, aiResponse.provider);

        // MULTI-PAGE PDF GENERATION
        const doc = new jsPDF();
        let cursorY = 72;
        const pageHeight = doc.internal.pageSize.getHeight();
        const cleanText = analysisText.replace(/\*\*/g, '');

        const drawHeader = (pdfDoc: any) => {
            pdfDoc.setFillColor(30, 58, 138);
            pdfDoc.rect(0, 0, 210, 25, "F");
            pdfDoc.setTextColor(255, 255, 255);
            pdfDoc.setFontSize(18);
            pdfDoc.text("MediConnect: Radiology AI Analysis", 10, 16);
            pdfDoc.setTextColor(0, 0, 0);
        };

        drawHeader(doc);

        doc.setFontSize(10);
        doc.text(`Patient ID: ${patientId}`, 10, 35);
        doc.text(`Report ID: ${reportId}`, 10, 40);
        doc.text(`Date Generated: ${new Date().toLocaleString()}`, 10, 45);
        doc.text(`AI Provider: ${aiResponse.provider}`, 10, 50);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("Clinical Findings & Conclusion:", 10, 65);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        const wrappedLines = doc.splitTextToSize(cleanText, 180);

        wrappedLines.forEach((line: string) => {
            if (cursorY > pageHeight - 30) {
                doc.addPage();
                drawHeader(doc);
                cursorY = 35; 
            }
            doc.text(line, 15, cursorY);
            cursorY += 6; 
        });

        const disclaimer = "CONFIDENTIAL: This AI-generated report is for clinical decision support only and must be reviewed by a certified healthcare professional.";
        const wrappedDisclaimer = doc.splitTextToSize(disclaimer, 180);
        if (cursorY > pageHeight - 20) doc.addPage();
        doc.setTextColor(150, 150, 150);
        doc.text(wrappedDisclaimer, 10, pageHeight - 15);

        const pdfBase64 = doc.output('datauristring').split(',')[1];

        // 🟢 Switches between Azure (US) and Firestore (EU) automatically
        try {
            const db = getRegionalDB(userRegion);
            await db.save("imaging-analysis", {
                id: reportId,
                patientId,
                doctorId: doctor.sub,
                provider: aiResponse.provider,
                model: aiResponse.model,
                resource: fhirReport,
                timestamp: new Date().toISOString()
            });
        } catch (dbErr: any) {
            console.error(`📢 Database Save Failed [${userRegion}]:`, dbErr.message);
        }

        // 🟢 HIPAA AUDIT LOG FIX: Added correct Patient ID, Region, and IP
        await writeAuditLog(doctor.sub, patientId, "IMAGE_ANALYSIS", `Analyzed clinical scan`, { region: userRegion, ipAddress: req.ip });

        res.json({
            success: true, reportId, analysis: analysisText,
            pdfBase64, provider: aiResponse.provider, fhirResource: fhirReport
        });

    } catch (error: any) {
        console.error("Imaging AI Error:", error);
        res.status(500).json({ error: "Image analysis failed", details: error.message });
    }
};