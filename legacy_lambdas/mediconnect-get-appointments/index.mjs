import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// Environment variables for flexibility, with sensible defaults
const TABLE_APPOINTMENTS = process.env.TABLE_APPOINTMENTS || "mediconnect-appointments";
const TABLE_SCHEDULES = process.env.TABLE_SCHEDULES || "mediconnect-doctor-schedules"; 

export const handler = async (event) => {
  // Standard CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*", // For production, restrict to your domain
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET"
  };

  // Handle pre-flight OPTIONS request for CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    const queryParams = event.queryStringParameters || {};
    const doctorId = queryParams.doctorId;
    const patientId = queryParams.patientId;

    // =========================================================
    // 🟢 SCENARIO 1: PATIENT HISTORY (Now Optimized with GSI)
    // Fetches all appointments for a single patient across all doctors.
    // =========================================================
    if (patientId) {
      // ✅ PROFESSIONAL FIX: Use Query on the PatientIndex instead of a slow Scan.
      const command = new QueryCommand({
        TableName: TABLE_APPOINTMENTS,
        IndexName: "PatientIndex", // Target the GSI for patients
        KeyConditionExpression: "patientId = :pid",
        ExpressionAttributeValues: { ":pid": patientId },
        ScanIndexForward: false // Return newest appointments first
      });

      const response = await docClient.send(command);
      
      // ✅ CONSISTENT RESPONSE: Return in the same format as the Doctor endpoint.
      // This makes the frontend logic simpler.
      return { 
          statusCode: 200, 
          headers: headers, 
          body: JSON.stringify({ existingBookings: response.Items || [] }) 
      };
    }

    // =========================================================
    // 🔵 SCENARIO 2: DOCTOR SLOT LOOKUP (Existing Logic - Verified Correct)
    // Fetches all appointments for one doctor + their working hours.
    // =========================================================
    if (doctorId) {
      console.log(`📅 Fetching booking data for Doctor: ${doctorId}`);
      
      // 1. Fetch Existing Bookings using the DoctorIndex
      const bookingCommand = new QueryCommand({
        TableName: TABLE_APPOINTMENTS,
        IndexName: "DoctorIndex",
        KeyConditionExpression: "doctorId = :did",
        ExpressionAttributeValues: { ":did": doctorId },
      });

      // 2. Fetch Doctor's Working Hours and Timezone
      const scheduleCommand = new GetCommand({
        TableName: TABLE_SCHEDULES,
        Key: { doctorId: doctorId }
      });

      // Run both database calls in parallel for speed
      const [bookingRes, scheduleRes] = await Promise.all([
        docClient.send(bookingCommand),
        docClient.send(scheduleCommand)
      ]);

      // 3. Combine data into a single response payload
      const responsePayload = {
        existingBookings: bookingRes.Items || [],
        weeklySchedule: scheduleRes.Item?.schedule || {},
        timezone: scheduleRes.Item?.timezone || "UTC" 
      };

      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify(responsePayload), 
      };
    }
    
    // If neither doctorId nor patientId is provided, return an error.
    return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: "Missing required query parameter: doctorId or patientId" }),
    };

  } catch (error) {
    console.error("❌ Database or Logic Error:", error);
    return { 
        statusCode: 500, 
        headers: headers, 
        body: JSON.stringify({ error: "Could not process the request.", details: error.message }) 
    };
  }
};