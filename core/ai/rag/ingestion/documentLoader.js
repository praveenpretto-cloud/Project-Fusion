'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_SIZE_BYTES = 102400; // 100KB per document file
const VALID_PROVIDERS = new Set(['STRIPE', 'RAZORPAY', 'STELLAR', 'ISO20022', 'PROJECT_FUSION']);

/**
 * Parses simple YAML-like frontmatter enclosed in --- delimiters.
 */
function parseFrontmatter(rawContent) {
    const trimmed = rawContent.trim();
    if (!trimmed.startsWith('---')) {
        return { metadata: {}, body: trimmed };
    }

    const endIdx = trimmed.indexOf('---', 3);
    if (endIdx === -1) {
        return { metadata: {}, body: trimmed };
    }

    const frontmatterText = trimmed.slice(3, endIdx).trim();
    const body = trimmed.slice(endIdx + 3).trim();
    const metadata = {};

    const lines = frontmatterText.split('\n');
    for (const line of lines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            const key = line.slice(0, colonIdx).trim();
            const val = line.slice(colonIdx + 1).trim();
            metadata[key] = val;
        }
    }

    return { metadata, body };
}

/**
 * Validates mandatory document source metadata.
 */
function validateDocumentMetadata(metadata, filePath) {
    const mandatory = ['source_id', 'title', 'publisher', 'provider', 'source_url', 'document_version', 'last_verified_at'];
    for (const key of mandatory) {
        if (!metadata[key] || typeof metadata[key] !== 'string') {
            throw new Error(`Document metadata missing mandatory field '${key}' in file: ${filePath}`);
        }
    }

    const providerNorm = metadata.provider.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!VALID_PROVIDERS.has(providerNorm)) {
        throw new Error(`Invalid provider '${metadata.provider}' in ${filePath}. Must be one of: ${Array.from(VALID_PROVIDERS).join(', ')}`);
    }
    metadata.provider = providerNorm;
}

class DocumentLoader {
    /**
     * Loads and validates a single markdown document file.
     * 
     * @param {string} filePath 
     * @returns {object} Loaded document metadata and body
     */
    static loadFile(filePath) {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
            throw new Error(`Document file exceeds maximum permitted size of ${MAX_FILE_SIZE_BYTES} bytes: ${filePath} (${stats.size} bytes)`);
        }

        const rawContent = fs.readFileSync(filePath, 'utf8');
        const contentHash = crypto.createHash('sha256').update(rawContent, 'utf8').digest('hex');
        const { metadata, body } = parseFrontmatter(rawContent);

        validateDocumentMetadata(metadata, filePath);

        return {
            source_id: metadata.source_id,
            title: metadata.title,
            publisher: metadata.publisher,
            provider: metadata.provider,
            source_url: metadata.source_url,
            document_version: metadata.document_version,
            last_verified_at: metadata.last_verified_at,
            licensing: metadata.licensing || 'Authoritative Technical Summary',
            file_path: filePath,
            content_hash: contentHash,
            body
        };
    }

    /**
     * Recursively scans directory for markdown documentation.
     * 
     * @param {string} baseDir 
     * @returns {object[]} Array of loaded documents
     */
    static loadDirectory(baseDir) {
        if (!fs.existsSync(baseDir)) {
            throw new Error(`Knowledge base directory does not exist: ${baseDir}`);
        }

        const loadedDocuments = [];
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(baseDir, entry.name);
            if (entry.isDirectory()) {
                loadedDocuments.push(...this.loadDirectory(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                loadedDocuments.push(this.loadFile(fullPath));
            }
        }

        return loadedDocuments;
    }
}

module.exports = {
    DocumentLoader,
    parseFrontmatter,
    MAX_FILE_SIZE_BYTES,
    VALID_PROVIDERS
};

