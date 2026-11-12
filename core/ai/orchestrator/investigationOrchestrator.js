'use strict';

const crypto = require('crypto');
const { IntentClassifier } = require('./intentClassifier');
const { PromptBuilder } = require('./promptBuilder');
const { EvidenceCitationValidator } = require('../validators/evidenceCitationValidator');
const { formatRecommendationDisplay } = require('../schemas/investigationReportSchema');
const defaultEvidenceTools = require('../evidence');
const { createModelProvider } = require('../providers');
const { createDlpContext } = require('../security/dlpMasker');

class InvestigationOrchestrator {
    /**
     * @param {object} [options]
     * @param {object} [options.dbClient] - Injected database query client
     * @param {object} [options.modelProvider] - Injected model provider instance
     * @param {object} [options.evidenceTools] - Injected evidence retrieval functions
     * @param {number} [options.timeoutMs=30000] - Model inference timeout
     */
    constructor(options = {}) {
        this.dbClient = options.dbClient || null;
        this.modelProvider = options.modelProvider || createModelProvider('ollama');
        this.evidenceTools = options.evidenceTools || defaultEvidenceTools;
        this.timeoutMs = options.timeoutMs || (this.modelProvider && this.modelProvider.timeoutMs) || 30000;
    }

    /**
     * Executes end-to-end deterministic investigation.
     * 
     * @param {object} params
     * @param {string} params.transactionId - Instruction UUID or invoice/saga identifier
     * @param {string} [params.question] - Operator question
     * @param {string} [params.explicitIntent] - Explicit intent override
     * @param {string} [params.model] - Model tag override
     * @param {object} [params.generationConfig] - Generation options
     * @returns {Promise<object>} Structured investigation outcome
     */
    async investigate({
        transactionId,
        question = '',
        explicitIntent = null,
        model = null,
        generationConfig = {},
        evidenceOverride = null,
        dlpContext = null
    }) {
        const startTime = Date.now();
        const investigationId = `INV-INTEL-${crypto.randomUUID()}`;
        const activeDlp = dlpContext || createDlpContext({ requestId: investigationId });

        if (!transactionId || typeof transactionId !== 'string' || !transactionId.trim()) {
            return {
                success: false,
                status: 'INVALID_PARAMETERS',
                investigation_id: investigationId,
                message: 'transactionId is required'
            };
        }

        const cleanTxId = transactionId.trim();

        // 1. Deterministic Intent Classification
        const classification = IntentClassifier.classify({
            explicitIntent,
            question,
            targetIdentifier: cleanTxId
        });

        if (classification.isClarificationRequired) {
            return {
                success: false,
                status: 'INTENT_CLARIFICATION_REQUIRED',
                investigation_id: investigationId,
                transaction_id: cleanTxId,
                reason: classification.reason
            };
        }

        const { intent, tools: authorizedTools } = classification;

        // 2. Dispatch Authorized Evidence Functions (or ingest synthetic override)
        const rawEvidence = {};
        const availableEvidenceKeys = new Set();
        const toolExecutionErrors = [];

        if (evidenceOverride && typeof evidenceOverride === 'object') {
            for (const [toolName, toolResult] of Object.entries(evidenceOverride)) {
                rawEvidence[toolName] = toolResult;
                availableEvidenceKeys.add(toolName);
                if (toolResult && typeof toolResult === 'object') {
                    for (const k of Object.keys(toolResult)) {
                        availableEvidenceKeys.add(`${toolName}.${k}`);
                        availableEvidenceKeys.add(`${toolName}:${k}`);
                    }
                    if (toolResult.data && typeof toolResult.data === 'object') {
                        for (const dk of Object.keys(toolResult.data)) {
                            availableEvidenceKeys.add(`${toolName}.data.${dk}`);
                            availableEvidenceKeys.add(`${toolName}:${dk}`);
                            availableEvidenceKeys.add(dk);
                        }
                    }
                    if (toolResult.timeline && typeof toolResult.timeline === 'object') {
                        for (const tk of Object.keys(toolResult.timeline)) {
                            availableEvidenceKeys.add(`${toolName}:${tk}`);
                            availableEvidenceKeys.add(tk);
                        }
                    }
                    if (toolResult.dimensions && typeof toolResult.dimensions === 'object') {
                        for (const dimKey of Object.keys(toolResult.dimensions)) {
                            availableEvidenceKeys.add(`dimensions:${dimKey}`);
                            availableEvidenceKeys.add(dimKey);
                        }
                    }
                }
            }
        } else {
            for (const toolName of authorizedTools) {
                const toolFn = this.evidenceTools[toolName];
                if (typeof toolFn !== 'function') {
                    toolExecutionErrors.push(`Tool '${toolName}' not found in evidence library`);
                    continue;
                }

                try {
                    // Ensure dbClient is provided for tools requiring DB access
                    let toolResult = null;
                    if (toolName === 'getSettlementAndWebhookEvidence') {
                        toolResult = await toolFn(this.dbClient, { instructionId: cleanTxId });
                    } else {
                        toolResult = await toolFn(this.dbClient, cleanTxId);
                    }

                    rawEvidence[toolName] = toolResult;

                    // Index available keys for citation validation
                    availableEvidenceKeys.add(toolName);
                    if (toolResult && typeof toolResult === 'object') {
                        for (const k of Object.keys(toolResult)) {
                            availableEvidenceKeys.add(`${toolName}.${k}`);
                            availableEvidenceKeys.add(`${toolName}:${k}`);
                        }
                        if (toolResult.data && typeof toolResult.data === 'object') {
                            for (const dk of Object.keys(toolResult.data)) {
                                availableEvidenceKeys.add(`${toolName}.data.${dk}`);
                                availableEvidenceKeys.add(`${toolName}:${dk}`);
                                availableEvidenceKeys.add(dk);
                            }
                        }
                        if (toolResult.timeline && typeof toolResult.timeline === 'object') {
                            for (const tk of Object.keys(toolResult.timeline)) {
                                availableEvidenceKeys.add(`${toolName}:${tk}`);
                                availableEvidenceKeys.add(tk);
                            }
                        }
                        if (toolResult.dimensions && typeof toolResult.dimensions === 'object') {
                            for (const dimKey of Object.keys(toolResult.dimensions)) {
                                availableEvidenceKeys.add(`dimensions:${dimKey}`);
                                availableEvidenceKeys.add(dimKey);
                            }
                        }
                    }
                } catch (toolErr) {
                    toolExecutionErrors.push(`Error executing ${toolName}: ${toolErr.message}`);
                    rawEvidence[toolName] = { success: false, error: toolErr.message };
                }
            }
        }

        // Add standard database identifier references to citation pool
        availableEvidenceKeys.add(`instructions:${cleanTxId}`);
        availableEvidenceKeys.add(`transaction:${cleanTxId}`);
        availableEvidenceKeys.add('instructions:state');
        availableEvidenceKeys.add('instructions:error_message');
        availableEvidenceKeys.add('instructions:provider');
        availableEvidenceKeys.add('reconciliation_log');
        availableEvidenceKeys.add('processed_webhook_events');
        availableEvidenceKeys.add('ledger_journal');

        // 3. Prompt Construction with Request-Scoped DLP Masking
        const maskedEvidence = activeDlp.maskObject(rawEvidence);
        const maskedQuestion = activeDlp.maskText(question);
        const promptContext = PromptBuilder.buildUserContent({
            investigationId,
            transactionId: cleanTxId,
            intent,
            rawEvidence: maskedEvidence,
            question: maskedQuestion
        });

        // 4. Model Provider Dispatch
        const providerResult = await this.modelProvider.generate({
            model,
            systemInstruction: promptContext.systemInstruction,
            evidenceContext: promptContext.evidenceContext,
            investigationQuestion: promptContext.investigationQuestion,
            generationConfig,
            timeoutMs: this.timeoutMs
        });

        // 5. Handle Provider Failures (Fail-Closed, zero heuristic fallback)
        if (providerResult.status !== 'SUCCESS') {
            return {
                success: false,
                status: providerResult.status,
                investigation_id: investigationId,
                transaction_id: cleanTxId,
                intent,
                error: providerResult.error,
                latency_ms: providerResult.latencyMs,
                raw_evidence: rawEvidence,
                message: `Inference failed with status ${providerResult.status}`
            };
        }

        // 6. Candidate Report Normalization & Enforcement
        const rawCandidate = providerResult.parsedResponse;
        if (!rawCandidate || typeof rawCandidate !== 'object') {
            return {
                success: false,
                status: 'MODEL_OUTPUT_INVALID',
                investigation_id: investigationId,
                transaction_id: cleanTxId,
                intent,
                error: 'Model parsed response is not an object',
                raw_evidence: maskedEvidence
            };
        }

        const candidateReport = activeDlp.maskObject(rawCandidate);

        // Inject authoritative backend metadata to prevent hallucinated IDs or intents
        candidateReport.investigation_id = investigationId;
        candidateReport.transaction_id = cleanTxId;
        candidateReport.intent = intent;
        candidateReport.status = candidateReport.status || 'COMPLETED';
        candidateReport.model_metadata = {
            provider: providerResult.metadata.provider || 'unknown',
            model: providerResult.metadata.model || 'unknown',
            latency_ms: providerResult.latencyMs,
            tokens: providerResult.metadata.tokens || {}
        };

        // Defensive normalization of optional string-or-null array fields
        if (candidateReport.limitations !== undefined && !Array.isArray(candidateReport.limitations)) {
            candidateReport.limitations = typeof candidateReport.limitations === 'string' && candidateReport.limitations.trim()
                ? [candidateReport.limitations.trim()]
                : [];
        }
        if (candidateReport.missing_information !== undefined && !Array.isArray(candidateReport.missing_information)) {
            candidateReport.missing_information = typeof candidateReport.missing_information === 'string' && candidateReport.missing_information.trim()
                ? [candidateReport.missing_information.trim()]
                : [];
        }

        // Deterministic mapping of exact recommendation codes to application display descriptions
        if (Array.isArray(candidateReport.recommended_checks)) {
            candidateReport.recommended_checks_display = candidateReport.recommended_checks.map(code => ({
                code,
                description: formatRecommendationDisplay(code) || 'Operational review required.'
            }));
        }

        // 7. Strict Evidence-Reference & Schema Validation
        const validation = EvidenceCitationValidator.validate({
            report: candidateReport,
            availableEvidenceKeys,
            rawEvidence
        });

        if (!validation.valid) {
            return {
                success: false,
                status: 'REPORT_VALIDATION_FAILED',
                investigation_id: investigationId,
                transaction_id: cleanTxId,
                intent,
                validation_errors: validation.errors,
                candidate_report: candidateReport,
                raw_evidence: rawEvidence,
                message: 'Generated report failed evidence citation or schema validation'
            };
        }

        return {
            success: true,
            status: 'REPORT_GENERATED',
            investigation_id: investigationId,
            transaction_id: cleanTxId,
            intent,
            report: candidateReport,
            warnings: validation.warnings,
            latency_ms: Date.now() - startTime,
            raw_evidence: maskedEvidence,
            dlp_audit: activeDlp.getAuditSummary()
        };
    }
}

module.exports = {
    InvestigationOrchestrator,
};
