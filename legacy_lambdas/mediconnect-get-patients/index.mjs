import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
// 🟢 NEW IMPORTS FOR S3
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// 🟢 INITIALIZE S3
const s3Client = new S3Client({ region: "us-east-1" }); // Ensure region matches your bucket
const BUCKET_NAME = "mediconnect-identity-verification";

// 🔒 HEADERS
const HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET"
};

export const handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }

    // 🟢 ANALYTICS MODE: Demographics (Unchanged)
    const query = event.queryStringParameters || {};
    
    if (query.type === 'demographics') {
        const command = new ScanCommand({ 
            TableName: "mediconnect-patients",
            ProjectionExpression: "dob, #r",
            ExpressionAttributeNames: { "#r": "role" }
        });
        
        const response = await docClient.send(command);
        const allUsers = response.Items || [];

        const ageGroups = { '18-30': 0, '31-50': 0, '51-70': 0, '70+': 0 };
        let patientCount = 0;

        allUsers.forEach(p => {
            if (p.role === 'patient' && p.dob) {
                patientCount++;
                const birthDate = new Date(p.dob);
                const ageDifMs = Date.now() - birthDate.getTime();
                const ageDate = new Date(ageDifMs);
                const age = Math.abs(ageDate.getUTCFullYear() - 1970);

                if (age <= 30) ageGroups['18-30']++;
                else if (age <= 50) ageGroups['31-50']++;
                else if (age <= 70) ageGroups['51-70']++;
                else ageGroups['70+']++;
            }
        });

        const demographicData = Object.keys(ageGroups).map(key => ({
            name: key,
            value: ageGroups[key]
        }));

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ demographicData, totalPatients: patientCount })
        };
    }

    // 🔵 STANDARD MODE (Full List with Secure Images)
    const command = new ScanCommand({
      TableName: "mediconnect-patients",
    });

    const response = await docClient.send(command);
    let realPatients = (response.Items || []).filter(user => user.role === 'patient');

    // 🟢 NEW SECURITY LOGIC: Generate Presigned URLs
    // We use Promise.all to handle multiple async signing requests efficiently
    await Promise.all(realPatients.map(async (patient) => {
        if (patient.avatar && !patient.avatar.startsWith("http")) {
            try {
                const command = new GetObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: patient.avatar
                });
                // Generate secure link valid for 1 hour
                const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                patient.avatar = signedUrl;
            } catch (err) {
                console.error(`Error signing URL for patient ${patient.patientId}:`, err);
            }
        }
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...HEADERS }, 
      body: JSON.stringify({
        count: realPatients.length,
        patients: realPatients
      }),
    };

  } catch (error) {
    console.error(error);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};