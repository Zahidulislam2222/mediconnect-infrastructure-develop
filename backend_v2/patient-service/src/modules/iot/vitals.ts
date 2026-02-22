import { Request, Response } from "express";
import { getRegionalClient } from "../../config/aws";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GoogleAuth } from "google-auth-library";
import { getSSMParameter } from "../../config/aws";
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

 /* 🟢 GDPR 2026: Regional IoT BigQuery Sync
 * Routes EU wearables to Frankfurt (iot_eu) and US wearables to Virginia (iot).
 */
export const pushVitalToBigQuery = async (patientId: string, vitalData: any, region: string) => {
    try {
        // 1. Fetch the correct Service Account Key from the Regional Vault
        const saKey = await getSSMParameter("/mediconnect/prod/gcp/service-account", region, true);
        if (!saKey) return;

        const credentials = JSON.parse(saKey);
        const auth = new GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;
        const projectId = credentials.project_id;

        // 2. 🟢 DATA SOVEREIGNTY: Select Dataset based on Region
        const datasetName = region.toUpperCase() === 'EU' ? 'iot_eu' : 'iot';
        const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${datasetName}/tables/vitals_raw/insertAll`;

        // 3. Push to BigQuery (Matches your exact "data" JSON column schema)
        await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                kind: "bigquery#tableDataInsertAllRequest",
                rows: [{
                    json: {
                        // Your screenshot shows a single column named "data" of type JSON
                        data: JSON.stringify({
                            patientId: patientId,
                            timestamp: new Date().toISOString(),
                            region: region,
                            heartRate: vitalData.heartRate,
                            systolicBP: vitalData.systolicBP,
                            diastolicBP: vitalData.diastolicBP,
                            oxygenLevel: vitalData.oxygenLevel
                        })
                    }
                }]
            })
        });
        
    } catch (err: any) {
        console.error(`❌ BigQuery IoT Sync Failed [${region}]:`, err.message);
    }
};