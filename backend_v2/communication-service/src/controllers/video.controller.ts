import { Router, Request, Response } from "express";
import { ChimeSDKMeetingsClient, CreateMeetingCommand, CreateAttendeeCommand, DeleteMeetingCommand } from "@aws-sdk/client-chime-sdk-meetings";
import { ChimeSDKMediaPipelinesClient, CreateMediaCapturePipelineCommand, DeleteMediaCapturePipelineCommand } from "@aws-sdk/client-chime-sdk-media-pipelines";
import { docClient } from "../config/aws";
import { PutCommand, GetCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { writeAuditLog } from "../../../shared/audit";

const router = Router();
const chimeClient = new ChimeSDKMeetingsClient({ region: "us-east-1" });
const pipelineClient = new ChimeSDKMediaPipelinesClient({ region: "us-east-1" });

const TABLE_SESSIONS = "mediconnect-video-sessions";
const RECORDING_BUCKET = "mediconnect-consultation-recordings";

// POST /video/session - Create or Join a meeting
router.post("/session", async (req: Request, res: Response) => {
    const { appointmentId } = req.body;
    // 🟢 AUTH CHECK: Ensure middleware populated this
    const userId = (req as any).user?.sub; 

    if (!appointmentId || !userId) {
        return res.status(400).json({ error: "Missing appointmentId or User ID" });
    }

    try {
        // 🟢 HIPAA CHECK: Verify user belongs to this appointment
        const aptRes = await docClient.send(new GetCommand({
            TableName: "mediconnect-appointments",
            Key: { appointmentId }
        }));

        const apt = aptRes.Item;
        if (!apt || (apt.patientId !== userId && apt.doctorId !== userId)) {
            return res.status(403).json({ error: "Unauthorized: You are not a participant" });
        }

        const dbRes = await docClient.send(new GetCommand({
            TableName: TABLE_SESSIONS,
            Key: { appointmentId }
        }));

        let meeting = dbRes.Item?.meeting;

        if (!meeting) {
            // 1. Create Meeting
            const chimeRes = await chimeClient.send(new CreateMeetingCommand({
                ClientRequestToken: uuidv4(),
                MediaRegion: "us-east-1",
                ExternalMeetingId: appointmentId,
                MeetingFeatures: { Audio: { EchoReduction: "AVAILABLE" } }
            } as any));
            meeting = chimeRes.Meeting;

            // 🟢 2. START RECORDING PIPELINE (FIXED CONFIGURATION)
            let pipelineId = null;
            if (meeting?.MeetingArn) {
                try {
                    const pipelineRes = await pipelineClient.send(new CreateMediaCapturePipelineCommand({
                        SourceType: "ChimeSdkMeeting",
                        SourceArn: meeting.MeetingArn,
                        SinkType: "S3Bucket",
                        SinkArn: `arn:aws:s3:::${RECORDING_BUCKET}/recordings/${appointmentId}`,
                        ChimeSdkMeetingConfiguration: {
                            ArtifactsConfiguration: {
                                // 🟢 FIX: Audio MUST be AudioOnly. 
                                Audio: { MuxType: "AudioOnly" }, 
                                // VideoOnly captures all individual streams (including active speaker)
                                Video: { State: "Enabled", MuxType: "VideoOnly" },
                                Content: { State: "Enabled", MuxType: "ContentOnly" }
                            }
                        }
                    }));
                    pipelineId = pipelineRes.MediaCapturePipeline?.MediaPipelineId;
                    console.log(`🎥 Recording started: ${pipelineId}`);
                } catch (recErr: any) {
                    console.error("Failed to start recording:", recErr.message);
                    // Don't block the meeting if recording fails, but log it
                }
            }

            // 3. SAVE MEETING + PIPELINE ID TO DB
            await docClient.send(new PutCommand({
                TableName: TABLE_SESSIONS,
                Item: {
                    appointmentId,
                    meeting,
                    pipelineId, 
                    createdAt: new Date().toISOString(),
                    ttl: Math.floor(Date.now() / 1000) + 86400 // 24 Hours TTL
                }
            }));
        }

        // 4. Create Attendee
        const attendeeRes = await chimeClient.send(new CreateAttendeeCommand({
            MeetingId: meeting.MeetingId,
            ExternalUserId: userId
        }));

        // 5. Update Appointment Status (Arrived)
        try {
            await docClient.send(new UpdateCommand({
                TableName: "mediconnect-appointments",
                Key: { appointmentId },
                UpdateExpression: "SET #res.#stat = :s, patientArrived = :arrived",
                ExpressionAttributeNames: { "#res": "resource", "#stat": "status" },
                ExpressionAttributeValues: { ":s": "arrived", ":arrived": true }
            }));
        } catch (e) { console.warn("Could not update FHIR status", e); }

        await writeAuditLog(userId, userId, "VIDEO_SESSION_JOINED", `User joined appointment ${appointmentId}`);

        res.json({ Meeting: meeting, Attendee: attendeeRes.Attendee });
    } catch (error: any) {
        console.error("Video Session Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// DELETE /video/session - End meeting and stop per-minute billing
router.delete("/session", async (req: Request, res: Response) => {
    const appointmentId = req.query.appointmentId as string;
    const userId = (req as any).user?.sub;
    // 🟢 AUTH CHECK: Make sure 'role' exists. If not, default to patient.
    // Ensure your auth.middleware.ts attaches user groups/role
    const groups = (req as any).user?.['cognito:groups'] || [];
    const userRole = groups.includes('doctor') ? 'doctor' : 'patient';

    try {
        const dbRes = await docClient.send(new GetCommand({
            TableName: TABLE_SESSIONS,
            Key: { appointmentId }
        }));

        const session = dbRes.Item;

        // 1. Stop Recording Pipeline (if exists)
        if (session?.pipelineId) {
            try {
                await pipelineClient.send(new DeleteMediaCapturePipelineCommand({
                    MediaPipelineId: session.pipelineId
                }));
                console.log(`🛑 Recording stopped: ${session.pipelineId}`);
            } catch (e) {
                console.warn("Failed to stop recording pipeline", e);
            }
        }

        if (session?.meeting?.MeetingId) {
            // 2. Stop Chime billing (Delete Meeting)
            try {
                await chimeClient.send(new DeleteMeetingCommand({
                    MeetingId: session.meeting.MeetingId
                }));
            } catch (e) { console.warn("Meeting already deleted"); }

            // 3. Delete session record
            await docClient.send(new DeleteCommand({
                TableName: TABLE_SESSIONS,
                Key: { appointmentId }
            }));

            // 4. Update Appointment Status
            // Doctors complete the appt, Patients just leave.
            const clinicalStatus = userRole === 'doctor' ? 'fulfilled' : 'arrived';
            
            await docClient.send(new UpdateCommand({
                TableName: "mediconnect-appointments",
                Key: { appointmentId },
                UpdateExpression: "SET #res.#stat = :s, #s = :legacyStatus",
                ExpressionAttributeNames: { "#res": "resource", "#stat": "status", "#s": "status" },
                ExpressionAttributeValues: { 
                    ":s": clinicalStatus,
                    ":legacyStatus": userRole === 'doctor' ? "COMPLETED" : "CONFIRMED"
                }
            }));

            await writeAuditLog(userId, userId, "VIDEO_SESSION_ENDED", `Meeting ${appointmentId} ended`);
        }

        res.json({ success: true, message: "Meeting ended and billing stopped" });
    } catch (error: any) {
        console.error("End Session Error:", error);
        res.status(500).json({ error: "Failed to end session" });
    }
});

export const videoController = router;