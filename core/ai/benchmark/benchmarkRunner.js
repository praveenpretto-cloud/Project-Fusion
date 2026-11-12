'use strict';

/**
 * Fusion Operations Intelligence — Performance Benchmark Runner
 *
 * Evaluates latency, token throughput, timeout rates, and grounding fidelity
 * across synthetic operational test cases without touching production data or external networks.
 */

const { SYNTHETIC_CASES } = require('./syntheticCases');
const { createModelProvider } = require('../providers');
const { InvestigationOrchestrator } = require('../orchestrator');

/**
 * Calculates percentile from an array of numbers.
 * @param {number[]} arr - Array of numerical values
 * @param {number} p - Percentile (0 to 100)
 * @returns {number}
 */
function calculatePercentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (upper === lower) return sorted[lower];
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Runs the benchmark suite across synthetic cases.
 *
 * @param {object} [options]
 * @param {string} [options.providerType='mock'] - 'mock' or 'ollama'
 * @param {string} [options.model] - Model name override
 * @param {number} [options.runs=1] - Runs per case
 * @param {string} [options.host] - Ollama host (loopback only)
 * @param {number} [options.timeoutMs=15000] - Request timeout
 * @param {string[]} [options.caseIds] - Optional subset of case IDs to benchmark
 * @returns {Promise<object>} Benchmark metrics summary
 */
async function runBenchmark(options = {}) {
    const providerType = options.providerType || 'mock';
    const runsPerCase = Math.max(1, parseInt(options.runs, 10) || 1);
    const model =
        options.model ||
        process.env.OLLAMA_MODEL ||
        (providerType === 'ollama' ? 'llama3.1:latest' : 'mock-model-v1');
    const host = options.host || 'http://127.0.0.1:11434';
    const timeoutMs = options.timeoutMs || 30000;

    const provider = createModelProvider(providerType, {
        host,
        defaultModel: model,
        timeoutMs,
    });

    const orchestrator = new InvestigationOrchestrator({
        modelProvider: provider,
        timeoutMs,
    });

    // Check provider availability
    const isAvailable = await provider.isAvailable();

    const casesToRun =
        options.caseIds && options.caseIds.length > 0
            ? SYNTHETIC_CASES.filter((c) => options.caseIds.includes(c.id))
            : SYNTHETIC_CASES;

    const results = [];
    const allLatencies = [];
    let coldStartLatency = null;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let timeoutsCount = 0;
    let errorsCount = 0;
    let successesCount = 0;

    const startTime = Date.now();

    for (const testCase of casesToRun) {
        const caseLatencies = [];
        let caseSuccesses = 0;
        let lastReport = null;

        // Configure mock provider behavior for adversarial or failure test cases if in mock mode
        if (providerType === 'mock' && testCase.forcedProviderStatus) {
            provider.setForcedStatus(testCase.forcedProviderStatus);
        } else if (providerType === 'mock') {
            provider.setForcedStatus('SUCCESS');
            const toolNames = Object.keys(testCase.evidence || {});
            const primaryTool = toolNames[0] || 'getTransactionTimeline';
            provider.setMockResponse({
                summary: `Investigation summary for ${testCase.transactionId}: ${testCase.groundedFinding}`,
                status: 'COMPLETED',
                confirmed_findings: [
                    {
                        claim: testCase.groundedFinding,
                        evidence_references: [primaryTool],
                        source_field: `${primaryTool}.status`,
                    },
                ],
                hypotheses: [],
                missing_information: [],
                recommended_checks: ['VERIFY_PROVIDER_STATUS'],
                evidence_references: toolNames.length > 0 ? toolNames : ['getTransactionTimeline'],
                limitations: ['Advisory decision support only. Human review required.'],
            });
        }

        for (let r = 0; r < runsPerCase; r++) {
            const runStart = Date.now();
            try {
                const outcome = await orchestrator.investigate({
                    transactionId: testCase.transactionId,
                    question: testCase.question,
                    explicitIntent: testCase.intent,
                    evidenceOverride: testCase.evidence || {},
                });

                const runLatency = Date.now() - runStart;
                caseLatencies.push(runLatency);
                allLatencies.push(runLatency);

                if (coldStartLatency === null) {
                    coldStartLatency = runLatency;
                }

                if (outcome.status === 'MODEL_TIMEOUT') {
                    timeoutsCount++;
                } else if (!outcome.success && outcome.status !== testCase.expectedStatus) {
                    errorsCount++;
                } else {
                    caseSuccesses++;
                    successesCount++;
                }

                if (outcome.report && outcome.report.model_metadata) {
                    const tokens = outcome.report.model_metadata.tokens || {};
                    totalPromptTokens += tokens.prompt_tokens || 0;
                    totalCompletionTokens += tokens.completion_tokens || 0;
                }

                lastReport = outcome;
            } catch {
                const runLatency = Date.now() - runStart;
                caseLatencies.push(runLatency);
                allLatencies.push(runLatency);
                errorsCount++;
            }
        }

        const avgCaseLatency = caseLatencies.reduce((a, b) => a + b, 0) / caseLatencies.length;
        results.push({
            caseId: testCase.id,
            title: testCase.title,
            intent: testCase.intent,
            expectedStatus: testCase.expectedStatus,
            runs: runsPerCase,
            successCount: caseSuccesses,
            avgLatencyMs: Math.round(avgCaseLatency),
            statusMatched: lastReport ? lastReport.status === testCase.expectedStatus : false,
        });
    }

    const totalDurationMs = Date.now() - startTime;
    const warmLatencies = allLatencies.slice(1);
    const avgWarmLatency =
        warmLatencies.length > 0
            ? warmLatencies.reduce((a, b) => a + b, 0) / warmLatencies.length
            : coldStartLatency || 0;

    const summary = {
        benchmarkTimestamp: new Date().toISOString(),
        configuration: {
            providerType,
            model,
            host: providerType === 'ollama' ? host : 'in-memory',
            runsPerCase,
            totalTestCases: casesToRun.length,
            totalInferences: casesToRun.length * runsPerCase,
            timeoutMs,
        },
        providerAvailable: isAvailable,
        latencyMetrics: {
            coldStartLatencyMs: coldStartLatency || 0,
            avgWarmLatencyMs: Math.round(avgWarmLatency),
            overallAvgLatencyMs: Math.round(
                allLatencies.reduce((a, b) => a + b, 0) / (allLatencies.length || 1)
            ),
            minLatencyMs: allLatencies.length > 0 ? Math.min(...allLatencies) : 0,
            maxLatencyMs: allLatencies.length > 0 ? Math.max(...allLatencies) : 0,
            p50Ms: Math.round(calculatePercentile(allLatencies, 50)),
            p90Ms: Math.round(calculatePercentile(allLatencies, 90)),
            p95Ms: Math.round(calculatePercentile(allLatencies, 95)),
        },
        tokenMetrics: {
            totalPromptTokens,
            totalCompletionTokens,
            totalTokens: totalPromptTokens + totalCompletionTokens,
            avgTokensPerRun: Math.round(
                (totalPromptTokens + totalCompletionTokens) / (allLatencies.length || 1)
            ),
        },
        reliabilityMetrics: {
            totalRuns: allLatencies.length,
            successes: successesCount,
            timeouts: timeoutsCount,
            errors: errorsCount,
            successRate: Number(((successesCount / (allLatencies.length || 1)) * 100).toFixed(2)),
            timeoutRate: Number(((timeoutsCount / (allLatencies.length || 1)) * 100).toFixed(2)),
            totalDurationMs,
        },
        caseResults: results,
    };

    return summary;
}

/**
 * CLI execution entrypoint.
 */
async function main() {
    const args = process.argv.slice(2);
    const options = {
        providerType: 'mock',
        runs: 1,
    };

    for (const arg of args) {
        if (arg.startsWith('--provider=')) {
            options.providerType = arg.split('=')[1];
        } else if (arg.startsWith('--runs=')) {
            options.runs = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--model=')) {
            options.model = arg.split('=')[1];
        } else if (arg.startsWith('--host=')) {
            options.host = arg.split('=')[1];
        } else if (arg.startsWith('--timeout=')) {
            options.timeoutMs = parseInt(arg.split('=')[1], 10);
        }
    }

    console.log(`================================================================`);
    console.log(`Fusion Operations Intelligence — Performance Benchmark`);
    console.log(`Provider: ${options.providerType} | Runs/Case: ${options.runs}`);
    console.log(`================================================================\n`);

    const summary = await runBenchmark(options);

    console.log(`Provider Available: ${summary.providerAvailable}`);
    console.log(`Total Cases Evaluated: ${summary.configuration.totalTestCases}`);
    console.log(`Total Inferences: ${summary.configuration.totalInferences}`);
    console.log(`Total Duration: ${summary.reliabilityMetrics.totalDurationMs} ms\n`);

    console.log(`--- Latency Profile ---`);
    console.log(`Cold Start Latency: ${summary.latencyMetrics.coldStartLatencyMs} ms`);
    console.log(`Average Warm Latency: ${summary.latencyMetrics.avgWarmLatencyMs} ms`);
    console.log(`P50 Latency: ${summary.latencyMetrics.p50Ms} ms`);
    console.log(`P90 Latency: ${summary.latencyMetrics.p90Ms} ms`);
    console.log(`P95 Latency: ${summary.latencyMetrics.p95Ms} ms`);
    console.log(
        `Min / Max: ${summary.latencyMetrics.minLatencyMs} ms / ${summary.latencyMetrics.maxLatencyMs} ms\n`
    );

    console.log(`--- Token & Reliability ---`);
    console.log(
        `Total Tokens: ${summary.tokenMetrics.totalTokens} (Prompt: ${summary.tokenMetrics.totalPromptTokens}, Completion: ${summary.tokenMetrics.totalCompletionTokens})`
    );
    console.log(`Success Rate: ${summary.reliabilityMetrics.successRate}%`);
    console.log(`Timeout Rate: ${summary.reliabilityMetrics.timeoutRate}%\n`);

    console.log(`--- Per-Case Breakdown ---`);
    console.table(
        summary.caseResults.map((r) => ({
            Case: r.caseId,
            Title: r.title,
            Intent: r.intent,
            AvgMs: r.avgLatencyMs,
            StatusMatched: r.statusMatched ? 'PASS' : 'FAIL',
        }))
    );

    return summary;
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Benchmark execution error:', err);
        process.exit(1);
    });
}

module.exports = {
    runBenchmark,
    calculatePercentile,
};
