'use strict';

const path = require('path');
const { DocumentLoader } = require('./documentLoader');
const { TextChunker } = require('./textChunker');
const {
    MockEmbeddingProvider,
    OllamaEmbeddingProvider,
} = require('../retrieval/embeddingProvider');
const { BM25Retriever } = require('../retrieval/bm25Retriever');
const { DenseRetriever } = require('../retrieval/denseRetriever');
const { HybridRanker } = require('../retrieval/hybridRanker');

const DEFAULT_KB_DIR = path.resolve(__dirname, '../knowledgeBase');

class KnowledgeIndexer {
    /**
     * @param {object} [options]
     * @param {string} [options.knowledgeBaseDir]
     * @param {BaseEmbeddingProvider} [options.embeddingProvider]
     */
    constructor(options = {}) {
        this.knowledgeBaseDir = options.knowledgeBaseDir || DEFAULT_KB_DIR;
        this.embeddingProvider = options.embeddingProvider || new MockEmbeddingProvider();
        this.documents = [];
        this.chunks = [];
        this.vectorTable = new Map();
        this.bm25Retriever = null;
        this.denseRetriever = null;
        this.hybridRanker = null;
        this.isIndexed = false;
        this.indexMetadata = null;
    }

    /**
     * Updates embedding provider, invalidating stored vectors if model or dimension changed.
     * @param {BaseEmbeddingProvider} newProvider
     */
    setEmbeddingProvider(newProvider) {
        if (!newProvider) throw new Error('setEmbeddingProvider: provider is required');
        const changed =
            !this.embeddingProvider ||
            this.embeddingProvider.modelName !== newProvider.modelName ||
            this.embeddingProvider.dimension !== newProvider.dimension ||
            this.embeddingProvider.providerName !== newProvider.providerName;

        this.embeddingProvider = newProvider;
        if (changed) {
            this.vectorTable.clear();
            this.denseRetriever = null;
            this.hybridRanker = null;
            this.isIndexed = false;
            this.indexMetadata = null;
        }
    }

    /**
     * Ingests, chunks, embeds, and indexes the entire knowledge corpus.
     */
    async buildIndex() {
        // Pre-flight check: If provider is Ollama, verify connectivity and model availability
        if (typeof this.embeddingProvider.ping === 'function') {
            const health = await this.embeddingProvider.ping();
            if (!health.available) {
                throw new Error(
                    `Embedding provider '${this.embeddingProvider.providerName}' (${this.embeddingProvider.modelName}) is unavailable: ${health.error || 'Model not installed on host'}`
                );
            }
        }

        // 1. Load documents
        this.documents = DocumentLoader.loadDirectory(this.knowledgeBaseDir);

        // 2. Chunk documents & deduplicate by content_hash
        const allChunks = [];
        const seenHashes = new Set();

        for (const doc of this.documents) {
            const docChunks = TextChunker.chunkDocument(doc);
            for (const chunk of docChunks) {
                if (!seenHashes.has(chunk.content_hash)) {
                    seenHashes.add(chunk.content_hash);
                    allChunks.push(chunk);
                }
            }
        }
        this.chunks = allChunks;

        // 3. Generate embeddings for all chunks (utilizing batch API if supported)
        this.vectorTable = new Map();
        const embeddingTexts = this.chunks.map(
            (chunk) => `${chunk.title} - ${chunk.section}: ${chunk.content}`
        );

        let vectors;
        if (typeof this.embeddingProvider.getEmbeddings === 'function') {
            vectors = await this.embeddingProvider.getEmbeddings(embeddingTexts);
        } else {
            vectors = [];
            for (const text of embeddingTexts) {
                vectors.push(await this.embeddingProvider.getEmbedding(text));
            }
        }

        for (let i = 0; i < this.chunks.length; i++) {
            this.vectorTable.set(this.chunks[i].chunk_id, vectors[i]);
        }

        // 4. Construct BM25 and Dense Retrievers
        this.bm25Retriever = new BM25Retriever(this.chunks);
        this.denseRetriever = new DenseRetriever({
            chunks: this.chunks,
            vectorTable: this.vectorTable,
            embeddingProvider: this.embeddingProvider,
        });

        // 5. Construct Hybrid Ranker
        this.hybridRanker = new HybridRanker({
            bm25Retriever: this.bm25Retriever,
            denseRetriever: this.denseRetriever,
        });

        this.indexMetadata = {
            indexedAt: new Date().toISOString(),
            documentCount: this.documents.length,
            chunkCount: this.chunks.length,
            embeddingDimension: this.embeddingProvider.dimension,
            embeddingModel: this.embeddingProvider.modelName,
            providerType: this.embeddingProvider.providerName,
            isMock: this.embeddingProvider.isMock || false,
            version: '3.2.1',
        };

        this.isIndexed = true;
        return this.indexMetadata;
    }

    /**
     * Executes hybrid search over indexed knowledge base.
     */
    async search(query, options = {}) {
        if (!this.isIndexed) {
            await this.buildIndex();
        }
        return this.hybridRanker.search(query, options);
    }
}

// Module-level singleton instance for fast reuse
let defaultIndexerInstance = null;

async function getOrCreateIndexer(options = {}) {
    if (!defaultIndexerInstance || options.forceReindex) {
        defaultIndexerInstance = new KnowledgeIndexer(options);
        await defaultIndexerInstance.buildIndex();
    } else if (
        options.embeddingProvider &&
        defaultIndexerInstance.embeddingProvider !== options.embeddingProvider
    ) {
        defaultIndexerInstance.setEmbeddingProvider(options.embeddingProvider);
        await defaultIndexerInstance.buildIndex();
    }
    return defaultIndexerInstance;
}

function resetDefaultIndexer() {
    defaultIndexerInstance = null;
}

module.exports = {
    KnowledgeIndexer,
    getOrCreateIndexer,
    resetDefaultIndexer,
};
