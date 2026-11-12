'use strict';

const { KnowledgeIndexer } = require('../ingestion/knowledgeIndexer');

/**
 * 25 Curated Golden Evaluation Cases for Project Fusion RAG Subsystem
 * 
 * Tests exact error-code lookups, natural-language semantic paraphrases,
 * similar error codes, event semantics, standards requirements,
 * cross-provider ambiguity, out-of-vocabulary codes, and prompt injection.
 */
const RAG_BENCHMARK_CASES = [
    // ── 1. EXACT TECHNICAL ERROR CODES ──────────────────────────────────────
    {
        id: 'RAG-01',
        title: 'Stripe balance_insufficient exact error-code lookup',
        query: 'What does error balance_insufficient mean on Stripe payouts?',
        provider: 'STRIPE',
        error_code: 'balance_insufficient',
        expectedChunkIds: ['docs:stripe:doc-stripe-002:chunk-002'],
        expectedKeyTerms: ['balance_insufficient', 'merchant Stripe balance', 'liquidity'],
        category: 'EXACT_ERROR_CODE'
    },
    {
        id: 'RAG-02',
        title: 'Stripe card_declined issuer failure lookup',
        query: 'Why was the payment declined with card_declined?',
        provider: 'STRIPE',
        error_code: 'card_declined',
        expectedChunkIds: ['docs:stripe:doc-stripe-002:chunk-001'],
        expectedKeyTerms: ['card_declined', 'issuer', 'fraud prevention'],
        category: 'EXACT_ERROR_CODE'
    },
    {
        id: 'RAG-03',
        title: 'RazorpayX business_account_low_balance payout failure',
        query: 'Why did the payout fail with business_account_low_balance on RazorpayX?',
        provider: 'RAZORPAY',
        error_code: 'business_account_low_balance',
        expectedChunkIds: ['docs:razorpay:doc-razorpay-002:chunk-001'],
        expectedKeyTerms: ['BAD_REQUEST_ERROR', 'business_account_low_balance', 'virtual account'],
        category: 'EXACT_ERROR_CODE'
    },
    {
        id: 'RAG-04',
        title: 'Stellar tx_insufficient_balance transaction result',
        query: 'What causes tx_insufficient_balance on Stellar Horizon submission?',
        provider: 'STELLAR',
        error_code: 'tx_insufficient_balance',
        expectedChunkIds: ['docs:stellar:doc-stellar-002:chunk-001'],
        expectedKeyTerms: ['tx_insufficient_balance', 'fee bid', 'native XLM'],
        category: 'EXACT_ERROR_CODE'
    },
    {
        id: 'RAG-05',
        title: 'Stellar op_underfunded operation result',
        query: 'Explain op_underfunded payment operation error on Stellar.',
        provider: 'STELLAR',
        error_code: 'op_underfunded',
        expectedChunkIds: ['docs:stellar:doc-stellar-002:chunk-002'],
        expectedKeyTerms: ['op_underfunded', 'source account', 'reserve requirements'],
        category: 'EXACT_ERROR_CODE'
    },
    {
        id: 'RAG-06',
        title: 'Project Fusion POSTING_ARITHMETIC_MISMATCH ledger balance',
        query: 'What causes POSTING_ARITHMETIC_MISMATCH on ledger balance audit?',
        provider: 'PROJECT_FUSION',
        error_code: 'POSTING_ARITHMETIC_MISMATCH',
        expectedChunkIds: ['docs:projectfusion:doc-fusion-002:chunk-001'],
        expectedKeyTerms: ['POSTING_ARITHMETIC_MISMATCH', 'ARITHMETIC_EQUALITY_FAILED', 'Debits Equal Credits'],
        category: 'EXACT_ERROR_CODE'
    },

    // ── 2. NATURAL LANGUAGE SEMANTIC PARAPHRASES (NO TECHNICAL JARGON) ────────
    {
        id: 'RAG-07',
        title: 'Paraphrase: Bank account lacked sufficient funds for payout',
        query: 'The bank account did not have enough funds to send the payout.',
        provider: 'STRIPE',
        expectedChunkIds: ['docs:stripe:doc-stripe-002:chunk-002', 'docs:stripe:doc-stripe-002:chunk-001'],
        expectedKeyTerms: ['balance_insufficient', 'liquidity', 'balance'],
        category: 'SEMANTIC_PARAPHRASE'
    },
    {
        id: 'RAG-08',
        title: 'Paraphrase: Blockchain rejected outdated sequence number',
        query: 'The blockchain rejected a transaction because its sequence number was outdated.',
        provider: 'STELLAR',
        expectedChunkIds: ['docs:stellar:doc-stellar-001:chunk-002', 'docs:stellar:doc-stellar-002:chunk-001'],
        expectedKeyTerms: ['sequence number', 'tx_bad_seq', 'ledger'],
        category: 'SEMANTIC_PARAPHRASE'
    },
    {
        id: 'RAG-09',
        title: 'Paraphrase: Payment message failed due to unstructured recipient address',
        query: 'The payment message failed because the recipient address was not structured correctly.',
        provider: 'ISO20022',
        expectedChunkIds: ['docs:iso20022:doc-iso20022-001:chunk-002'],
        expectedKeyTerms: ['Structured Address', 'AdrLine', 'TwnNm', 'Ctry'],
        category: 'SEMANTIC_PARAPHRASE'
    },
    {
        id: 'RAG-10',
        title: 'Paraphrase: Card payment blocked because credentials past valid date',
        query: 'Why was the customer card transaction refused due to an invalid calendar date?',
        provider: 'STRIPE',
        expectedChunkIds: ['docs:stripe:doc-stripe-002:chunk-001'],
        expectedKeyTerms: ['expired_card', 'expiration month'],
        category: 'SEMANTIC_PARAPHRASE'
    },

    // ── 3. SIMILAR ERROR CODES & PRODUCT DISTINCTIONS ───────────────────────
    {
        id: 'RAG-11',
        title: 'Similar Codes: Stripe card_declined vs balance_insufficient distinction',
        query: 'How does a customer card decline differ from an insufficient merchant account balance on Stripe?',
        provider: 'STRIPE',
        expectedChunkIds: ['docs:stripe:doc-stripe-002:chunk-001', 'docs:stripe:doc-stripe-002:chunk-002'],
        expectedKeyTerms: ['card_declined', 'balance_insufficient', 'merchant Stripe balance'],
        category: 'SIMILAR_ERROR_CODES'
    },
    {
        id: 'RAG-12',
        title: 'Similar Codes: Stellar tx_insufficient_balance vs op_underfunded',
        query: 'What is the technical difference between tx_insufficient_balance and op_underfunded on Stellar?',
        provider: 'STELLAR',
        expectedChunkIds: ['docs:stellar:doc-stellar-002:chunk-001', 'docs:stellar:doc-stellar-002:chunk-002'],
        expectedKeyTerms: ['tx_insufficient_balance', 'fee bid', 'op_underfunded', 'reserve requirements'],
        category: 'SIMILAR_ERROR_CODES'
    },
    {
        id: 'RAG-13',
        title: 'Similar Codes: Razorpay payout reversal vs merchant customer refund',
        query: 'What distinguishes an automated payout reversal from a customer refund on RazorpayX?',
        provider: 'RAZORPAY',
        expectedChunkIds: ['docs:razorpay:doc-razorpay-002:chunk-002'],
        expectedKeyTerms: ['payout.reversed', 'reversals', 'refunds'],
        category: 'SIMILAR_ERROR_CODES'
    },

    // ── 4. EVENT SEMANTICS & WEBHOOK IDEMPOTENCY ───────────────────────────
    {
        id: 'RAG-14',
        title: 'Stripe refund state transition webhook events',
        query: 'What webhook event notifies when a refund status transitions on Stripe?',
        provider: 'STRIPE',
        expectedChunkIds: ['docs:stripe:doc-stripe-003:chunk-002'],
        expectedKeyTerms: ['charge.refund.updated', 'charge.refunded', 'webhook'],
        category: 'EVENT_SEMANTICS'
    },
    {
        id: 'RAG-15',
        title: 'Stripe webhook HMAC signature and idempotent storage',
        query: 'How does Stripe handle webhook signature verification and duplicate event delivery?',
        provider: 'STRIPE',
        expectedChunkIds: ['docs:stripe:doc-stripe-003:chunk-003'],
        expectedKeyTerms: ['Stripe-Signature', 'HMAC-SHA256', 'ON CONFLICT DO NOTHING'],
        category: 'IDEMPOTENCY_SECURITY'
    },
    {
        id: 'RAG-16',
        title: 'Stellar Horizon 504 Gateway Timeout recovery protocol',
        query: 'What is the operational protocol when Horizon returns HTTP 504 Gateway Timeout?',
        provider: 'STELLAR',
        expectedChunkIds: ['docs:stellar:doc-stellar-002:chunk-003'],
        expectedKeyTerms: ['504 Gateway Timeout', 'ledger inclusion', 'transaction hash'],
        category: 'GATEWAY_TIMEOUT'
    },

    // ── 5. STANDARDS MANDATES & VERSION DISTINCTIONS ───────────────────────
    {
        id: 'RAG-17',
        title: 'ISO 20022 SWIFT CBPR+ town name and country baseline vs local schema',
        query: 'What are the minimum mandatory postal address requirements under SWIFT CBPR+ versus local clearing schemas?',
        provider: 'ISO20022',
        expectedChunkIds: ['docs:iso20022:doc-iso20022-001:chunk-002'],
        expectedKeyTerms: ['TwnNm', 'Ctry', 'CBPR+ Baseline', 'market infrastructure'],
        category: 'STANDARDS_MANDATE'
    },
    {
        id: 'RAG-18',
        title: 'ISO 20022 syntax error vs financial crime / AML violation',
        query: 'Is an XML schema validation failure on ISO 20022 address proof of sanctions violation?',
        provider: 'ISO20022',
        expectedChunkIds: ['docs:iso20022:doc-iso20022-001:chunk-002'],
        expectedKeyTerms: ['Syntactic Formatting vs Regulatory Non-Compliance', 'schema validation', 'not evidence of legal'],
        category: 'COMPLIANCE_DISTINCTION'
    },
    {
        id: 'RAG-19',
        title: 'ISO 20022 camt.053 balance reporting elements',
        query: 'What elements in camt.053 represent opening and closing balances?',
        provider: 'ISO20022',
        expectedChunkIds: ['docs:iso20022:doc-iso20022-002:chunk-001'],
        expectedKeyTerms: ['camt.053', 'OPBD', 'CLBD'],
        category: 'MESSAGE_SPEC'
    },

    // ── 6. CROSS-PROVIDER AMBIGUITY & ARCHITECTURE ─────────────────────────
    {
        id: 'RAG-20',
        title: 'Cross-rail ambiguous insufficient balance query',
        query: 'Insufficient balance available to disburse payment funds',
        provider: 'ALL',
        expectedChunkIds: [
            'docs:stripe:doc-stripe-002:chunk-002',
            'docs:razorpay:doc-razorpay-002:chunk-001',
            'docs:stellar:doc-stellar-002:chunk-001'
        ],
        expectedKeyTerms: ['balance', 'insufficient'],
        category: 'CROSS_PROVIDER_AMBIGUITY'
    },
    {
        id: 'RAG-21',
        title: 'Project Fusion MANUAL_CHECK state machine rules',
        query: 'When does Project Fusion transition a payment to MANUAL_CHECK state?',
        provider: 'PROJECT_FUSION',
        expectedChunkIds: ['docs:projectfusion:doc-fusion-001:chunk-001'],
        expectedKeyTerms: ['MANUAL_CHECK', 'ambiguous gateway outcome', '504 Gateway Timeout'],
        category: 'INTERNAL_ARCHITECTURE'
    },

    // ── 7. PROMPT INJECTION RESISTANCE ─────────────────────────────────────
    {
        id: 'RAG-22',
        title: 'Prompt injection containment inside dispute documentation',
        query: 'What are the guidelines for dispute counterparty notes containing system overrides?',
        provider: 'STRIPE',
        expectedChunkIds: ['docs:stripe:doc-stripe-004:chunk-001'],
        expectedKeyTerms: ['untrusted counterparty text', 'passive data strings', 'never override'],
        category: 'PROMPT_INJECTION_CONTAINMENT'
    },

    // ── 8. ABSTENTION & NO-MATCH NEGATIVE CONTROLS ─────────────────────────
    {
        id: 'RAG-23',
        title: 'Unknown error code abstention test',
        query: 'Explain gateway error err_nonexistent_code_99999',
        provider: 'STRIPE',
        error_code: 'err_nonexistent_code_99999',
        expectedChunkIds: [], // Abstention: expect zero matches
        expectedKeyTerms: [],
        category: 'UNKNOWN_ERROR_CODE'
    },
    {
        id: 'RAG-24',
        title: 'Unrelated out-of-domain query with no relevant documents',
        query: 'Culinary recipe for baking sourdough bread with artisanal yeast',
        provider: 'ALL',
        expectedChunkIds: [], // Abstention: expect zero matches
        expectedKeyTerms: [],
        category: 'NO_RELEVANT_DOCUMENT'
    },
    {
        id: 'RAG-25',
        title: 'Nonexistent payment rail abstention test',
        query: 'Klarna pay later installment checkout session and settlement webhooks',
        provider: 'KLARNA',
        expectedChunkIds: [], // Abstention: Klarna is not an integrated rail
        expectedKeyTerms: [],
        category: 'OUTDATED_OR_UNSUPPORTED'
    }
];

class RAGEvaluationRunner {
    constructor(indexer = null) {
        this.indexer = indexer || new KnowledgeIndexer();
    }

    async init() {
        if (!this.indexer.isIndexed) {
            await this.indexer.buildIndex();
        }
        return this;
    }

    /**
     * Evaluates a single benchmark case under a specific retrieval mode.
     * 
     * @param {object} testCase 
     * @param {'BM25'|'DENSE'|'HYBRID'} [mode='HYBRID']
     */
    async evaluateCase(testCase, mode = 'HYBRID') {
        if (!this.indexer.isIndexed) {
            await this.indexer.buildIndex();
        }

        const start = Date.now();
        let results = [];

        if (mode === 'BM25') {
            results = this.indexer.bm25Retriever.search(testCase.query, {
                provider: testCase.provider,
                error_code: testCase.error_code,
                topK: 5
            });
        } else if (mode === 'DENSE') {
            results = await this.indexer.denseRetriever.search(testCase.query, {
                provider: testCase.provider,
                error_code: testCase.error_code,
                topK: 5
            });
        } else {
            results = await this.indexer.search(testCase.query, {
                provider: testCase.provider,
                error_code: testCase.error_code,
                topK: 5
            });
        }

        const durationMs = Date.now() - start;
        const retrievedChunkIds = results.map(r => r.chunk.chunk_id);
        const top3ChunkIds = retrievedChunkIds.slice(0, 3);
        const top5ChunkIds = retrievedChunkIds.slice(0, 5);

        const isAbstentionCase = testCase.expectedChunkIds.length === 0;

        let precisionAt3 = null;
        let recallAt5 = null;
        let reciprocalRank = null;
        let abstentionSuccess = null;
        let exactCodeMatchAcc = null;

        if (isAbstentionCase) {
            // Strict abstention metric: 1.0 if zero results returned; 0.0 if hallucinated false matches
            abstentionSuccess = results.length === 0 ? 1.0 : 0.0;
        } else {
            // Precision@3
            const matchesInTop3 = top3ChunkIds.filter(id => testCase.expectedChunkIds.includes(id)).length;
            precisionAt3 = matchesInTop3 / Math.min(3, testCase.expectedChunkIds.length);

            // Recall@5
            const matchesInTop5 = testCase.expectedChunkIds.filter(id => top5ChunkIds.includes(id)).length;
            recallAt5 = matchesInTop5 / testCase.expectedChunkIds.length;

            // Reciprocal Rank (RR)
            reciprocalRank = 0;
            for (let i = 0; i < retrievedChunkIds.length; i++) {
                if (testCase.expectedChunkIds.includes(retrievedChunkIds[i])) {
                    reciprocalRank = 1 / (i + 1);
                    break;
                }
            }

            // Exact Error-Code Match Accuracy
            if (testCase.error_code) {
                exactCodeMatchAcc = (retrievedChunkIds[0] && testCase.expectedChunkIds.includes(retrievedChunkIds[0])) ? 1.0 : 0.0;
            }
        }

        // Key terms verification in top result
        const topResult = results[0];
        let termCoverage = 1.0;
        if (testCase.expectedKeyTerms.length > 0 && topResult) {
            const contentLower = `${topResult.chunk.title} ${topResult.chunk.section} ${topResult.chunk.content}`.toLowerCase();
            const matchedTerms = testCase.expectedKeyTerms.filter(t => contentLower.includes(t.toLowerCase())).length;
            termCoverage = matchedTerms / testCase.expectedKeyTerms.length;
        }

        const passed = isAbstentionCase 
            ? (abstentionSuccess === 1.0)
            : (precisionAt3 > 0);

        return {
            id: testCase.id,
            caseId: testCase.id,
            title: testCase.title,
            category: testCase.category,
            query: testCase.query,
            provider: testCase.provider,
            error_code: testCase.error_code || null,
            mode,
            durationMs,
            retrievedCount: results.length,
            isAbstentionCase,
            topResult: topResult ? {
                chunk_id: topResult.chunk.chunk_id,
                score: topResult.score,
                match_type: topResult.match_type
            } : null,
            precisionAt3: precisionAt3 !== null ? Number(precisionAt3.toFixed(3)) : null,
            recallAt5: recallAt5 !== null ? Number(recallAt5.toFixed(3)) : null,
            reciprocalRank: reciprocalRank !== null ? Number(reciprocalRank.toFixed(3)) : null,
            abstentionSuccess,
            exactCodeMatchAcc,
            termCoverage: Number(termCoverage.toFixed(3)),
            passed
        };
    }

    /**
     * Runs all benchmark cases for a given retrieval mode.
     * 
     * @param {'BM25'|'DENSE'|'HYBRID'} [mode='HYBRID']
     */
    async runAll(mode = 'HYBRID') {
        const results = [];
        for (const testCase of RAG_BENCHMARK_CASES) {
            const res = await this.evaluateCase(testCase, mode);
            results.push(res);
        }

        const totalCases = results.length;
        const passedCases = results.filter(r => r.passed).length;
        
        // Denominator separation: Only positive expectation cases contribute to Precision, Recall, and MRR
        const positiveCases = results.filter(r => !r.isAbstentionCase);
        const abstentionCases = results.filter(r => r.isAbstentionCase);

        const meanP3 = positiveCases.length > 0
            ? Number((positiveCases.reduce((acc, r) => acc + (r.precisionAt3 || 0), 0) / positiveCases.length).toFixed(3))
            : 0;

        const meanR5 = positiveCases.length > 0
            ? Number((positiveCases.reduce((acc, r) => acc + (r.recallAt5 || 0), 0) / positiveCases.length).toFixed(3))
            : 0;

        const mrr = positiveCases.length > 0
            ? Number((positiveCases.reduce((acc, r) => acc + (r.reciprocalRank || 0), 0) / positiveCases.length).toFixed(3))
            : 0;

        // Abstention accuracy
        const abstentionVal = abstentionCases.length > 0
            ? (abstentionCases.reduce((acc, r) => acc + (r.abstentionSuccess || 0), 0) / abstentionCases.length) * 100
            : 100.0;

        // Exact code match accuracy
        const exactCases = results.filter(r => r.exactCodeMatchAcc !== null);
        const exactVal = exactCases.length > 0
            ? (exactCases.reduce((acc, r) => acc + r.exactCodeMatchAcc, 0) / exactCases.length) * 100
            : 100.0;

        const latencies = results.map(r => r.durationMs).sort((a, b) => a - b);
        const medianLatency = latencies[Math.floor(latencies.length / 2)];
        const p95Latency = latencies[Math.min(Math.ceil(0.95 * latencies.length) - 1, latencies.length - 1)];

        return {
            mode,
            totalCases,
            positiveCasesCount: positiveCases.length,
            abstentionCasesCount: abstentionCases.length,
            passedCases,
            passRate: `${((passedCases / totalCases) * 100).toFixed(1)}%`,
            meanPrecisionAt3: meanP3,
            meanRecallAt5: meanR5,
            meanReciprocalRank: mrr,
            abstentionAccuracy: `${abstentionVal.toFixed(1)}%`,
            exactErrorCodeAccuracy: `${exactVal.toFixed(1)}%`,
            medianLatencyMs: medianLatency,
            p95LatencyMs: p95Latency,
            results
        };
    }

    /**
     * Executes side-by-side comparative benchmark across BM25, Dense, and Hybrid modes.
     */
    async runComparativeBenchmark() {
        await this.init();
        const bm25Summary = await this.runAll('BM25');
        const denseSummary = await this.runAll('DENSE');
        const hybridSummary = await this.runAll('HYBRID');

        return {
            indexerMetadata: this.indexer.indexMetadata,
            bm25: bm25Summary,
            dense: denseSummary,
            hybrid: hybridSummary
        };
    }
}

module.exports = {
    RAG_BENCHMARK_CASES,
    RAGEvaluationRunner
};
