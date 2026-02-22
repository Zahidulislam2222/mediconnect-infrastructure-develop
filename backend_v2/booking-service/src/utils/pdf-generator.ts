import PDFDocument from "pdfkit";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getRegionalS3Client } from "../../../shared/aws-config";// 🟢 ADDED REGIONAL FACTORY

interface ReceiptData {
    appointmentId: string;
    billId: string;
    patientName: string;
    doctorName: string;
    amount: number;
    date: string;
    status: string;
    type: "BOOKING" | "REFUND";
}

export class BookingPDFGenerator {
    // 🟢 GDPR FIX: Pass region dynamically
    public async generateReceipt(data: ReceiptData, region: string = "us-east-1"): Promise<string> {
        const s3Client = getRegionalS3Client(region);
        
        // Ensure EU users use the EU bucket
        const isEU = region.toUpperCase() === 'EU' || region === 'eu-central-1';
        const bucketName = isEU 
            ? (process.env.S3_BUCKET_UPLOADS_EU || "mediconnect-identity-verification-eu")
            : (process.env.S3_BUCKET_UPLOADS || "mediconnect-identity-verification");

        const pdfBuffer = await this.createPDFBuffer(data);
        const s3Key = `receipts/${data.billId}.pdf`;

        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: s3Key,
            Body: pdfBuffer,
            ContentType: "application/pdf",
            ServerSideEncryption: "aws:kms" // 🟢 HIPAA: Added Encryption at rest
        }));

        const command = new GetObjectCommand({ Bucket: bucketName, Key: s3Key });
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

        return signedUrl;
    }

    private createPDFBuffer(data: ReceiptData): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const isRefund = data.type === "REFUND";
            const primaryColor = isRefund ? "#dc2626" : "#2563eb"; 
            const statusColor = isRefund ? "#4b5563" : "#16a34a"; 
            const docTitle = isRefund ? "CREDIT NOTE" : "TAX INVOICE";

            const doc = new PDFDocument({ size: 'A5', margin: 40 });
            const buffers: Buffer[] = [];

            doc.on("data", buffers.push.bind(buffers));
            doc.on("end", () => resolve(Buffer.concat(buffers)));
            doc.on("error", reject);

            doc.fillColor(primaryColor).fontSize(22).text("MediConnect", { align: "left" });
            doc.fillColor("#444444").fontSize(10).text("Telehealth & Clinical Services", { align: "left" });

            doc.y = 40;
            doc.fillColor(primaryColor).fontSize(14).text(docTitle, { align: "right" });
            doc.moveDown(0.2);
            doc.fillColor("#444444").fontSize(9).text(`ID: ${data.billId}`, { align: "right" });

            doc.moveDown(2);
            doc.path('M 40 85 L 380 85').lineWidth(1).stroke(primaryColor);
            doc.moveDown(1);

            const topY = doc.y;
            doc.fillColor("#777777").fontSize(9).text("ISSUED TO:", 40, topY);
            doc.fillColor("#000000").fontSize(11).text(data.patientName, 40, topY + 12);

            doc.fillColor("#777777").fontSize(9).text("DATE:", 280, topY);
            doc.fillColor("#000000").fontSize(11).text(new Date().toLocaleDateString(), 280, topY + 12);

            doc.moveDown(2);

            const tableY = doc.y + 10;
            doc.fillColor("#f3f4f6").rect(40, tableY, 340, 20).fill();
            doc.fillColor("#4b5563").fontSize(9).text("DESCRIPTION", 50, tableY + 6);
            doc.text("AMOUNT", 300, tableY + 6, { align: 'right' });

            const rowY = tableY + 30;
            const description = isRefund
                ? `Refund for Appointment #${data.appointmentId.substring(0, 8)}`
                : `General Consultation - Dr. ${data.doctorName}`;

            doc.fillColor("#000000").fontSize(10).text(description, 50, rowY);

            const displayAmount = isRefund ? `-$${data.amount.toFixed(2)}` : `$${data.amount.toFixed(2)}`;
            doc.fillColor(isRefund ? "#dc2626" : "#000000").text(displayAmount, 300, rowY, { align: 'right' });

            doc.moveDown(4);
            const summaryY = doc.y;
            doc.path(`M 200 ${summaryY} L 380 ${summaryY}`).lineWidth(0.5).stroke("#cccccc");

            doc.moveDown(0.5);
            doc.fillColor("#777777").fontSize(10).text("Total Status:", 200);
            doc.moveUp();
            doc.fillColor(statusColor).fontSize(10).text(data.status.toUpperCase(), 300, doc.y, { align: 'right' });

            doc.moveDown(0.5);
            doc.fillColor("#000000").fontSize(12).font('Helvetica-Bold').text("GRAND TOTAL:", 200);
            doc.moveUp();
            doc.fillColor(primaryColor).text(displayAmount, 300, doc.y, { align: 'right' });

            doc.font('Helvetica');
            doc.fontSize(8).fillColor("#9ca3af").text("This is a digitally generated document and does not require a physical signature.", 40, 520, { align: "center", width: 340 });
            doc.moveDown(0.5);
            doc.text("MediConnect Systems © 2026 | HIPAA Compliant Transaction", { align: "center" });

            doc.end();
        });
    }
}