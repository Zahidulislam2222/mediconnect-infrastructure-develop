import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

export const generatePresignedUrl = async (bucket: string, key: string, expiresIn: number = 3600): Promise<string> => {
    try {
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn });
        return url;
    } catch (error) {
        console.error('Error generating presigned URL:', error);
        return ''; // Or throw error based on preference, returning empty string for graceful UI degradation
    }
};
