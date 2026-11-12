'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LOCAL METRICS REGISTRY & AGGREGATOR — PHASE AI-3.4
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * In-process metrics storage for counters, histograms, and gauges.
 * Computes min, max, median, p90, p95, p99 without database or cloud dependencies.
 * Powers the local developer metrics endpoint GET /api/ai/observability/metrics.
 */

class MetricsAggregator {
    constructor() {
        this.counters = new Map(); // name:labelKey -> number
        this.histograms = new Map(); // name:labelKey -> number[]
        this.gauges = new Map(); // name:labelKey -> number
        this.totalCounts = new Map(); // name -> number
    }

    _makeKey(labels = {}) {
        const sorted = Object.keys(labels).sort();
        if (sorted.length === 0) return '_default';
        return sorted.map(k => `${k}=${labels[k]}`).join(',');
    }

    incrementCounter(name, value = 1, labels = {}) {
        const labelKey = this._makeKey(labels);
        const mapKey = `${name}::${labelKey}`;
        this.counters.set(mapKey, (this.counters.get(mapKey) || 0) + value);
        this.totalCounts.set(name, (this.totalCounts.get(name) || 0) + value);
    }

    recordHistogram(name, value, labels = {}) {
        const labelKey = this._makeKey(labels);
        const mapKey = `${name}::${labelKey}`;
        if (!this.histograms.has(mapKey)) {
            this.histograms.set(mapKey, []);
        }
        const values = this.histograms.get(mapKey);
        values.push(value);
        if (values.length > 1000) {
            values.shift(); // Bound memory to last 1000 observations
        }

        // Global histogram track
        const globalMapKey = `${name}::_global`;
        if (!this.histograms.has(globalMapKey)) {
            this.histograms.set(globalMapKey, []);
        }
        const globalValues = this.histograms.get(globalMapKey);
        globalValues.push(value);
        if (globalValues.length > 2000) {
            globalValues.shift();
        }
    }

    setGauge(name, value, labels = {}) {
        const labelKey = this._makeKey(labels);
        const mapKey = `${name}::${labelKey}`;
        this.gauges.set(mapKey, value);
    }

    getStats(name) {
        const values = this.histograms.get(`${name}::_global`) || [];
        if (values.length === 0) {
            return { count: 0, min: 0, max: 0, median: 0, p90: 0, p95: 0, p99: 0, mean: 0 };
        }

        const sorted = [...values].sort((a, b) => a - b);
        const count = sorted.length;
        const sum = sorted.reduce((acc, v) => acc + v, 0);
        const mean = Math.round((sum / count) * 10) / 10;

        const percentile = (p) => {
            const idx = Math.min(Math.floor((p / 100) * count), count - 1);
            return Math.round(sorted[idx] * 10) / 10;
        };

        return {
            count,
            min: Math.round(sorted[0] * 10) / 10,
            max: Math.round(sorted[count - 1] * 10) / 10,
            median: percentile(50),
            p90: percentile(90),
            p95: percentile(95),
            p99: percentile(99),
            mean
        };
    }

    getCounterTotal(name) {
        return this.totalCounts.get(name) || 0;
    }

    getCountersByPrefix(prefix) {
        const result = {};
        for (const [key, val] of this.counters.entries()) {
            if (key.startsWith(prefix)) {
                result[key] = val;
            }
        }
        return result;
    }

    getSummary() {
        return {
            timestamp: new Date().toISOString(),
            investigations: {
                total: this.getCounterTotal('fusion.ai.investigations.total'),
                failures: this.getCounterTotal('fusion.ai.investigation.failures'),
                active: this.gauges.get('fusion.ai.investigation.active::_default') || 0,
                duration_ms: this.getStats('fusion.ai.investigation.duration'),
            },
            models: {
                requests: this.getCounterTotal('fusion.ai.model.requests'),
                timeouts: this.getCounterTotal('fusion.ai.model.timeouts'),
                errors: this.getCounterTotal('fusion.ai.model.errors'),
                input_tokens: this.getCounterTotal('fusion.ai.model.input_tokens'),
                output_tokens: this.getCounterTotal('fusion.ai.model.output_tokens'),
                duration_ms: this.getStats('fusion.ai.model.duration'),
            },
            agent: {
                rounds: this.getCounterTotal('fusion.ai.agent.rounds'),
                tool_calls: this.getCounterTotal('fusion.ai.agent.tool_calls'),
                repeated_tool_calls: this.getCounterTotal('fusion.ai.agent.repeated_tool_calls'),
                refusals: this.getCounterTotal('fusion.ai.agent.refusals'),
                validation_failures: this.getCounterTotal('fusion.ai.agent.validation_failures'),
            },
            rag: {
                retrieval_duration_ms: this.getStats('fusion.ai.rag.retrieval.duration'),
                embedding_duration_ms: this.getStats('fusion.ai.rag.embedding.duration'),
                chunks_returned: this.getCounterTotal('fusion.ai.rag.chunks.returned'),
                abstentions: this.getCounterTotal('fusion.ai.rag.abstentions'),
                citation_failures: this.getCounterTotal('fusion.ai.rag.citation_failures'),
            },
            dlp: {
                redactions: this.getCounterTotal('fusion.ai.dlp.redactions'),
                duration_ms: this.getStats('fusion.ai.dlp.duration'),
                detection_failures: this.getCounterTotal('fusion.ai.dlp.detection_failures'),
            }
        };
    }

    reset() {
        this.counters.clear();
        this.histograms.clear();
        this.gauges.clear();
        this.totalCounts.clear();
    }
}

module.exports = {
    MetricsAggregator,
};

