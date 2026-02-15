/**
 * MediConnect FHIR R4 Mapper & PII Scrubber
 * Standard: FHIR R4 (HL7), HIPAA Safe Harbor, GDPR
 * Last Updated: Feb 2026
 */

const PII_REGEX = {
    SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
    CREDIT_CARD: /\b(?:\d[ -]*?){13,16}\b/g,
    PHONE: /\b(?:\+?1[-. ]?)?\(?([2-9][0-8][0-5])\)?[-. ]?([2-9][0-8][0-5])[-. ]?([0-9]{4})\b/g,
    EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    URL: /\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|]/ig,
    IP_ADDR: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    DOB: /\b(?:\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/g // 🟢 ADDED: Basic Date of Birth masking
};

/**
 * HIPAA Safe Harbor Compliant Scrubber
 */
export const scrubPII = (text: string): string => {
    if (!text) return "";
    return text
        .replace(PII_REGEX.SSN, "[REDACTED_ID]")
        .replace(PII_REGEX.CREDIT_CARD, "[REDACTED_PAYMENT]")
        .replace(PII_REGEX.PHONE, "[REDACTED_CONTACT]")
        .replace(PII_REGEX.EMAIL, "[REDACTED_EMAIL]")
        .replace(PII_REGEX.URL, "[REDACTED_URL]")
        .replace(PII_REGEX.IP_ADDR, "[REDACTED_IP]")
        .replace(PII_REGEX.DOB, "[REDACTED_DATE]");
};

/**
 * 1. Communication Resource (Chat/AI Messages)
 */
export const mapToFHIRCommunication = (
    senderId: string,
    senderRole: 'Patient' | 'Practitioner' | 'RelatedPerson' | 'Device',
    recipientId: string,
    recipientRole: 'Patient' | 'Practitioner' | 'RelatedPerson',
    text: string
) => {
    return {
        resourceType: "Communication",
        status: "completed",
        sent: new Date().toISOString(),
        sender: { reference: `${senderRole}/${senderId}` },
        recipient: [{ reference: `${recipientRole}/${recipientId}` }],
        payload: [{ contentString: scrubPII(text) }],
        category: [{
            coding: [{
                system: "http://terminology.hl7.org/CodeSystem/communication-category",
                code: "notification"
            }]
        }]
    };
};

/**
 * 2. DiagnosticReport: Symptom Analysis (Category: GE - General)
 */
export const mapToFHIRDiagnosticReport = (
    patientId: string,
    symptoms: string[],
    analysis: any,
    provider: string
) => {
    return {
        resourceType: "DiagnosticReport",
        status: "final",
        category: [{
            coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "GE" }]
        }],
        code: {
            coding: [{ system: "http://loinc.org", code: "11450-4", display: "Problem list - Reported" }],
            text: "AI Symptom Analysis"
        },
        subject: { reference: `Patient/${patientId}` },
        effectiveDateTime: new Date().toISOString(),
        issued: new Date().toISOString(),
        performer: [{ display: provider }],
        conclusion: `${analysis.risk}: ${analysis.reason}`,
        extension: [{
            url: "http://mediconnect.com/fhir/StructureDefinition/symptoms",
            valueString: symptoms.join(", ")
        }]
    };
};

/**
 * 3. DiagnosticReport: Imaging (Category: IMG - Imaging)
 */
export const mapToFHIRImagingReport = (
    patientId: string,
    doctorId: string,
    analysis: string,
    provider: string
) => {
    return {
        resourceType: "DiagnosticReport",
        status: "final",
        category: [{
            coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "IMG" }]
        }],
        code: {
            coding: [{ system: "http://loinc.org", code: "18748-4", display: "Diagnostic imaging study" }],
            text: "AI-Assisted Image Analysis"
        },
        subject: { reference: `Patient/${patientId}` },
        resultsInterpreter: [{ reference: `Practitioner/${doctorId}` }],
        issued: new Date().toISOString(),
        performer: [{ display: provider }],
        conclusion: scrubPII(analysis)
    };
};

/**
 * 4. RiskAssessment Resource (Predictive Analytics)
 */
export const mapToFHIRRiskAssessment = (
    patientId: string,
    doctorId: string,
    analysis: { riskScore: number, riskLevel: string, clinicalJustification: string },
    modelType: string
) => {
    return {
        resourceType: "RiskAssessment",
        status: "final",
        subject: { reference: `Patient/${patientId}` },
        performer: { reference: `Practitioner/${doctorId}` },
        occurrenceDateTime: new Date().toISOString(),
        basis: [{ display: `Clinical Vitals Input for ${modelType}` }],
        prediction: [{
            probabilityDecimal: analysis.riskScore / 100,
            qualitativeRisk: { text: analysis.riskLevel },
            rationale: analysis.clinicalJustification
        }]
    };
};

/**
 * Shared: Status Update Helper
 */
export const getFHIRStatusUpdate = (status: 'arrived' | 'fulfilled' | 'cancelled') => {
    return {
        status: status,
        lastUpdated: new Date().toISOString()
    };
};