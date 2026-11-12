'use strict';

const crypto = require('crypto');
const { Ollama } = require('ollama');
const { telemetry, SPAN_NAMES, FUSION_AI_ATTRIBUTES, GEN_AI_ATTRIBUTES } = require('../../observability');

/**
 * Normalizes a vector to unit length (L2 norm).
 */
function normalizeVector(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
        norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    return vec.map(v => v / norm);
}

/**
 * Computes cosine similarity between two unit vectors.
 */
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
    }
    return Math.max(-1, Math.min(1, dot));
}

/**
 * Base Embedding Provider
 */
class BaseEmbeddingProvider {
    constructor(providerName, dimension, modelName) {
        this.providerName = providerName;
        this.dimension = dimension;
        this.modelName = modelName;
        this.isMock = providerName === 'mock';
    }

    async getEmbedding(text) {
        throw new Error('getEmbedding() must be implemented by subclass.');
    }

    async getEmbeddings(texts) {
        const results = [];
        for (const t of texts) {
            results.push(await this.getEmbedding(t));
        }
        return results;
    }
}

/**
 * Deterministic Mock Embedding Provider
 * 
 * Generates 384-dimensional unit vectors using deterministic token hashing and projection.
 * Used for reproducible unit testing, benchmark evaluation, and offline CI runs.
 */
class MockEmbeddingProvider extends BaseEmbeddingProvider {
    constructor(options = {}) {
        const dim = options.dimension || 384;
        super('mock', dim, options.modelName || 'mock-embed-384');
        this.isMock = true;
    }

    async getEmbedding(text) {
        return telemetry.withSpan(SPAN_NAMES.RAG_EMBEDDING, async (span) => {
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_EMBEDDING_MODEL, this.modelName);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_EMBEDDING_DIMENSION, this.dimension);
            const start = Date.now();

            const clean = (text || '').trim().toLowerCase();
            const vector = new Array(this.dimension).fill(0);

            if (!clean) {
                const norm = normalizeVector(vector.map((_, i) => (i % 2 === 0 ? 0.01 : -0.01)));
                telemetry.recordRagEmbedding(Date.now() - start, { model: this.modelName });
                return norm;
            }

            // Tokenize into words and 3-char n-grams
            const words = clean.split(/[^a-z0-9_.-]+/i).filter(Boolean);
            for (const word of words) {
                const hash = crypto.createHash('sha256').update(word).digest();
                for (let i = 0; i < 16; i++) {
                    const idx = hash.readUInt16LE(i * 2) % this.dimension;
                    const sign = (hash[i] % 2 === 0) ? 1 : -1;
                    const weight = 1 + (word.length / 10);
                    vector[idx] += sign * weight;
                }
            }

            const res = normalizeVector(vector);
            telemetry.recordRagEmbedding(Date.now() - start, { model: this.modelName });
            return res;
        });
    }
}

/**
 * Ollama Embedding Provider
 * 
 * Calls local Ollama daemon embedding endpoints (ollama.embeddings or ollama.embed).
 */
class OllamaEmbeddingProvider extends BaseEmbeddingProvider {
    constructor(options = {}) {
        const host = options.host || 'http://127.0.0.1:11434';
        const model = options.modelName || 'nomic-embed-text';
        const dim = options.dimension || 768;
        super('ollama', dim, model);
        this.host = host;
        this.client = new Ollama({ host: this.host });
        this.isMock = false;
    }

    async ping() {
        try {
            const list = await this.client.list();
            const found = list && list.models && list.models.some(m => m.name.startsWith(this.modelName));
            return {
                available: !!found,
                modelFound: !!found,
                host: this.host,
                model: this.modelName
            };
        } catch (err) {
            return {
                available: false,
                modelFound: false,
                host: this.host,
                model: this.modelName,
                error: err.message
            };
        }
    }

    async getEmbedding(text) {
        return telemetry.withSpan(SPAN_NAMES.RAG_EMBEDDING, async (span) => {
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_EMBEDDING_MODEL, this.modelName);
            span.setAttribute(FUSION_AI_ATTRIBUTES.RAG_EMBEDDING_DIMENSION, this.dimension);
            const start = Date.now();

            try {
                // First try modern embed API
                if (typeof this.client.embed === 'function') {
                    const res = await this.client.embed({
                        model: this.modelName,
                        input: text
                    });
                    if (res && res.embeddings && res.embeddings[0]) {
                        const normVec = normalizeVector(res.embeddings[0]);
                        if (normVec.length !== this.dimension) {
                            throw new Error(`Embedding dimension mismatch: expected ${this.dimension}, got ${normVec.length}`);
                        }
                        telemetry.recordRagEmbedding(Date.now() - start, { model: this.modelName });
                        return normVec;
                    }
                }

                // Fallback to classic embeddings API
                const res = await this.client.embeddings({
                    model: this.modelName,
                    prompt: text
                });
                if (res && res.embedding) {
                    const normVec = normalizeVector(res.embedding);
                    if (normVec.length !== this.dimension) {
                        throw new Error(`Embedding dimension mismatch: expected ${this.dimension}, got ${normVec.length}`);
                    }
                    telemetry.recordRagEmbedding(Date.now() - start, { model: this.modelName });
                    return normVec;
                }
                throw new Error(`Ollama returned no embedding vector for model '${this.modelName}'`);
            } catch (err) {
                throw new Error(`Local Ollama embedding generation failed: ${err.message}`);
            }
        });
    }

    async getEmbeddings(texts) {
        if (!Array.isArray(texts) || texts.length === 0) return [];
        try {
            if (typeof this.client.embed === 'function') {
                const res = await this.client.embed({
                    model: this.modelName,
                    input: texts
                });
                if (res && res.embeddings && res.embeddings.length === texts.length) {
                    return res.embeddings.map(vec => {
                        const normVec = normalizeVector(vec);
                        if (normVec.length !== this.dimension) {
                            throw new Error(`Embedding dimension mismatch: expected ${this.dimension}, got ${normVec.length}`);
                        }
                        return normVec;
                    });
                }
            }
            // Fallback to sequential execution
            const results = [];
            for (const t of texts) {
                results.push(await this.getEmbedding(t));
            }
            return results;
        } catch (err) {
            throw new Error(`Local Ollama batch embedding failed: ${err.message}`);
        }
    }
}

module.exports = {
    BaseEmbeddingProvider,
    MockEmbeddingProvider,
    OllamaEmbeddingProvider,
    normalizeVector,
    cosineSimilarity
};

