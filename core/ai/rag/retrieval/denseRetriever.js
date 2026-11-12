'use strict';

const { cosineSimilarity } = require('./embeddingProvider');
const { telemetry, SPAN_NAMES, FUSION_AI_ATTRIBUTES } = require('../../observability');

class DenseRetriever {
    /**
     * @param {object} params
     * @param {object[]} params.chunks - Ingested knowledge chunks
     * @param {Map<string, number[]>|object} params.vectorTable - Mapping chunk_id -> embedding
     * @param {object} params.embeddingProvider - Instance of BaseEmbeddingProvider
     */
    constructor({ chunks = [], vectorTable = new Map(), embeddingProvider }) {
        this.chunks = chunks;
        this.chunkMap = new Map(chunks.map((c) => [c.chunk_id, c]));
        this.vectorTable =
            vectorTable instanceof Map ? vectorTable : new Map(Object.entries(vectorTable));
        this.embeddingProvider = embeddingProvider;
        this.queryCache = new Map();

        // Verify dimensions
        const firstVec = this.vectorTable.values().next().value;
        if (firstVec) {
            this.dimension = firstVec.length;
            if (this.embeddingProvider && this.embeddingProvider.dimension !== this.dimension) {
                throw new Error(
                    `Embedding model dimension mismatch: stored vector table dimension is ${this.dimension}, but provider '${this.embeddingProvider.modelName}' produces ${this.embeddingProvider.dimension}. Re-indexing required.`
                );
            }
        }
    }

    /**
     * Searches dense vector space by cosine similarity against query embedding.
     *
     * @param {string} query
     * @param {object} [options]
     * @param {string} [options.provider]
     * @param {string} [options.error_code]
     * @param {number} [options.topK=5]
     * @returns {Promise<Array<{ chunk: object, score: number, raw_cosine: number }>>}
     */
    async search(query, options = {}) {
        return telemetry.withSpan(SPAN_NAMES.RAG_DENSE_SEARCH, async (span) => {
            const topK = options.topK || 5;
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_TOP_K, topK);
            if (options.provider)
                span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_PROVIDER, options.provider);
            if (options.error_code)
                span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_ERROR_CODE, options.error_code);
            if (this.embeddingProvider?.modelName)
                span.setAttribute(
                    FUSION_AI_ATTRIBUTES.RAG_EMBEDDING_MODEL,
                    this.embeddingProvider.modelName
                );

            const targetProvider = options.provider ? options.provider.toUpperCase().trim() : null;
            const targetErrorCode = options.error_code
                ? options.error_code.toLowerCase().trim()
                : null;

            // Retrieve or generate query embedding
            const cacheKey = `${query.trim().toLowerCase()}_${this.embeddingProvider?.modelName || 'default'}`;
            let queryVector = this.queryCache.get(cacheKey);

            if (!queryVector) {
                queryVector = await this.embeddingProvider.getEmbedding(query);
                this.queryCache.set(cacheKey, queryVector);
            }

            if (this.dimension && queryVector.length !== this.dimension) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, 'EMBEDDING_DIMENSION_MISMATCH');
                throw new Error(
                    `Query embedding dimension (${queryVector.length}) does not match index dimension (${this.dimension}). Incompatible embedding model.`
                );
            }

            const results = [];

            const defaultThreshold =
                this.embeddingProvider && this.embeddingProvider.isMock ? 0.32 : 0.52;
            const threshold =
                options.minCosineThreshold !== undefined
                    ? options.minCosineThreshold
                    : defaultThreshold;

            for (const [chunkId, chunkVec] of this.vectorTable.entries()) {
                const chunk = this.chunkMap.get(chunkId);
                if (!chunk) continue;

                // Apply provider filter
                if (
                    targetProvider &&
                    targetProvider !== 'ALL' &&
                    chunk.provider !== targetProvider
                ) {
                    continue;
                }

                // Apply error code filter
                if (targetErrorCode) {
                    const hasErrorCode = (chunk.error_codes || []).some(
                        (c) => c.toLowerCase() === targetErrorCode
                    );
                    if (!hasErrorCode && !chunk.content.toLowerCase().includes(targetErrorCode)) {
                        continue;
                    }
                }

                const sim = cosineSimilarity(queryVector, chunkVec);
                if (sim >= threshold) {
                    results.push({
                        chunk,
                        score: Math.max(0, sim),
                        raw_cosine: sim,
                    });
                }
            }

            results.sort((a, b) => b.score - a.score);
            const sliced = results.slice(0, topK);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_CANDIDATE_CHUNKS, results.length);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_RETURNED_CHUNKS, sliced.length);
            return sliced;
        });
    }
}

module.exports = {
    DenseRetriever,
};
