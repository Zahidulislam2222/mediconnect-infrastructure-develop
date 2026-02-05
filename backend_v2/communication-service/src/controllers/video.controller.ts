import { Router, Request, Response } from "express";
import { ChimeSDKMeetingsClient, CreateMeetingCommand, CreateAttendeeCommand } from "@aws-sdk/client-chime-sdk-meetings";
import { docClient } from "../config/aws";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const router = Router();
const chimeClient = new ChimeSDKMeetingsClient({ region: "us-east-1" });
const TABLE_SESSIONS = "mediconnect-video-sessions";

// POST /video/session - Create or Join a meeting
router.post("/session", async (req: Request, res: Response) => {
    const { appointmentId, userId } = req.body;

    if (!appointmentId || !userId) {
        return res.status(400).json({ error: "Missing appointmentId or userId" });
    }

    try {
        // 1. Check if meeting exists in DB
        const dbRes = await docClient.send(new GetCommand({
            TableName: TABLE_SESSIONS,
            Key: { appointmentId }
        }));

        let meeting = dbRes.Item?.meeting;

        // 2. If not, create fresh meeting
        if (!meeting) {
            const chimeRes = await chimeClient.send(new CreateMeetingCommand({
                ClientRequestToken: uuidv4(),
                MediaRegion: "us-east-1",
                ExternalMeetingId: appointmentId
            }));
            meeting = chimeRes.Meeting;

            // Save meeting details
            await docClient.send(new PutCommand({
                TableName: TABLE_SESSIONS,
                Item: {
                    appointmentId,
                    meeting,
                    createdAt: new Date().toISOString()
                }
            }));
        }

        // 3. Create Attendee
        const attendeeRes = await chimeClient.send(new CreateAttendeeCommand({
            MeetingId: meeting.MeetingId,
            ExternalUserId: userId
        }));

        res.json({
            Meeting: meeting,
            Attendee: attendeeRes.Attendee
        });

    } catch (error: any) {
        console.error("Video Service Error:", error);
        res.status(500).json({ error: error.message });
    }
});

export const videoController = router;
