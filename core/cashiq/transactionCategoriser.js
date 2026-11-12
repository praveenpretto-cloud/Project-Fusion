'use strict';

/**
 * transactionCategoriser.js — Rule-based transaction keyword tagger
 * ==================================================================
 * v1: deterministic keyword matching. No ML.
 * Pluggable: swap the rule engine later without changing caller interface.
 *
 * Returns: { category: string, confidence: 'HIGH' | 'MEDIUM' | 'LOW' }
 */

const RULES = [
    {
        category: 'SALARY',
        confidence: 'HIGH',
        keywords: ['salary', 'sal ', 'payroll', ' wages', 'staff payment', 'staff salary',
                   'salary disbursement', 'monthly salary', 'salary advance'],
    },
    {
        category: 'GST_PAYMENT',
        confidence: 'HIGH',
        keywords: ['gst payment', 'cgst', 'sgst', 'igst', 'gstin', 'gstr', 'gst q'],
    },
    {
        category: 'EMI_REPAYMENT',
        confidence: 'HIGH',
        keywords: ['emi', 'loan repayment', 'equated monthly', 'od repayment',
                   'term loan', 'machine loan', 'vehicle loan emi', 'hl emi',
                   'home loan emi', 'partial od'],
    },
    {
        category: 'TDS',
        confidence: 'HIGH',
        keywords: ['tds', 'tax deducted', 'tds deposit', 'challan 281', 'tds payment',
                   '194c', '194j', '194i', '194a', 'tds return', 'tds challan'],
    },
    {
        category: 'TDS',
        confidence: 'HIGH',
        keywords: ['advance tax', 'income tax', 'it dept', 'nsdl', 'self assessment',
                   'itr', 'tax refund', 'it payment'],
    },
    {
        category: 'VENDOR_PAYMENT',
        confidence: 'HIGH',
        keywords: ['vendor payment', 'vendor ', 'supplier payment', 'supplier ',
                   'purchase payment', 'raw material', 'material payment', 'bill payment to'],
    },
    {
        category: 'CUSTOMER_RECEIPT',
        confidence: 'HIGH',
        keywords: ['payment received', 'receipt from', 'invoice payment', 'payment from',
                   'neft from', 'rtgs from', 'imps from', 'payment inward', 'inward remittance',
                   'inv-', 'inr from', 'credit from'],
    },
    {
        category: 'TRANSFER_INTERNAL',
        confidence: 'HIGH',
        keywords: ['self transfer', 'own account', 'transfer to self', 'od drawdown',
                   'neft to self', 'sweep in', 'sweep out', 'internal transfer'],
    },
    // Fuzzy / medium confidence
    {
        category: 'VENDOR_PAYMENT',
        confidence: 'MEDIUM',
        keywords: ['neft to ', 'imps to ', 'rtgs to ', 'transfer to '],
    },
    {
        category: 'CUSTOMER_RECEIPT',
        confidence: 'MEDIUM',
        keywords: ['credit', 'received', 'inward'],
    },
];

/**
 * Categorise a single transaction narration string.
 *
 * @param {string} narration
 * @returns {{ category: string, confidence: 'HIGH'|'MEDIUM'|'LOW' }}
 */
function categoriseTransaction(narration) {
    if (!narration) return { category: 'UNKNOWN', confidence: 'LOW' };

    const lower = narration.toLowerCase();

    for (const rule of RULES) {
        for (const kw of rule.keywords) {
            if (lower.includes(kw)) {
                return { category: rule.category, confidence: rule.confidence };
            }
        }
    }

    return { category: 'UNKNOWN', confidence: 'LOW' };
}

/**
 * Batch-categorise an array of transactions.
 *
 * @param {Array<{ narration: string }>} transactions
 * @returns {Array<{ narration: string, category: string, confidence: string }>}
 */
function categoriseBatch(transactions) {
    return transactions.map(txn => ({
        ...txn,
        ...categoriseTransaction(txn.narration),
    }));
}

module.exports = { categoriseTransaction, categoriseBatch };
