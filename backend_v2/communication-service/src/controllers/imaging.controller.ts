import { Request, Response } from "express";
import { AICircuitBreaker } from "../utils/ai-circuit-breaker";
import { CosmosClient } from "@azure/cosmos";
import { getSSMParameter } from "../config/aws";
import { scrubPII, mapToFHIRImagingReport } from "../utils/fhir-mapper";
import { writeAuditLog } from "../../../shared/audit";
import { v4 as uuidv4 } from "uuid";
import { jsPDF } from "jspdf"; // 🟢 ADDED IMPORT

const aiService = new AICircuitBreaker();

// --- ARCHITECTURE 2: COSMOS DB ---
let cosmosContainer: any = null;
const getCosmosContainer = async () => {
    if (cosmosContainer) return cosmosContainer;
    const endpoint = await getSSMParameter("/mediconnect/prod/azure/cosmos/endpoint");
    const key = await getSSMParameter("/mediconnect/prod/azure/cosmos/primary_key", true);
    const client = new CosmosClient({ endpoint: endpoint!, key: key! });
    cosmosContainer = client.database("mediconnect-db").container("imaging-analysis");
    return cosmosContainer;
};

export const analyzeClinicalImage = async (req: Request, res: Response) => {
    const doctor = (req as any).user;
    const { imageBase64, prompt, patientId } = req.body;
    const reportId = uuidv4();

    const isAuthorized = doctor.role === 'practitioner' ||
        doctor.role === 'doctor' ||
        doctor.role === 'patient' ||
        process.env.NODE_ENV === 'development';

    if (!isAuthorized) {
        return res.status(403).json({ error: "Unauthorized: Clinical Vision tools restricted to registered users." });
    }

    if (!imageBase64) return res.status(400).json({ error: "No image data provided." });

    try {
        const cleanPrompt = scrubPII(prompt || "Perform a detailed clinical analysis of this imaging scan. Identify anomalies.");

        // 3. CIRCUIT BREAKER (Vision Mode)
        const aiResponse = await aiService.generateVisionResponse(cleanPrompt, imageBase64);
        const analysisText = aiResponse.text;

        // 4. FHIR R4 MAPPING
        const fhirReport = mapToFHIRImagingReport(patientId, doctor.sub, analysisText, aiResponse.provider);

        // --- 6. MULTI-PAGE PROFESSIONAL RADIOLOGY PDF ---
        const doc = new jsPDF();
        let cursorY = 72; // Starting position for text
        const margin = 15;
        const pageHeight = doc.internal.pageSize.getHeight();

        // A. Helper: Strip Markdown Stars (Professionalism)
        const cleanText = analysisText.replace(/\*\*/g, '');

        // B. Header Bar (Every clinical report needs this)
        const drawHeader = (pdfDoc: any) => {
            pdfDoc.setFillColor(30, 58, 138);
            pdfDoc.rect(0, 0, 210, 25, "F");
            pdfDoc.setTextColor(255, 255, 255);
            pdfDoc.setFontSize(18);
            pdfDoc.text("MediConnect: Radiology AI Analysis", 10, 16);
            pdfDoc.setTextColor(0, 0, 0);
        };

        drawHeader(doc);

        // C. Metadata Section
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`Patient ID: ${patientId}`, 10, 35);
        doc.text(`Report ID: ${reportId}`, 10, 40);
        doc.text(`Date Generated: ${new Date().toLocaleString()}`, 10, 45);
        doc.text(`AI Provider: ${aiResponse.provider} (${aiResponse.model})`, 10, 50);

        // D. Findings Title
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("Clinical Findings & Conclusion:", 10, 65);

        // E. 🟢 THE FIX: Smart Pagination & Wrapping
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        const wrappedLines = doc.splitTextToSize(cleanText, 180);

        wrappedLines.forEach((line: string) => {
            // Check if we need a new page (Page height is ~297mm)
            if (cursorY > pageHeight - 30) {
                doc.addPage();
                drawHeader(doc);
                cursorY = 35; // Reset Y on new page
            }
            doc.text(line, margin, cursorY);
            cursorY += 6; // Line spacing
        });

        // F. Footer Disclaimer (On Last Page)
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        const disclaimer = "CONFIDENTIAL: This AI-generated report is for clinical decision support only and must be reviewed by a certified healthcare professional. This is not a final diagnosis or treatment plan.";
        const wrappedDisclaimer = doc.splitTextToSize(disclaimer, 180);

        // Ensure disclaimer doesn't overlap
        if (cursorY > pageHeight - 20) doc.addPage();
        doc.text(wrappedDisclaimer, 10, pageHeight - 15);

        const pdfBase64 = doc.output('datauristring').split(',')[1];

        // 5. ARCHITECTURE 2 STORAGE (Async Save)
        try {
            const container = await getCosmosContainer();
            await container.items.create({
                id: reportId,
                patientId,
                doctorId: doctor.sub,
                provider: aiResponse.provider,
                model: aiResponse.model,
                resource: fhirReport,
                timestamp: new Date().toISOString()
            });
        } catch (dbErr: any) {
            console.error("📢 Cosmos Save Failed (Imaging):", dbErr.message);
        }

        // 6. HIPAA AUDIT LOGGING
        await writeAuditLog(doctor.sub, "CLINICAL_AI", "IMAGE_ANALYSIS", `Analyzed scan for Patient: ${patientId}`);

        // 7. RESPONSE (Now including the PDF)
        res.json({
            success: true,
            reportId,
            analysis: analysisText,
            pdfBase64: pdfBase64, // 🟢 NOW SENDING TO FRONTEND
            provider: aiResponse.provider,
            fhirResource: fhirReport
        });

    } catch (error: any) {
        console.error("Imaging AI Error:", error);
        res.status(500).json({ error: "Image analysis failed", details: error.message });
    }
};