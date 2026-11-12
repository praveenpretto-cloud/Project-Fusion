'use strict';

const { telemetry, SPAN_NAMES, FUSION_AI_ATTRIBUTES } = require('../../observability');

/**
 * Min-Max normalization for score arrays.
 */
function minMaxNormalize(scores) {
    if (!scores || scores.length === 0) return [];
    const vals = scores.map((s) => s.score);
    const min = Math.min(...vals);
    const max = Math.max(...vals);

    if (max === min) {
        return scores.map((s) => ({ ...s, normScore: s.score > 0 ? 1.0 : 0.0 }));
    }

    return scores.map((s) => ({
        ...s,
        normScore: (s.score - min) / (max - min),
    }));
}

class HybridRanker {
    /**
     * @param {object} params
     * @param {BM25Retriever} params.bm25Retriever
     * @param {DenseRetriever} params.denseRetriever
     * @param {object} [options]
     * @param {number} [options.alpha=0.5] - Weight for lexical score (1 - alpha for dense)
     * @param {number} [options.minRelevanceThreshold=0.15]
     */
    constructor({ bm25Retriever, denseRetriever, options = {} }) {
        this.bm25Retriever = bm25Retriever;
        this.denseRetriever = denseRetriever;
        this.alpha = options.alpha !== undefined ? options.alpha : 0.5;
        this.minRelevanceThreshold =
            options.minRelevanceThreshold !== undefined ? options.minRelevanceThreshold : 0.15;
    }

    /**
     * Executes hybrid retrieval combining BM25 and Dense scores.
     *
     * @param {string} query
     * @param {object} [options]
     * @param {string} [options.provider]
     * @param {string} [options.error_code]
     * @param {number} [options.topK=3]
     * @returns {Promise<Array<{ chunk: object, score: number, match_type: string, bm25_score: number, dense_score: number }>>}
     */
    async search(query, options = {}) {
        return telemetry.withSpan(SPAN_NAMES.RAG_RETRIEVAL, async (span) => {
            const topK = options.topK || 3;
            const candidateK = Math.max(topK * 4, 15);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_TOP_K, topK);
            if (options.provider)
                span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_PROVIDER, options.provider);
            if (options.error_code)
                span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_ERROR_CODE, options.error_code);
            const start = Date.now();

            // 1. Lexical retrieval
            const bm25Results = this.bm25Retriever.search(query, {
                ...options,
                topK: candidateK,
            });

            // 2. Dense semantic retrieval
            let denseResults = [];
            try {
                denseResults = await this.denseRetriever.search(query, {
                    ...options,
                    topK: candidateK,
                });
            } catch (denseErr) {
                console.warn(
                    `[HYBRID RANKER] Dense search fallback to lexical only: ${denseErr.message}`
                );
            }

            // 3. Normalize score distributions
            const normBm25 = minMaxNormalize(bm25Results);
            const normDense = minMaxNormalize(denseResults);

            // 4. Merge candidates into unified map
            const merged = new Map();

            for (const item of normBm25) {
                const id = item.chunk.chunk_id;
                merged.set(id, {
                    chunk: item.chunk,
                    bm25_raw: item.score,
                    bm25_norm: item.normScore,
                    dense_raw: 0,
                    dense_norm: 0,
                    has_exact_error_match: false,
                });
            }

            for (const item of normDense) {
                const id = item.chunk.chunk_id;
                if (!merged.has(id)) {
                    merged.set(id, {
                        chunk: item.chunk,
                        bm25_raw: 0,
                        bm25_norm: 0,
                        dense_raw: item.score,
                        dense_norm: item.normScore,
                        has_exact_error_match: false,
                    });
                } else {
                    const existing = merged.get(id);
                    existing.dense_raw = item.score;
                    existing.dense_norm = item.normScore;
                }
            }

            // 5. Evaluate exact error-code and technical token match priority
            const queryLower = query.toLowerCase();
            const targetErrorCode = options.error_code
                ? options.error_code.toLowerCase().trim()
                : null;

            for (const item of merged.values()) {
                const chunk = item.chunk;
                const errorCodes = (chunk.error_codes || []).map((c) => c.toLowerCase());

                const matchesExplicitErrorCode =
                    targetErrorCode && errorCodes.includes(targetErrorCode);
                const matchesQueryErrorCode = errorCodes.some(
                    (ec) => ec.length >= 4 && queryLower.includes(ec)
                );

                if (matchesExplicitErrorCode || matchesQueryErrorCode) {
                    item.has_exact_error_match = true;
                }
            }

            // 6. Compute final hybrid ranking score
            const rankedResults = [];
            for (const item of merged.values()) {
                let hybridScore;

                if (denseResults.length === 0) {
                    if (item.bm25_raw < 4.0 && !item.has_exact_error_match) {
                        continue;
                    }
                    hybridScore = item.bm25_norm;
                } else if (normBm25.length === 0) {
                    hybridScore = item.dense_norm;
                } else {
                    hybridScore = this.alpha * item.bm25_norm + (1 - this.alpha) * item.dense_norm;
                }

                if (item.has_exact_error_match) {
                    hybridScore += 1.0;
                }

                if (hybridScore >= this.minRelevanceThreshold) {
                    let matchType = 'HYBRID';
                    if (item.has_exact_error_match) matchType = 'EXACT_ERROR_MATCH';
                    else if (item.bm25_norm > 0 && item.dense_norm === 0)
                        matchType = 'LEXICAL_BM25';
                    else if (item.bm25_norm === 0 && item.dense_norm > 0)
                        matchType = 'DENSE_SEMANTIC';

                    rankedResults.push({
                        chunk: item.chunk,
                        score: Number(hybridScore.toFixed(4)),
                        match_type: matchType,
                        bm25_score: Number(item.bm25_raw.toFixed(4)),
                        dense_score: Number(item.dense_raw.toFixed(4)),
                    });
                }
            }

            rankedResults.sort((a, b) => b.score - a.score);
            const sliced = rankedResults.slice(0, topK);
            const abstained = sliced.length === 0;

            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_CANDIDATE_CHUNKS, merged.size);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_RETURNED_CHUNKS, sliced.length);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_ABSTENTION, abstained);
            if (sliced.length > 0) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_MATCH_TYPE, sliced[0].match_type);
            }

            telemetry.recordRagRetrieval(Date.now() - start, {
                chunksReturned: sliced.length,
                abstained,
                provider: options.provider,
            });

            return sliced;
        });
    }
}

module.exports = {
    HybridRanker,
    minMaxNormalize,
};
