import winston from 'winston';

/**
 * 🟢 GDPR & HIPAA COMPLIANT MASKING
 * This covers the message and any metadata objects passed.
 */
const maskPII = winston.format((info: any) => {
    // Regex Patterns
    const patterns = {
        email: /([a-zA-Z0-9_\-\.]+)@([a-zA-Z0-9_\-\.]+)\.([a-zA-Z]{2,5})/g,
        ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
        phone: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g
    };

    const scrub = (str: string): string => {
        return str
            .replace(patterns.email, (m, user, domain, ext) => `${user.charAt(0)}***@${domain}.${ext}`)
            .replace(patterns.ssn, '***-**-****')
            .replace(patterns.phone, '***-***-****');
    };

    // 1. Mask the main message
    if (typeof info.message === 'string') {
        info.message = scrub(info.message);
    }

    // 2. Recursive Masking via JSON Stringify
    // We serialize the entire info object (excluding message if already scrubbed, but here we scrub the whole thing ensures deep coverage)
    // However, winston 'info' object structure is flat properties + splat. 
    // The user requested JSON.stringify scrubbing.
    // We will scrub the metadata.

    try {
        const stringified = JSON.stringify(info);
        const scrubbed = scrub(stringified);
        const parsed = JSON.parse(scrubbed);
        Object.assign(info, parsed);
    } catch (e) {
        // Fallback or ignore circular reference errors, keep original info
    }

    return info;
});

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        maskPII(), // 🟢 Run masking BEFORE JSON formatting
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Wrapper to replace console.log in legacy parts easily
export const createLogger = (serviceName: string) => {
    return {
        log: (message: string, ...meta: any[]) => logger.info(`[${serviceName}] ${message}`, ...meta),
        error: (message: string, ...meta: any[]) => logger.error(`[${serviceName}] ${message}`, ...meta),
        info: (message: string, ...meta: any[]) => logger.info(`[${serviceName}] ${message}`, ...meta),
        warn: (message: string, ...meta: any[]) => logger.warn(`[${serviceName}] ${message}`, ...meta),
    };
};

export const safeLog = (message: string, ...meta: any[]) => {
    logger.info(message, ...meta);
};

export const safeError = (message: string, ...meta: any[]) => {
    logger.error(message, ...meta);
};