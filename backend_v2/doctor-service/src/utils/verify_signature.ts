import { VerifyCommand } from "@aws-sdk/client-kms";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
// 🟢 ARCHITECTURE FIX: Use Shared Factories to support US and EU audits
import { getRegionalClient, getRegionalKMSClient } from "../config/aws";
import { writeAuditLog } from "../../../shared/audit";

/**
 * runPerfectAudit - Clinical Integrity Verifier
 * 🟢 GDPR FIX: Now accepts 'region' to prevent US-EU data leakage.
 */
async function runPerfectAudit(prescriptionId: string, region: string = "us-east-1") {
    
    // 1. Initialize Regional Infrastructure
    const docClient = getRegionalClient(region);
    const kmsClient = getRegionalKMSClient(region);

    console.log(`🔍 [AUDIT][${region.toUpperCase()}] Fetching Prescription: ${prescriptionId}`);

    // 2. Fetch the Clinical Record
    const result = await docClient.send(new GetCommand({
        TableName: "mediconnect-prescriptions",
        Key: { prescriptionId }
    }));

    const item = result.Item;
    if (!item) {
        console.error("❌ Error: Prescription record not found in this region.");
        return;
    }

    /**
     * 🟢 FHIR INTEGRITY FIX: 
     * We verify the 'resource' object itself. This ensures that the medical data 
     * shared with hospitals is exactly what the doctor signed.
     */
    const dataToVerify = JSON.stringify(item.resource || {
        prescriptionId: item.prescriptionId,
        patientName: item.patientName,
        doctorName: item.doctorName,
        medication: item.medication,
        dosage: item.dosage,
        instructions: item.instructions,
        timestamp: item.timestamp
    });

    console.log("🔒 Step 2: Validating Digital Signature via Regional KMS...");

    // 3. Perform Cryptographic Verification
    const command = new VerifyCommand({
        KeyId: process.env.KMS_KEY_ID, 
        Message: Buffer.from(dataToVerify),
        MessageType: "RAW",
        Signature: Buffer.from(item.signature, "base64"),
        // 🟢 ALGORITHM FIX: Must match 'RSASSA_PKCS1_V1_5_SHA_256' used in PDF Generator
        SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });

    try {
        const response = await kmsClient.send(command);
        
        if (response.SignatureValid) {
            console.log("✅ [LEGAL AUDIT PASSED]: Identity and Integrity 100% Verified.");

            // 🟢 HIPAA FIX: Record the Audit Action
            await writeAuditLog(
                "SYSTEM_AUDITOR", 
                item.patientId, 
                "INTEGRITY_VERIFICATION_SUCCESS", 
                `Verified clinical signature for Rx: ${prescriptionId}`,
                { region }
            );
        } else {
            console.error("🚨 [SECURITY ALERT]: Signature is INVALID. Data may have been tampered with.");
        }
    } catch (e: any) {
        console.error("❌ [AUDIT FAILED]:", e.message);
        
        // Log the failure for HIPAA investigation
        await writeAuditLog(
            "SYSTEM_AUDITOR", 
            item.patientId || "UNKNOWN", 
            "INTEGRITY_VERIFICATION_FAILURE", 
            `Verification failed for Rx: ${prescriptionId}. Error: ${e.message}`,
            { region }
        );
    }
}

// Example usage for an EU prescription
// runPerfectAudit("d17c2fb3-022b...", "EU");
// Default usage for US
const targetId = process.env.AUDIT_TARGET_ID || "d17c2fb3-022b..."; 
runPerfectAudit(targetId, "US");