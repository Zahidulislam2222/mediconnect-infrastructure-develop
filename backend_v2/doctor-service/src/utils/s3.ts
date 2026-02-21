import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
// 🟢 ARCHITECTURE FIX: Import Shared Factory (Prevents GDPR Residency leaks)
import { getRegionalS3Client } from '../config/aws';

/**
 * generatePresignedUrl - Clinical Grade File Delivery
 * 🟢 GDPR FIX: Now requires 'region' to ensure we connect to the correct physical bucket.
 */
export const generatePresignedUrl = async (
    bucket: string, 
    key: string, 
    expiresIn: number = 3600,
    region: string = "us-east-1" 
): Promise<string> => {
    try {
        // 🟢 GDPR/INFRA FIX: Use the cached regional client
        const s3Client = getRegionalS3Client(region);

        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        });

        // 🟢 HIPAA: Ensure URLs are time-limited (Default 1 hour)
        const url = await getSignedUrl(s3Client, command, { expiresIn });
        return url;
    } catch (error) {
        console.error('Error generating presigned URL:', error);
        return ''; 
    }
};