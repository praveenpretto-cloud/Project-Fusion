'use strict';

const crypto = require('crypto');

// Technical pattern detectors for exact error codes, API fields, and ISO tags
const TECHNICAL_IDENTIFIER_PATTERNS = [
    // Underscore-separated error codes (e.g. balance_insufficient, tx_insufficient_balance)
    /\b([a-z0-9]+_[a-z0-9_]+)\b/gi,
    // Uppercase underscore error categories (e.g. BAD_REQUEST_ERROR, POSTING_ARITHMETIC_MISMATCH)
    /\b([A-Z0-9]+_[A-Z0-9_]+)\b/g,
    // ISO 20022 message codes (e.g. pacs.008, camt.053, pacs.008.001.08)
    /\b([a-z]{4}\.\d{3}(?:\.\d{3}\.\d{2})?)\b/gi,
    // CamelCase field names (e.g. streetName, townName, EndToEndId, Idempotency-Key)
    /\b([a-z]+[A-Z0-9][a-zA-Z0-9]*)\b/g,
    // Header names with hyphens (e.g. Idempotency-Key, Stripe-Signature)
    /\b([A-Z][a-zA-Z0-9]+-[A-Z][a-zA-Z0-9]+)\b/g
];

/**
 * Extracts distinct technical identifiers and error codes from text.
 */
function extractTechnicalIdentifiers(text) {
    const codes = new Set();
    if (!text || typeof text !== 'string') return [];

    for (const pattern of TECHNICAL_IDENTIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const token = match[1].trim();
            // Filter common English words or short tokens
            if (token.length >= 3 && !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been', 'which'].includes(token.toLowerCase())) {
                codes.add(token);
            }
        }
    }

    return Array.from(codes);
}

class TextChunker {
    /**
     * Splits a document into section-aware chunks.
     * 
     * @param {object} document - Output from DocumentLoader.loadFile
     * @returns {object[]} Array of structured chunk objects
     */
    static chunkDocument(document) {
        const chunks = [];
        const body = document.body || '';
        const lines = body.split('\n');

        let currentSectionTitle = document.title;
        let currentSectionLines = [];
        let chunkIndex = 1;

        function emitChunk(sectionTitle, sectionContent) {
            const cleanContent = sectionContent.trim();
            if (!cleanContent) return;

            const contentHash = crypto.createHash('sha256').update(cleanContent, 'utf8').digest('hex');
            const providerKey = document.provider.toLowerCase().replace(/[^a-z0-9]/g, '');
            const sourceKey = document.source_id.toLowerCase().replace(/[^a-z0-9-]/g, '');
            const chunkId = `docs:${providerKey}:${sourceKey}:chunk-${String(chunkIndex).padStart(3, '0')}`;
            chunkIndex++;

            const errorCodes = extractTechnicalIdentifiers(cleanContent);

            chunks.push({
                chunk_id: chunkId,
                source_id: document.source_id,
                provider: document.provider,
                title: document.title,
                section: sectionTitle,
                content: cleanContent,
                source_url: document.source_url,
                document_version: document.document_version,
                content_hash: contentHash,
                last_verified_at: document.last_verified_at,
                error_codes: errorCodes
            });
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Detect section headers (## Section Name)
            if (trimmed.startsWith('## ')) {
                if (currentSectionLines.length > 0) {
                    emitChunk(currentSectionTitle, currentSectionLines.join('\n'));
                    currentSectionLines = [];
                }
                currentSectionTitle = trimmed.slice(3).trim();
            } else if (trimmed.startsWith('# ') && currentSectionLines.length === 0) {
                // Top-level document header
                currentSectionTitle = trimmed.slice(2).trim();
            } else {
                currentSectionLines.push(line);
            }
        }

        if (currentSectionLines.length > 0) {
            emitChunk(currentSectionTitle, currentSectionLines.join('\n'));
        }

        return chunks;
    }
}

module.exports = {
    TextChunker,
    extractTechnicalIdentifiers
};

