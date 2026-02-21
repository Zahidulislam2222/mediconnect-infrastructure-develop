import { Request, Response } from "express";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
// 🟢 ARCHITECTURE FIX: Use Shared Factory (Prevents Region Lock & Socket Exhaustion)
import { getRegionalClient } from '../../config/aws';
import { writeAuditLog } from '../../../../shared/audit';

const TABLE_GRAPH = "mediconnect-graph-data";

// 🟢 COMPILER FIX: Safely extract region string
const extractRegion = (req: Request): string => {
    const rawRegion = req.headers['x-user-region'];
    return Array.isArray(rawRegion) ? rawRegion[0] : (rawRegion || "us-east-1");
};

export const getRelationships = async (req: Request, res: Response) => {
    try {
        const authUser = (req as any).user;
        
        // 🟢 GDPR FIX: Define Regional Client based on user header
        const userRegion = extractRegion(req);
        const docClient = getRegionalClient(userRegion);

        let { entityId } = req.query as { entityId: string };

        if (!entityId) return res.status(400).json({ error: "Missing entityId" });

        // 🟢 UX FIX: Resolve "PATIENT" alias to the authenticated user's ID
        if (entityId === "PATIENT") {
            entityId = `PATIENT#${authUser.sub}`;
        }

        const isDoctor = authUser['cognito:groups']?.some((g: string) => g.toLowerCase().includes('doctor'));

        // 🟢 SECURITY CHECK: IDOR Prevention
        const isSearchingOwnSelf = entityId === `PATIENT#${authUser.sub}`;
        if (!isDoctor && !isSearchingOwnSelf) {
            await writeAuditLog(authUser.sub, entityId, "UNAUTHORIZED_GRAPH_ACCESS", "Blocked attempt to view another user's care network");
            return res.status(403).json({ error: "Access Denied: You can only view your own care network." });
        }

        const command = new QueryCommand({
            TableName: TABLE_GRAPH,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": entityId }
        });

        const response = await docClient.send(command);
        const rawItems = response.Items || [];

        // 🟢 FHIR R4 MAPPING: Transform DynamoDB Graph -> FHIR CareTeam Resource
        // This makes the data interoperable with hospital systems.
        const fhirCareTeam = {
            resourceType: "CareTeam",
            id: entityId.replace('PATIENT#', ''),
            status: "active",
            subject: { 
                reference: `Patient/${entityId.replace('PATIENT#', '')}`,
                display: "Current Patient"
            },
            participant: rawItems.map((item: any) => ({
                role: [{ 
                    text: item.relationship || "Care Provider" 
                }],
                member: {
                    // Extract ID from SK (e.g., "DOCTOR#123" -> "Practitioner/123")
                    reference: item.SK.includes('DOCTOR#') 
                        ? `Practitioner/${item.SK.replace('DOCTOR#', '')}` 
                        : `RelatedPerson/${item.SK}`,
                    display: item.doctorName || item.patientName || "Unknown Provider"
                },
                period: {
                    start: item.createdAt || new Date().toISOString()
                }
            })),
            meta: {
                lastUpdated: new Date().toISOString(),
                tag: [{ system: "https://mediconnect.com/region", code: userRegion }]
            }
        };

        // HIPAA Audit Log (Using Shared Service)
        const logTargetId = entityId.includes('#') ? entityId.split('#')[1] : entityId;
        await writeAuditLog(
            authUser.sub, 
            logTargetId, 
            "ACCESS_CARE_TEAM", 
            `Viewed ${rawItems.length} members in Care Team`
        );

        res.json({
            // Return standard FHIR resource
            resource: fhirCareTeam,
            // Keep legacy array for current frontend compatibility if needed
            connections: rawItems, 
            timestamp: new Date().toISOString()
        });

    } catch (error: any) {
        console.error("Relationship Graph Error:", error);
        res.status(500).json({ error: "Failed to load care network" });
    }
};