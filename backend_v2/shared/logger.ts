import winston from 'winston';

const maskPII = winston.format((info: any) => {
    if (typeof info.message === 'string') {
        // Mask Emails (matches content around @ symbol)
        // Lookbehind not supported in all node versions, simplified regex:
        info.message = info.message.replace(/([a-zA-Z0-9_\-\.]+)@([a-zA-Z0-9_\-\.]+)\.([a-zA-Z]{2,5})/g, (match: string, user: string, domain: string, ext: string) => {
            return `${user.charAt(0)}***@${domain}.${ext}`;
        });

        // Mask SSN / ID Pattern (Generic XXX-XX-XXXX)
        info.message = info.message.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****');

        // Mask Credit Cards (Generic 16 digits with dashes)
        info.message = info.message.replace(/\b\d{4}-\d{4}-\d{4}-(\d{4})\b/g, '****-****-****-$1');
    }
    return info;
});

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        maskPII(),
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                maskPII(),
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
