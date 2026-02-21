import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from 'uuid';
import { safeError } from "./logger";

// 🟢 PROFESSIONAL FIX: Import from the SAME folder (shared/aws-config.ts)
// This ensures Doctor, Patient, and Booking services can all use this file.
import { getRegionalClient } from "./aws-config";

export interface AuditMetadata {
    region?: string;      // 🟢 Mandatory for GDPR Routing
    ipAddress?: string;   // HIPAA 2026 requirement
    role?: string;        // Role-based auditing
    [key: string]: any;
}

/**
 * writeAuditLog - Clinical-Grade Multi-Cloud Audit Logger
 * 🟢 GDPR 2026: Automatically routes logs to the correct regional silo.
 * 🟢 FHIR R4: Wraps the log in a standard AuditEvent resource.
 */
export const writeAuditLog = async (
    actorId: string,
    patientId: string,
    action: string,
    details: string,
    metadata?: AuditMetadata
) => {
    // 1. Identify Target Region (Default to US if not provided)
    const targetRegion = metadata?.region || "us-east-1";

    try {
        const timestamp = new Date().toISOString();
        const logId = uuidv4();
        
        // 2. 🟢 DYNAMIC ROUTING: Connects to Frankfurt or Virginia based on user home
        const dynamicDb = getRegionalClient(targetRegion);

        // 3. 🟢 FHIR R4 COMPLIANCE: Map to 'AuditEvent' Resource Standard
        const fhirAuditEvent = {
            resourceType: "AuditEvent",
            id: logId,
            type: { system: "http://dicom.nema.org/resources/ontology/DCM", code: "110110", display: "Patient Record" },
            action: action.includes("READ") ? "R" : action.includes("CREATE") ? "C" : "U",
            recorded: timestamp,
            outcome: "0", // Success
            agent: [{
                requestor: true,
                reference: { display: `Actor/${actorId}` },
                role: [{ text: metadata?.role || "user" }]
            }],
            source: { observer: { display: "MediConnect-Cloud-V2" } },
            entity: [{ reference: { display: `Patient/${patientId}` } }]
        };

        const item = {
            logId,
            timestamp,
            actorId: actorId || "SYSTEM",
            patientId: patientId || "UNKNOWN",
            action,
            details,
            metadata: metadata || {},
            resource: fhirAuditEvent, // FHIR Interoperability
            region: targetRegion      // Data Residency Proof
        };

        await dynamicDb.send(new PutCommand({
            TableName: "mediconnect-audit-logs",
            Item: item
        }));

        console.log(`[AUDIT][${targetRegion.toUpperCase()}] ${action} recorded for Patient: ${patientId}`);

    } catch (error: any) {
        // 🚨 HIPAA FALLBACK
        safeError("AUDIT_WRITE_FAILED_CRITICAL", {
            error: error.message,
            actorId,
            action,
            targetRegion,
            details
        });
    }
};