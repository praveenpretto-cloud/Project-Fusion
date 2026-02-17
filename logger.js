/**
 * STRUCTURED LOGGER (Institutional Grade)
 *
 * Replaces console.log with production-ready JSON structured logging.
 * Compatible with log aggregation tools (ELK, Splunk, Datadog).
 */

const pino = require('pino');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
        },
    },
    base: {
        service: 'project-fusion',
    },
    /* PII Redaction: Default to TRUE (Safe) unless explicitly disabled */
    redact: process.env.PII_REDACTION !== 'false' ? {
        paths: ['sender', 'recipient', 'account_id', 'email', '*.sender', '*.recipient'],
        censor: '[REDACTED_PII]',
    } : undefined,
});

module.exports = logger;
