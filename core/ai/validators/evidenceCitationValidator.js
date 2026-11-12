'use strict';

const { validateInvestigationReport } = require('../schemas/investigationReportSchema');
const { telemetry, SPAN_NAMES, FUSION_AI_ATTRIBUTES } = require('../observability');

/**
 * Evidence Reference and Citation Validator
 * 
 * Verifies that all citations in the generated report correspond to actual retrieved evidence.
 * Ensures strict schema adherence, validates hypothesis labeling, and rejects hallucinated IDs.
 */
class EvidenceCitationValidator {
    /**
     * @param {object} params
     * @param {object} params.report - The model-generated or candidate report
     * @param {string[]|Set<string>} params.availableEvidenceKeys - Set of valid evidence keys retrieved
     * @param {object} [params.rawEvidence] - Full evidence dataset
     * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
     */
    static validate({ report, availableEvidenceKeys = [], rawEvidence = {} }) {
        return telemetry.withSyncSpan(SPAN_NAMES.EVIDENCE_CITATION_VALIDATION, (span) => {
            span.setAttribute(FUSION_AI_ATTRIBUTES.VALIDATION_TYPE, 'evidence_citation');
            const errors = [];
            const warnings = [];

            // 1. Strict Schema Validation
            const schemaResult = validateInvestigationReport(report);
            if (!schemaResult.valid) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.VALIDATION_PASSED, false);
                span.setAttribute(FUSION_AI_ATTRIBUTES.VALIDATION_VIOLATION_COUNT, schemaResult.errors.length);
                return {
                    valid: false,
                    errors: schemaResult.errors,
                    warnings
                };
            }

            const validKeySet = availableEvidenceKeys instanceof Set 
                ? availableEvidenceKeys 
                : new Set(availableEvidenceKeys);

            // Also add keys from rawEvidence dynamically if available
            if (rawEvidence && typeof rawEvidence === 'object') {
                for (const key of Object.keys(rawEvidence)) {
                    validKeySet.add(key);
                    if (rawEvidence[key] && typeof rawEvidence[key] === 'object') {
                        for (const subKey of Object.keys(rawEvidence[key])) {
                            validKeySet.add(`${key}.${subKey}`);
                            validKeySet.add(`${key}:${subKey}`);
                        }
                    }
                }
            }

            // Detect resolved provider from rawEvidence if available for cross-provider verification
        let caseProvider = null;
        if (rawEvidence && typeof rawEvidence === 'object') {
            if (rawEvidence.getProviderFailureDetails?.data?.resolved_provider) {
                caseProvider = String(rawEvidence.getProviderFailureDetails.data.resolved_provider).toUpperCase();
            } else if (rawEvidence.getTransactionTimeline?.timeline?.provider) {
                caseProvider = String(rawEvidence.getTransactionTimeline.timeline.provider).toUpperCase();
            }
        }

        // 2. Validate Confirmed Findings Citations
        if (Array.isArray(report.confirmed_findings)) {
            report.confirmed_findings.forEach((finding, idx) => {
                if (!finding.evidence_references || finding.evidence_references.length === 0) {
                    errors.push(`Finding ${idx + 1} ('${finding.claim.substring(0, 30)}...') has no evidence references.`);
                    return;
                }

                for (const ref of finding.evidence_references) {
                    const cleanRef = String(ref).trim();

                    // Documentation Evidence Citation (docs:...)
                    if (cleanRef.startsWith('docs:')) {
                        const exists = validKeySet.has(cleanRef);
                        if (!exists) {
                            errors.push(`Finding ${idx + 1} cites unretrieved or fabricated documentation citation: '${cleanRef}'.`);
                            continue;
                        }

                        // Cross-provider citation check
                        const parts = cleanRef.split(':');
                        const docProvider = parts[1]?.toUpperCase();
                        if (caseProvider && docProvider && docProvider !== 'PROJECT_FUSION' && docProvider !== 'ISO20022') {
                            const normalizedCase = caseProvider.replace(/[^A-Z]/g, '');
                            const normalizedDoc = docProvider.replace(/[^A-Z]/g, '');
                            if (!normalizedCase.includes(normalizedDoc) && !normalizedDoc.includes(normalizedCase)) {
                                errors.push(`Finding ${idx + 1} cites documentation from provider '${docProvider}' which does not match case target provider '${caseProvider}'.`);
                            }
                        }
                        continue;
                    }

                    // Operational Evidence Citation
                    const exists = validKeySet.has(cleanRef) || 
                        Array.from(validKeySet).some(k => k.startsWith(cleanRef) || cleanRef.startsWith(k));

                    if (!exists && validKeySet.size > 0) {
                        errors.push(`Finding ${idx + 1} cites unknown or unretrieved evidence reference: '${cleanRef}'.`);
                    }
                }

                // Check source_field existence if present
                if (finding.source_field && validKeySet.size > 0) {
                    const sourceField = String(finding.source_field).trim();
                    const hasField = validKeySet.has(sourceField) || 
                        Array.from(validKeySet).some(k => k.includes(sourceField) || sourceField.includes(k));
                    if (!hasField) {
                        warnings.push(`Finding ${idx + 1} cites source_field '${sourceField}' which does not appear in retrieved evidence metadata.`);
                    }
                }
            });
        }

        // 3. Validate Hypotheses Labeling
        if (Array.isArray(report.hypotheses)) {
            report.hypotheses.forEach((hypo, idx) => {
                const text = hypo.hypothesis ? hypo.hypothesis.trim() : '';
                const hasHypothesisLabel = /\b(hypothesis|may|might|possible|potential|unconfirmed|suspected|indicates)\b/i.test(text);
                if (!hasHypothesisLabel) {
                    errors.push(`Hypothesis ${idx + 1} must be explicitly framed with tentative/hypothetical phrasing (e.g. 'Possible...', 'May indicate...'). Got: '${text.substring(0, 50)}...'`);
                }

                if (!Array.isArray(hypo.supporting_evidence) || !Array.isArray(hypo.missing_evidence)) {
                    errors.push(`Hypothesis ${idx + 1} must explicitly specify supporting_evidence and missing_evidence arrays.`);
                }
            });
        }

        // 4. Missing Information Grounding
        // Ensure missing evidence is not claimed as verified fact in findings
        if (Array.isArray(report.missing_information) && Array.isArray(report.confirmed_findings)) {
            for (const missing of report.missing_information) {
                const missingLower = missing.toLowerCase();
                if (missingLower.includes('tax') || missingLower.includes('tax_withheld')) {
                    const contradictoryFinding = report.confirmed_findings.find(f => 
                        f.claim.toLowerCase().includes('tax is verified') || 
                        f.claim.toLowerCase().includes('tax verified')
                    );
                    if (contradictoryFinding) {
                        errors.push(`Contradiction: report claims '${contradictoryFinding.claim}' while reporting tax information as missing.`);
                    }
                }
                if (missingLower.includes('webhook') || missingLower.includes('duplicate')) {
                    const contradictoryFinding = report.confirmed_findings.find(f => 
                        f.claim.toLowerCase().includes('duplicate count verified')
                    );
                    if (contradictoryFinding) {
                        errors.push('Contradiction: duplicate delivery count cannot be confirmed when PostgreSQL drop policy drops duplicates.');
                    }
                }
            }
        }

        const valid = errors.length === 0;
        span.setAttribute(FUSION_AI_ATTRIBUTES.VALIDATION_PASSED, valid);
        span.setAttribute(FUSION_AI_ATTRIBUTES.VALIDATION_VIOLATION_COUNT, errors.length);

        return {
            valid,
            errors,
            warnings
        };
        });
    }
}

module.exports = {
    EvidenceCitationValidator,
};

