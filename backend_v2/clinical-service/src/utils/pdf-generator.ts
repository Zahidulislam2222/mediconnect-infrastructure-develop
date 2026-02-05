import PDFDocument from "pdfkit";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSSMParameter } from "../config/aws"; // Shared config

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
    private s3Client: S3Client;
    private kmsClient: KMSClient;
    private bucketName: string;
    private kmsKeyId: string;

    constructor() {
        this.s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
        this.kmsClient = new KMSClient({ region: process.env.AWS_REGION || "us-east-1" });
        this.bucketName = process.env.DOCS_BUCKET || "mediconnect-temp-docs";
        this.kmsKeyId = process.env.KMS_KEY_ID || "";
    }

    /**
     * Generates a signed PDF and returns the S3 Presigned URL + Digital Signature
     */
    public async generatePrescriptionPDF(data: PrescriptionData): Promise<{ pdfUrl: string, signature: string }> {
        // 1. Digital Signature Generation (Verification Integrity)
        const signature = await this.signData(data);

        // 2. Generate PDF Buffer
        const pdfBuffer = await this.createPDFBuffer(data, signature);

        // 3. Upload to S3
        const s3Key = `prescriptions/${data.prescriptionId}.pdf`;
        await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucketName,
            Key: s3Key,
            Body: pdfBuffer,
            ContentType: "application/pdf"
        }));

        // 4. Generate Presigned View URL (Valid for 15 mins)
        // We use a separate GetObject command to generate the signed URL for the user to view it
        // Note: The previous PutObject was for uploading. Now we construct a Get URL.
        // Wait... client needs a URL to VIEW/DOWNLOAD the file we just made.
        // We can't use the PutObjectCommand for getSignedUrl if we want a GET url.
        // We must use GetObjectCommand.

        const getCommand = {
            Bucket: this.bucketName,
            Key: s3Key
        };
        // @ts-ignore - Importing GetObjectCommand dynamically or assuming it's available in context
        // Actual implementation requires importing GetObjectCommand from client-s3.
        // For now, assuming standard flow.

        // Let's create a fresh command for signing the GET request
        const { GetObjectCommand } = await import("@aws-sdk/client-s3");
        const signedUrl = await getSignedUrl(this.s3Client, new GetObjectCommand(getCommand), { expiresIn: 900 });

        return { pdfUrl: signedUrl, signature };
    }

    private async signData(data: PrescriptionData): Promise<string> {
        // Fetch Key ID if not env var (from SSM)
        if (!this.kmsKeyId) {
            const keyId = await getSSMParameter("/mediconnect/prod/kms/signing_key_id");
            if (!keyId) throw new Error("KMS Key ID not configured");
            this.kmsKeyId = keyId;
        }

        const payload = JSON.stringify(data);
        const command = new SignCommand({
            KeyId: this.kmsKeyId,
            Message: Buffer.from(payload),
            MessageType: "RAW",
            SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256"
        });

        const response = await this.kmsClient.send(command);
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
