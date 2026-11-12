'use strict';

/**
 * Synthetic Payment Exception Store & Controlled Boundary Guard
 * 
 * Manages the in-memory registry of 15 synthetic payment operational exception scenarios.
 * Strict boundary rules:
 * 1. Zero queries to persistent fusion_db.
 * 2. Zero queries to real customer records or production tables.
 * 3. Zero network calls to live payment gateways or external financial networks.
 * 4. All evidence passed into InvestigationOrchestrator is sourced strictly from fixture data.
 */

const { SYNTHETIC_CASES } = require('../benchmark/syntheticCases');

const CASE_ID_REGEX = /^CASE-(?:0[1-9]|1[0-5])$/;

class SyntheticStore {
    constructor() {
        this._caseMap = new Map();
        this._txMap = new Map();

        // Index the 15 synthetic cases in-memory
        for (const testCase of SYNTHETIC_CASES) {
            // Deep clone to prevent accidental mutation of benchmark fixtures
            const cloned = JSON.parse(JSON.stringify(testCase));
            this._caseMap.set(cloned.id, Object.freeze(cloned));
            if (cloned.transactionId) {
                this._txMap.set(cloned.transactionId, cloned.id);
            }
        }
    }

    /**
     * Validates if a string is a well-formed synthetic case ID.
     * @param {string} caseId
     * @returns {boolean}
     */
    isValidCaseId(caseId) {
        if (!caseId || typeof caseId !== 'string') return false;
        return CASE_ID_REGEX.test(caseId.trim());
    }

    /**
     * Returns a summary list of all registered synthetic cases for display / API listing.
     * @returns {Array<object>}
     */
    listCases() {
        return SYNTHETIC_CASES.map(c => ({
            id: c.id,
            title: c.title,
            intent: c.intent,
            transactionId: c.transactionId,
            question: c.question,
            expectedStatus: c.expectedStatus,
            groundedFinding: c.groundedFinding,
            toolsAvailable: Object.keys(c.evidence || {})
        }));
    }

    /**
     * Retrieves a synthetic case by caseId.
     * @param {string} caseId - e.g. 'CASE-01'
     * @returns {object|null}
     */
    getCaseById(caseId) {
        if (!this.isValidCaseId(caseId)) {
            return null;
        }
        const found = this._caseMap.get(caseId.trim());
        return found ? JSON.parse(JSON.stringify(found)) : null;
    }

    /**
     * Retrieves a synthetic case by its synthetic transactionId.
     * @param {string} txId
     * @returns {object|null}
     */
    getCaseByTransactionId(txId) {
        if (!txId || typeof txId !== 'string') return null;
        const caseId = this._txMap.get(txId.trim());
        if (!caseId) return null;
        return this.getCaseById(caseId);
    }

    /**
     * Controlled database boundary stub.
     * Guarantees zero SQL execution against persistent fusion_db.
     * If an evidence tool or rogue query attempts to execute SQL, it fails closed immediately.
     */
    createControlledDbBoundary() {
        return {
            query: async () => {
                throw new Error(
                    'SECURITY_VIOLATION: Direct database query rejected. Synthetic copilot operates strictly in-memory without persistent database access.'
                );
            }
        };
    }
}

// Export singleton instance and class
const syntheticStore = new SyntheticStore();

module.exports = {
    SyntheticStore,
    syntheticStore,
    CASE_ID_REGEX
};

