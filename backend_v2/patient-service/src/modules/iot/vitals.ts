import { Request, Response } from "express";
import { getRegionalClient } from "../../config/aws";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { writeAuditLog } from "../../../../shared/audit";

export const getVitals = async (req: Request, res: Response) => {
    try {
        const patientId = req.query.patientId as string;
        const limitParam = req.query.limit as string || "1";
        const limit = parseInt(limitParam, 10);

        const requesterId = (req as any).user?.id;
        const requesterRole = (req as any).user?.role;
        const userRegion = (req as any).user?.region || (req.headers['x-user-region'] as string) || "us-east-1";

        if (!patientId) return res.status(400).json({ error: "patientId required" });

        // HIPAA: IDOR Authorization Check
        const isAuthorized = (requesterId === patientId) || (requesterRole === 'doctor' || requesterRole === 'provider');

        if (!isAuthorized) {
            await writeAuditLog(requesterId || "UNKNOWN", patientId, "UNAUTHORIZED_PHI_READ", "Attempted to read vitals without permission", { ipAddress: req.ip });
            return res.status(403).json({ error: "Access Denied: Unauthorized access to patient telemetry." });
        }

        // 🟢 ARCHITECTURE FIX: Dynamic Table Name Evaluation
        const TABLE_VITALS = process.env.DYNAMO_TABLE_VITALS || "mediconnect-iot-vitals";
        const dynamicDb = getRegionalClient(userRegion);

        const response = await dynamicDb.send(new QueryCommand({
            TableName: TABLE_VITALS,
            KeyConditionExpression: "patientId = :pid",
            ExpressionAttributeValues: { ":pid": patientId },
            ScanIndexForward: false,
            Limit: limit
        }));

        // 🟢 HIPAA FIX: Immutable Audit Log for viewing Protected Health Information (PHI)
        await writeAuditLog(requesterId, patientId, "READ_VITALS", `Viewed ${response.Items?.length || 0} recent vitals`, { region: userRegion, ipAddress: req.ip });

        if (!response.Items || response.Items.length === 0) {
            return res.status(404).json({
                message: "No vitals data found for this patient.",
                history: [],
                fhirBundle: { resourceType: "Bundle", type: "searchset", total: 0, entry: [] }
            });
        }

        const rawVitals = response.Items[0];

        // FHIR R4 MAPPING (LOINC 8867-4 for Heart Rate)
        const fhirBundle = {
            resourceType: "Bundle",
            type: "searchset",
            total: response.Items.length,
            entry: response.Items.map((item: any) => ({
                resource: {
                    resourceType: "Observation",
                    status: "final",
                    code: {
                        coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }]
                    },
                    subject: { reference: `Patient/${patientId}` },
                    effectiveDateTime: item.timestamp || item.createdAt,
                    valueQuantity: {
                        value: item.heartRate,
                        unit: "beats/minute",
                        system: "http://unitsofmeasure.org",
                        code: "/min"
                    }
                }
            }))
        };

        res.json({
            vitals: rawVitals,
            history: response.Items,
            fhirBundle: fhirBundle,
            region: userRegion
        });

    } catch (err: any) {
        console.error("Vitals Error:", err.message);
        res.status(500).json({ error: "Internal Server Error during vitals retrieval." });
    }
};