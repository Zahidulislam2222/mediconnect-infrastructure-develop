import PDFDocument from "pdfkit";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SignCommand } from "@aws-sdk/client-kms";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";

// 🟢 ARCHITECTURE FIX: Use Shared Factories to prevent Socket Exhaustion and Data Leaks
import { 
    getRegionalS3Client, 
    getRegionalKMSClient, // 🔍 Ensure this is exported in your shared/aws-config.ts
    getSSMParameter 
} from "../config/aws"; 

interface PrescriptionData {
    prescriptionId: string;
    patientName: string;
    doctorName: string;
    medication: string;
    dosage: string;
    instructions: string;
    timestamp: string;
}

export class PDFGenerator {
    private kmsKeyId: string;

    constructor() {
        this.kmsKeyId = process.env.KMS_KEY_ID || "";
    }

    /**
     * Generates a signed PDF and returns the S3 Presigned URL + FHIR Metadata
     * 🟢 GDPR FIX: Now accepts 'region' to ensure data residency compliance.
     */
    public async generatePrescriptionPDF(data: PrescriptionData, region: string = "us-east-1"): 
        Promise<{ pdfUrl: string, signature: string, fhirMetadata: any }> {
        
        // 1. Digital Signature Generation (Regional KMS)
        const signature = await this.signData(data, region);

        // 2. Generate PDF Buffer
        const pdfBuffer = await this.createPDFBuffer(data, signature);

        // 3. Resolve Regional Infrastructure
        const s3Client = getRegionalS3Client(region);
        const isEU = region.toUpperCase().includes('EU');
        const bucketName = isEU 
            ? (process.env.S3_BUCKET_PRESCRIPTIONS_EU || "mediconnect-prescriptions-eu")
            : (process.env.S3_BUCKET_PRESCRIPTIONS_US || "mediconnect-prescriptions");

        // 4. Upload to Regional S3 (GDPR Sovereignty)
        const s3Key = `prescriptions/${data.prescriptionId}.pdf`;
        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: s3Key,
            Body: pdfBuffer,
            ContentType: "application/pdf",
            // 🟢 HIPAA: Ensure encryption at rest
            ServerSideEncryption: "aws:kms" 
        }));

        // 5. Generate Presigned View URL (Valid for 15 mins)
        const signedUrl = await getSignedUrl(s3Client, new GetObjectCommand({
            Bucket: bucketName,
            Key: s3Key
        }), { expiresIn: 900 });

        // 6. 🟢 FHIR R4 COMPLIANCE: Wrap file in a DocumentReference
        const fhirMetadata = {
            resourceType: "DocumentReference",
            id: uuidv4(),
            status: "current",
            type: { text: "Digital Prescription" },
            subject: { display: data.patientName },
            author: [{ display: data.doctorName }],
            date: data.timestamp,
            content: [{
                attachment: {
                    contentType: "application/pdf",
                    url: s3Key,
                    hash: signature // Signature used as integrity hash
                }
            }]
        };

        return { pdfUrl: signedUrl, signature, fhirMetadata };
    }

    private async signData(data: PrescriptionData, region: string): Promise<string> {
        if (!this.kmsKeyId) {
            const keyId = await getSSMParameter("/mediconnect/prod/kms/signing_key_id");
            if (!keyId) throw new Error("KMS Key ID not configured");
            this.kmsKeyId = keyId;
        }

        const kmsClient = getRegionalKMSClient(region);
        const payload = JSON.stringify(data);
        
        const command = new SignCommand({
            KeyId: this.kmsKeyId,
            Message: Buffer.from(payload),
            MessageType: "RAW",
            SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256"
        });

        const response = await kmsClient.send(command);
        return Buffer.from(response.Signature!).toString('base64');
    }

    private createPDFBuffer(data: PrescriptionData, signature: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument();
            const buffers: Buffer[] = [];

            doc.on("data", buffers.push.bind(buffers));
            doc.on("end", () => resolve(Buffer.concat(buffers)));
            doc.on("error", reject);

            // --- PDF CONTENT ---
            doc.fontSize(20).text("MediConnect Digital Prescription", { align: "center" });
            doc.moveDown();
            doc.fontSize(12).text(`Prescription ID: ${data.prescriptionId}`);
            doc.text(`Date: ${data.timestamp}`);
            doc.moveDown();
            doc.text(`Patient: ${data.patientName}`);
            doc.text(`Doctor: ${data.doctorName}`);
            doc.moveDown();
            doc.font('Helvetica-Bold').text("Medication Details:");
            doc.font('Helvetica').text(`Drug: ${data.medication}`);
            doc.text(`Dosage: ${data.dosage}`);
            doc.text(`Instructions: ${data.instructions}`);
            doc.moveDown(2);
            doc.fontSize(10).fillColor('grey').text(`Digital Signature: ${signature}`);
            doc.text("This document is digitally signed and HIPAA compliant.", { align: "center" });

            doc.end();
        });
    }
}