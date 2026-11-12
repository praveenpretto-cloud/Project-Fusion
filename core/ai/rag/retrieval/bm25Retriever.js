'use strict';

const { telemetry, SPAN_NAMES, FUSION_AI_ATTRIBUTES } = require('../../observability');

// Standard Okapi BM25 parameters
const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

// Standard English stop words to prevent common conversational words from polluting lexical scores
const STOP_WORDS = new Set([
    'a',
    'about',
    'above',
    'after',
    'again',
    'against',
    'all',
    'am',
    'an',
    'and',
    'any',
    'are',
    'as',
    'at',
    'be',
    'because',
    'been',
    'before',
    'being',
    'below',
    'between',
    'both',
    'but',
    'by',
    'could',
    'did',
    'do',
    'does',
    'doing',
    'down',
    'during',
    'each',
    'few',
    'for',
    'from',
    'further',
    'had',
    'has',
    'have',
    'having',
    'he',
    'her',
    'here',
    'hers',
    'him',
    'his',
    'how',
    'i',
    'if',
    'in',
    'into',
    'is',
    'it',
    'its',
    'me',
    'more',
    'most',
    'my',
    'no',
    'nor',
    'not',
    'of',
    'off',
    'on',
    'once',
    'only',
    'or',
    'other',
    'ought',
    'our',
    'ours',
    'out',
    'over',
    'own',
    'same',
    'she',
    'should',
    'so',
    'some',
    'such',
    'than',
    'that',
    'the',
    'their',
    'theirs',
    'them',
    'then',
    'there',
    'these',
    'they',
    'this',
    'those',
    'through',
    'to',
    'too',
    'under',
    'until',
    'up',
    'use',
    'used',
    'uses',
    'using',
    'very',
    'was',
    'we',
    'were',
    'what',
    'when',
    'where',
    'which',
    'while',
    'who',
    'whom',
    'why',
    'with',
    'would',
    'you',
    'your',
    'yours',
]);

/**
 * Tokenizes text into search tokens, preserving technical tokens with underscores and dots.
 */
function tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

class BM25Retriever {
    /**
     * @param {object[]} chunks - Ingested knowledge chunks
     * @param {object} [options]
     * @param {number} [options.k1=1.2]
     * @param {number} [options.b=0.75]
     */
    constructor(chunks = [], options = {}) {
        this.k1 = options.k1 || DEFAULT_K1;
        this.b = options.b || DEFAULT_B;
        this.chunks = chunks;
        this.docCount = chunks.length;
        this.docLengths = [];
        this.avgDocLength = 0;
        this.invertedIndex = new Map(); // term -> Map(chunkIdx -> tf)
        this.idfCache = new Map();

        this._buildIndex();
    }

    _buildIndex() {
        let totalLength = 0;

        for (let i = 0; i < this.chunks.length; i++) {
            const chunk = this.chunks[i];
            const textToTokenize = `${chunk.title} ${chunk.section} ${chunk.content} ${(chunk.error_codes || []).join(' ')}`;
            const tokens = tokenize(textToTokenize);
            const docLength = tokens.length;
            this.docLengths[i] = docLength;
            totalLength += docLength;

            const termFreqs = new Map();
            for (const token of tokens) {
                termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
            }

            for (const [term, tf] of termFreqs.entries()) {
                if (!this.invertedIndex.has(term)) {
                    this.invertedIndex.set(term, new Map());
                }
                this.invertedIndex.get(term).set(i, tf);
            }
        }

        this.avgDocLength = this.docCount > 0 ? totalLength / this.docCount : 0;

        // Precompute IDF for all terms
        for (const [term, postings] of this.invertedIndex.entries()) {
            const df = postings.size;
            // Robertson-Spärck Jones IDF
            const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
            this.idfCache.set(term, Math.max(0.1, idf));
        }
    }

    /**
     * Searches index using BM25 scoring with technical error-code boosting.
     *
     * @param {string} query
     * @param {object} [options]
     * @param {string} [options.provider]
     * @param {string} [options.error_code]
     * @param {number} [options.topK=5]
     * @returns {Array<{ chunk: object, score: number, raw_bm25: number }>}
     */
    search(query, options = {}) {
        return telemetry.withSyncSpan(SPAN_NAMES.RAG_BM25_SEARCH, (span) => {
            const topK = options.topK || 5;
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_TOP_K, topK);
            if (options.provider)
                span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_PROVIDER, options.provider);
            if (options.error_code)
                span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_ERROR_CODE, options.error_code);

            const queryTokens = tokenize(query);
            const targetProvider = options.provider ? options.provider.toUpperCase().trim() : null;
            const targetErrorCode = options.error_code
                ? options.error_code.toLowerCase().trim()
                : null;

            const scores = new Array(this.docCount).fill(0);

            for (const token of queryTokens) {
                const postings = this.invertedIndex.get(token);
                if (!postings) continue;

                const idf = this.idfCache.get(token) || 0.1;

                for (const [chunkIdx, tf] of postings.entries()) {
                    const docLen = this.docLengths[chunkIdx];
                    const numerator = tf * (this.k1 + 1);
                    const denominator =
                        tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLength));
                    scores[chunkIdx] += idf * (numerator / denominator);
                }
            }

            // Apply technical error-code exact match boosting & filters
            const scoredChunks = [];

            for (let i = 0; i < this.docCount; i++) {
                const chunk = this.chunks[i];

                // Filter by provider if specified
                if (
                    targetProvider &&
                    targetProvider !== 'ALL' &&
                    chunk.provider !== targetProvider
                ) {
                    continue;
                }

                // Filter by exact error code if specified
                if (targetErrorCode) {
                    const hasErrorCode = (chunk.error_codes || []).some(
                        (c) => c.toLowerCase() === targetErrorCode
                    );
                    if (!hasErrorCode && !chunk.content.toLowerCase().includes(targetErrorCode)) {
                        continue;
                    }
                }

                let score = scores[i];

                // Technical token boost: If chunk explicitly contains query technical tokens
                for (const token of queryTokens) {
                    if ((chunk.error_codes || []).some((c) => c.toLowerCase() === token)) {
                        score += 5.0; // Strong exact technical identifier boost
                    }
                }

                if (score > 0) {
                    scoredChunks.push({
                        chunk,
                        score,
                        raw_bm25: scores[i],
                    });
                }
            }

            scoredChunks.sort((a, b) => b.score - a.score);
            const results = scoredChunks.slice(0, topK);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_CANDIDATE_CHUNKS, scoredChunks.length);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_RETURNED_CHUNKS, results.length);
            return results;
        });
    }
}

module.exports = {
    BM25Retriever,
    tokenize,
};
