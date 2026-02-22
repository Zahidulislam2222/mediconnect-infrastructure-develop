import PDFDocument from "pdfkit";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SignCommand } from "@aws-sdk/client-kms";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";

import { 
    getRegionalS3Client, 
    getRegionalKMSClient, 
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
    // 🟢 GDPR FIX: Now accepts 'region' to ensure data residency compliance.
    public async generatePrescriptionPDF(data: PrescriptionData, region: string = "us-east-1"): 
        Promise<{ pdfUrl: string, signature: string, fhirMetadata: any }> {
        
        const signature = await this.signData(data, region);
        const pdfBuffer = await this.createPDFBuffer(data, signature);

        const s3Client = getRegionalS3Client(region);
        const isEU = region.toUpperCase() === 'EU' || region === 'eu-central-1';
        const bucketName = isEU 
            ? (process.env.S3_BUCKET_PRESCRIPTIONS_EU || "mediconnect-prescriptions-eu")
            : (process.env.S3_BUCKET_PRESCRIPTIONS_US || "mediconnect-prescriptions");

        const s3Key = `prescriptions/${data.prescriptionId}.pdf`;
        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: s3Key,
            Body: pdfBuffer,
            ContentType: "application/pdf",
            ServerSideEncryption: "aws:kms" 
        }));

        const signedUrl = await getSignedUrl(s3Client, new GetObjectCommand({
            Bucket: bucketName, Key: s3Key
        }), { expiresIn: 900 });

        const fhirMetadata = {
            resourceType: "DocumentReference",
            id: uuidv4(),
            status: "current",
            type: { text: "Digital Prescription" },
            subject: { display: data.patientName },
            author: [{ display: data.doctorName }],
            date: data.timestamp,
            content: [{
                attachment: { contentType: "application/pdf", url: s3Key, hash: signature }
            }]
        };

        return { pdfUrl: signedUrl, signature, fhirMetadata };
    }

    private async signData(data: PrescriptionData, region: string): Promise<string> {
        const parameterPath = "/mediconnect/prod/kms/signing_key_id";
        // 🟢 FIX: Ensure we explicitly pass `true` for decryption of the secure KMS key ID
        const kmsKeyId = await getSSMParameter(parameterPath, region, true); 
        
        if (!kmsKeyId) {
            throw new Error(`CRITICAL: KMS Key ID not found in Parameter Store for region: ${region}`);
        }

        const kmsClient = getRegionalKMSClient(region);
        const payload = JSON.stringify(data);
        
        const command = new SignCommand({
            KeyId: kmsKeyId, 
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