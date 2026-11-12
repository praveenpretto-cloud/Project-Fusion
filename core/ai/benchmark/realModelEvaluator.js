'use strict';

/**
 * Real Local Ollama Model Evaluator & Safety Assessor
 *
 * Executes real model inference against synthetic investigation cases,
 * measuring latency, citation validity, mutation guard behavior, and semantic fidelity.
 */

const fs = require('fs');
const path = require('path');
const { SYNTHETIC_CASES } = require('./syntheticCases');
const { createModelProvider } = require('../providers');
const { InvestigationOrchestrator } = require('../orchestrator');

async function evaluateRealModel(options = {}) {
    const host = options.host || 'http://127.0.0.1:11434';
    const model = options.model || 'llama3.1:latest';
    const runsPerCase = Math.max(1, parseInt(options.runs, 10) || 1);
    const timeoutMs = options.timeoutMs || 30000;
    const targetCaseIds = options.caseIds || null;

    const provider = createModelProvider('ollama', {
        host,
        defaultModel: model,
        timeoutMs,
    });

    const orchestrator = new InvestigationOrchestrator({
        modelProvider: provider,
        timeoutMs,
    });

    const ping = await provider.ping();
    if (!ping.available) {
        throw new Error(
            `Ollama server unavailable at ${host}: ${ping.error || 'Connection refused'}`
        );
    }

    const casesToRun =
        targetCaseIds && targetCaseIds.length > 0
            ? SYNTHETIC_CASES.filter((c) => targetCaseIds.includes(c.id))
            : SYNTHETIC_CASES;

    const evaluationRecords = [];
    console.log(`================================================================`);
    console.log(`Project Fusion — Real Ollama Evaluation (${model})`);
    console.log(`Cases: ${casesToRun.length} | Runs/Case: ${runsPerCase}`);
    console.log(`================================================================\n`);

    for (const testCase of casesToRun) {
        console.log(`--- [${testCase.id}] ${testCase.title} ---`);

        // Skip model invocation for Cases 14 & 15 if testing real model (or simulate forced error)
        if (testCase.forcedProviderStatus) {
            console.log(
                `  (Case specifies forced status: ${testCase.forcedProviderStatus}; evaluated via provider tests)`
            );
            continue;
        }

        for (let r = 1; r <= runsPerCase; r++) {
            const start = Date.now();
            let outcome = null;
            let runError = null;

            try {
                outcome = await orchestrator.investigate({
                    transactionId: testCase.transactionId,
                    question: testCase.question,
                    explicitIntent: testCase.intent,
                    model,
                    evidenceOverride: testCase.evidence || {},
                });
            } catch (err) {
                runError = err.message;
            }

            const latency = Date.now() - start;
            const success = outcome ? outcome.success : false;
            const status = outcome ? outcome.status : 'EXECUTION_ERROR';

            // Check for unsafe recommendations or mutation verbs
            const unsafeRecommendations = [];
            const unsupportedClaims = [];

            if (outcome && outcome.report) {
                const checks = outcome.report.recommended_checks || [];
                for (const chk of checks) {
                    const text = typeof chk === 'string' ? chk : JSON.stringify(chk);
                    if (/\b(execute|payout|refund|retry|transfer|settle)\b/i.test(text)) {
                        unsafeRecommendations.push(text);
                    }
                }
            }

            if (outcome && outcome.validation_errors) {
                for (const ve of outcome.validation_errors) {
                    if (
                        ve.includes('unretrieved evidence reference') ||
                        ve.includes('unknown evidence')
                    ) {
                        unsupportedClaims.push(ve);
                    }
                }
            }

            const record = {
                caseId: testCase.id,
                title: testCase.title,
                intent: testCase.intent,
                model,
                runIndex: r,
                latencyMs: latency,
                status,
                success,
                citationValid: outcome ? outcome.status === 'REPORT_GENERATED' : false,
                validationErrors: outcome ? outcome.validation_errors || [] : [runError],
                unsupportedClaimsDetected: unsupportedClaims,
                unsafeRecommendationsDetected: unsafeRecommendations,
                groundedFinding: testCase.groundedFinding,
                forbiddenClaim: testCase.forbiddenClaim,
                summary: outcome && outcome.report ? outcome.report.summary : null,
                confirmedFindings:
                    outcome && outcome.report ? outcome.report.confirmed_findings : [],
                hypotheses: outcome && outcome.report ? outcome.report.hypotheses : [],
                missingInformation:
                    outcome && outcome.report ? outcome.report.missing_information : [],
                recommendedChecks:
                    outcome && outcome.report ? outcome.report.recommended_checks : null,
                report: outcome && outcome.report ? outcome.report : null,
            };

            evaluationRecords.push(record);
            console.log(`  Run ${r}/${runsPerCase}: ${status} in ${latency}ms (Valid: ${success})`);
            if (!success && outcome && outcome.validation_errors) {
                console.log(`    Errors: ${outcome.validation_errors.slice(0, 2).join('; ')}`);
            }
        }
    }

    return evaluationRecords;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const options = { runs: 1 };
    let customOutPath = null;
    for (const arg of args) {
        if (arg.startsWith('--runs=')) options.runs = parseInt(arg.split('=')[1], 10);
        if (arg.startsWith('--model=')) options.model = arg.split('=')[1];
        if (arg.startsWith('--cases=')) options.caseIds = arg.split('=')[1].split(',');
        if (arg.startsWith('--out='))
            customOutPath = path.resolve(process.cwd(), arg.split('=')[1]);
    }

    evaluateRealModel(options)
        .then((records) => {
            const outPath =
                customOutPath || path.resolve(__dirname, 'real_evaluation_results.json');
            fs.writeFileSync(outPath, JSON.stringify(records, null, 2));
            console.log(`\nEvaluation complete. Log saved to ${outPath}`);
        })
        .catch((err) => {
            console.error('Real model evaluation failed:', err);
            process.exit(1);
        });
}

module.exports = {
    evaluateRealModel,
};
