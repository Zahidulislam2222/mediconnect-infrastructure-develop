import { Request, Response } from "express";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";

const s3Client = new S3Client({ region: "us-east-1" });
const BUCKET_NAME = process.env.EHR_BUCKET || "mediconnect-ehr-records";

export const getUploadUrl = async (req: Request, res: Response) => {
    const { fileName, fileType, patientId } = req.body;

    if (!fileName || !patientId) return res.status(400).json({ error: "Missing fields" });

    const s3Key = `${patientId}/${uuidv4()}-${fileName}`;

    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key,
            ContentType: fileType
        });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

        res.json({ uploadUrl, s3Key });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

export const getViewUrl = async (req: Request, res: Response) => {
    const { s3Key } = req.body;
    if (!s3Key) return res.status(400).json({ error: "s3Key required" });

    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key
        });
        const viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
        res.json({ viewUrl });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};
