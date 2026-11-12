'use strict';

/**
 * aaStub.js — Account Aggregator Stub
 * =====================================
 * Simulates the AA connector interface using manually uploaded bank statement CSVs.
 * When FIU registration is complete, replace this file with the real aaAdapter.js —
 * the downstream cashPositionService and cashSentinel need zero changes.
 *
 * Supported CSV format (matches HDFC, ICICI, SBI, Axis, Kotak exports):
 *   Date, Narration, Debit, Credit, Balance
 */

const logger = require('../logger');
const { categoriseTransaction } = require('../core/cashiq/transactionCategoriser');

/**
 * Parse a standard Indian bank CSV export and insert rows into bank_transactions.
 *
 * @param {object} pool        - PostgreSQL pool
 * @param {string} businessId  - UUID of the business
 * @param {string} accountId   - UUID of the bank account
 * @param {string} csvText     - Raw CSV string content
 * @returns {{ imported: number, skipped: number, errors: string[] }}
 */
async function importBankStatementCSV(pool, businessId, accountId, csvText) {
    const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
        return { imported: 0, skipped: 0, errors: ['CSV has no data rows'] };
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

    // Flexible header matching for major Indian bank formats
    const idx = {
        date:      headers.findIndex(h => h.includes('date')),
        narration: headers.findIndex(h => h.includes('narration') || h.includes('description') || h.includes('particulars')),
        debit:     headers.findIndex(h => h.includes('debit') || h.includes('withdrawal')),
        credit:    headers.findIndex(h => h.includes('credit') || h.includes('deposit')),
        balance:   headers.findIndex(h => h.includes('balance')),
    };

    if (idx.date === -1 || (idx.debit === -1 && idx.credit === -1)) {
        return { imported: 0, skipped: 0, errors: ['CSV format unrecognised. Expected columns: Date, Narration, Debit, Credit, Balance'] };
    }

    let imported = 0, skipped = 0;
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
        if (cols.length < 3) { skipped++; continue; }

        try {
            const rawDate    = cols[idx.date] || '';
            const narration  = idx.narration !== -1 ? cols[idx.narration] : '';
            const debitStr   = idx.debit  !== -1 ? (cols[idx.debit]  || '').replace(/,/g, '') : '0';
            const creditStr  = idx.credit !== -1 ? (cols[idx.credit] || '').replace(/,/g, '') : '0';
            const balanceStr = idx.balance !== -1 ? (cols[idx.balance] || '').replace(/,/g, '') : null;

            const debit  = parseFloat(debitStr)  || 0;
            const credit = parseFloat(creditStr) || 0;

            if (debit === 0 && credit === 0) { skipped++; continue; }

            const amount    = debit > 0 ? debit : credit;
            const direction = debit > 0 ? 'DEBIT' : 'CREDIT';

            // Normalise date: handles DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
            const txnDate = normaliseDate(rawDate);
            if (!txnDate) { skipped++; continue; }

            const { category, confidence } = categoriseTransaction(narration);

            await pool.query(
                `INSERT INTO bank_transactions
                    (account_id, business_id, txn_date, amount, direction, narration,
                     category, category_confidence, balance_after, data_source, raw_json)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL',$10)
                 ON CONFLICT DO NOTHING`,
                [
                    accountId, businessId, txnDate, amount, direction, narration,
                    category, confidence,
                    balanceStr ? parseFloat(balanceStr) : null,
                    JSON.stringify({ raw_line: lines[i] }),
                ]
            );

            // Update account last_synced_at
            await pool.query(
                `UPDATE business_bank_accounts SET last_synced_at = NOW() WHERE account_id = $1`,
                [accountId]
            );

            imported++;
        } catch (err) {
            errors.push(`Row ${i}: ${err.message}`);
        }
    }

    logger.info(`[AA_STUB] Import complete — Imported: ${imported}, Skipped: ${skipped}, Errors: ${errors.length}`);
    return { imported, skipped, errors };
}

/**
 * Get the current balance for a bank account (latest balance_after from transactions).
 *
 * @param {object} pool       - PostgreSQL pool
 * @param {string} accountId  - UUID of the bank account
 * @returns {{ balance: number, as_of: string|null }}
 */
async function getAccountBalance(pool, accountId) {
    const result = await pool.query(
        `SELECT balance_after, txn_date FROM bank_transactions
         WHERE account_id = $1 AND balance_after IS NOT NULL
         ORDER BY txn_date DESC, imported_at DESC LIMIT 1`,
        [accountId]
    );

    if (result.rows.length === 0) {
        return { balance: 0, as_of: null };
    }

    return {
        balance: parseFloat(result.rows[0].balance_after),
        as_of:   result.rows[0].txn_date,
    };
}

/**
 * Normalise date strings from common Indian bank CSV formats.
 */
function normaliseDate(raw) {
    if (!raw) return null;
    raw = raw.trim();

    // DD/MM/YYYY or DD-MM-YYYY
    const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

    // YYYY-MM-DD (already ISO)
    const iso = raw.match(/^\d{4}-\d{2}-\d{2}/);
    if (iso) return raw.slice(0, 10);

    return null;
}

module.exports = { importBankStatementCSV, getAccountBalance };
