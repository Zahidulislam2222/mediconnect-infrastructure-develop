import { Request, Response } from "express";
import { docClient } from "../../config/aws";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_VITALS = process.env.DYNAMO_TABLE_VITALS || "mediconnect-iot-vitals";

export const getVitals = async (req: Request, res: Response) => {
    try {
        const patientId = req.query.patientId as string;
        const limitParam = req.query.limit as string || "1";
        const limit = parseInt(limitParam, 10);

        const requesterId = (req as any).user?.id;
        const requesterRole = (req as any).user?.role;

        if (!patientId) return res.status(400).json({ error: "patientId required" });

        const isAuthorized = (requesterId === patientId) || (requesterRole === 'doctor' || requesterRole === 'provider');

        if (!isAuthorized) {
            return res.status(403).json({ error: "Access Denied: Unauthorized access to patient telemetry." });
        }

        const response = await docClient.send(new QueryCommand({
            TableName: TABLE_VITALS,
            KeyConditionExpression: "patientId = :pid",
            ExpressionAttributeValues: { ":pid": patientId },
            ScanIndexForward: false,
            Limit: limit
        }));

        // 🟢 PROFESSIONAL EMPTY STATE HANDLING
        if (!response.Items || response.Items.length === 0) {
            return res.status(404).json({
                message: "No vitals data found for this patient.",
                history: [],
                fhirBundle: { resourceType: "Bundle", type: "searchset", total: 0, entry: [] }
            });
        }

        const rawVitals = response.Items[0];

        // 🟢 FHIR R4 MAPPING
        const fhirBundle = {
            resourceType: "Bundle",
            type: "searchset",
            total: response.Items.length,
            entry: response.Items.map(item => ({
                resource: {
                    resourceType: "Observation",
                    status: "final",
                    code: {
                        coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }]
                    },
                    subject: { reference: `Patient/${patientId}` },
                    effectiveDateTime: item.timestamp || item.createdAt, // 🟢 Fixed logic
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
            fhirBundle: fhirBundle
        });

    } catch (err: any) {
        console.error("Vitals Error:", err.message);
        res.status(500).json({ error: "Internal Server Error during vitals retrieval." });
    }
};