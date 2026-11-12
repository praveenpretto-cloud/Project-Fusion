'use strict';

const { telemetry, TelemetryService } = require('./telemetryService');
const {
    SEMCONV_VERSION,
    GEN_AI_ATTRIBUTES,
    FUSION_AI_ATTRIBUTES,
    METRIC_NAMES,
    SPAN_NAMES,
    ALLOWED_MODEL_LABELS,
    ALLOWED_TOOL_LABELS,
    ERROR_CLASSIFICATIONS,
    classifyError,
} = require('./telemetryConstants');
const { LocalInMemorySpanExporter, isLoopbackEndpoint } = require('./localExporter');
const { MetricsAggregator } = require('./metricsRegistry');

module.exports = {
    telemetry,
    TelemetryService,
    SEMCONV_VERSION,
    GEN_AI_ATTRIBUTES,
    FUSION_AI_ATTRIBUTES,
    METRIC_NAMES,
    SPAN_NAMES,
    ALLOWED_MODEL_LABELS,
    ALLOWED_TOOL_LABELS,
    ERROR_CLASSIFICATIONS,
    classifyError,
    LocalInMemorySpanExporter,
    isLoopbackEndpoint,
    MetricsAggregator,
};
