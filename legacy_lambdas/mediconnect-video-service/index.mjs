import { ChimeSDKMeetingsClient, CreateMeetingCommand, CreateAttendeeCommand } from "@aws-sdk/client-chime-sdk-meetings";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { PubSub } from "@google-cloud/pubsub";
import { v4 as uuidv4 } from "uuid";

// --- CONFIGURATION ---
const chimeClient = new ChimeSDKMeetingsClient({ region: "us-east-1" });
const dbClient = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(dbClient);

const TABLE_NAME = "mediconnect-video-sessions";
const TABLE_APPOINTMENTS = "mediconnect-appointments";

// 🔒 GLOBAL CORS HEADERS
const CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,POST"
};

// --- MAIN HANDLER (PURE REST) ---
export const handler = async (event) => {
  console.log("Video Service Request");

  // 1. Handle HTTP POST (Create/Join Meeting)
  // We check for 'httpMethod' (REST API) or 'routeKey' (HTTP API)
  if (event.httpMethod === 'POST' || event.requestContext?.http?.method === 'POST') {
      return await handleCreateOrJoinMeeting(event);
  }
  
  // 2. Handle OPTIONS (CORS Pre-flight)
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
      return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  // 3. Reject anything else (like accidental WebSocket connections)
  return { 
      statusCode: 400, 
      headers: CORS_HEADERS, 
      body: JSON.stringify({ error: "This service only handles Video Meeting Creation via POST." }) 
  };
};

// --- HTTP HANDLER ---
async function handleCreateOrJoinMeeting(event) {
  try {
    const body = event.body ? JSON.parse(event.body) : event;
    const { appointmentId, userId, userName } = body;

    if (!appointmentId || !userId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing ID" }) };
    }

    // 1. Check Appointment Existence
    const appointmentData = await docClient.send(new GetCommand({
        TableName: TABLE_APPOINTMENTS,
        Key: { appointmentId }
    }));
    
    // Note: In production, check appointmentData.Item here. 
    // Proceeding to create meeting logic...

    // 2. GET OR CREATE MEETING
    const getCommand = new GetCommand({ TableName: TABLE_NAME, Key: { appointmentId } });
    const dbResponse = await docClient.send(getCommand);
    let meetingInfo = dbResponse.Item?.meeting;

    const createFreshMeeting = async () => {
        console.log("Creating FRESH Meeting...");
        const response = await chimeClient.send(new CreateMeetingCommand({
            ClientRequestToken: uuidv4(),
            MediaRegion: "us-east-1",
            ExternalMeetingId: appointmentId
        }));
        // Update DB
        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                appointmentId,
                meeting: response.Meeting,
                createdAt: new Date().toISOString()
            }
        }));
        return response.Meeting;
    };

    if (!meetingInfo) {
        meetingInfo = await createFreshMeeting();
    }

    // 3. ADD ATTENDEE (With Auto-Heal)
    try {
        const attendeeResponse = await chimeClient.send(new CreateAttendeeCommand({
            MeetingId: meetingInfo.MeetingId,
            ExternalUserId: userId
        }));
        
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ Meeting: meetingInfo, Attendee: attendeeResponse.Attendee })
        };

    } catch (error) {
        if (error.name === 'NotFoundException' || error.message.includes('not found')) {
            console.warn("⚠️ Meeting expired. Re-creating...");
            meetingInfo = await createFreshMeeting();
            const retryAttendee = await chimeClient.send(new CreateAttendeeCommand({
                MeetingId: meetingInfo.MeetingId,
                ExternalUserId: userId
            }));
            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({ Meeting: meetingInfo, Attendee: retryAttendee.Attendee })
            };
        }
        throw error;
    }

  } catch (error) {
    console.error("HTTP Error:", error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: error.message }) };
  }
}