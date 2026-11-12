'use strict';

/**
 * Fusion Operations Intelligence — Phase AI-1A Evidence Retrieval Functions
 *
 * Centralized export for the seven private, dependency-injected evidence functions.
 * These functions are purely internal and are NOT exposed via HTTP endpoints.
 */

const { getTransactionTimeline } = require('./getTransactionTimeline');
const { getProviderFailureDetails } = require('./getProviderFailureDetails');
const { getSagaExecutionEvidence } = require('./getSagaExecutionEvidence');
const { getSettlementAndWebhookEvidence } = require('./getSettlementAndWebhookEvidence');
const { verifyLedgerIntegrity } = require('./verifyLedgerIntegrity');
const { getReconciliationEvidence } = require('./getReconciliationEvidence');
const { explainIsoValidationErrors } = require('./explainIsoValidationErrors');
const { computePayloadHash } = require('./ledgerHashHelper');

module.exports = {
    getTransactionTimeline,
    getProviderFailureDetails,
    getSagaExecutionEvidence,
    getSettlementAndWebhookEvidence,
    verifyLedgerIntegrity,
    getReconciliationEvidence,
    explainIsoValidationErrors,
    computePayloadHash,
};
