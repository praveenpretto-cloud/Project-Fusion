'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LOCAL TELEMETRY EXPORTER & SPAN COLLECTOR — PHASE AI-3.4
 * ════════════════════════════════════════════════════════════════════════════
 *
 * In-memory ring buffer collector and console/OTLP exporter.
 * Safe for local development, reproducible testing, and interview diagnostics.
 * Rejects non-loopback endpoints unless explicitly overridden.
 */

const { ExportResultCode } = require('@opentelemetry/core');

const DEFAULT_BUFFER_CAPACITY = 200;

class LocalInMemorySpanExporter {
    constructor(capacity = DEFAULT_BUFFER_CAPACITY) {
        this.capacity = capacity;
        this.spans = [];
        this._isShutdown = false;
    }

    export(spans, resultCallback) {
        if (this._isShutdown) {
            resultCallback({
                code: ExportResultCode.FAILED,
                error: new Error('Exporter has been shutdown'),
            });
            return;
        }

        for (const span of spans) {
            this.spans.push(span);
            if (this.spans.length > this.capacity) {
                this.spans.shift(); // Evict oldest
            }
        }

        resultCallback({ code: ExportResultCode.SUCCESS });
    }

    getFinishedSpans() {
        return [...this.spans];
    }

    getSpansByName(name) {
        return this.spans.filter((s) => s.name === name);
    }

    getSpansByTraceId(traceId) {
        return this.spans.filter((s) => s.spanContext().traceId === traceId);
    }

    reset() {
        this.spans = [];
    }

    shutdown() {
        this._isShutdown = true;
        this.spans = [];
        return Promise.resolve();
    }
}

/**
 * Validates that an OTLP endpoint is strictly a local loopback address.
 * Rejects external / cloud endpoints.
 *
 * @param {string} endpoint
 * @returns {boolean}
 */
function isLoopbackEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'string') return true;
    try {
        const url = new URL(endpoint.startsWith('http') ? endpoint : `http://${endpoint}`);
        const host = url.hostname.toLowerCase();
        return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
    } catch {
        return false;
    }
}

module.exports = {
    LocalInMemorySpanExporter,
    isLoopbackEndpoint,
};
