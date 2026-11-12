const crypto = require('crypto');
const logger = require('../../logger');
const { toCanonicalDecimal, decimalAdd, decimalEquals } = require('./financialDecimal');

/**
 * DOUBLE-ENTRY INTEGRITY ASSERTION (WITH HASH CHAIN & EXACT DECIMAL ARITHMETIC)
 */
async function writeLedger(
    client,
    instructionId,
    sender,
    recipient,
    amount,
    currency,
    taxWithheld = 0
) {
    const entryId1 = crypto.randomUUID();
    const entryId2 = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // 1. Transaction-Level Advisory Lock (SERIALIZABLE SAGA TIP)
    await client.query('SELECT pg_advisory_xact_lock(998877)');

    const lastEntry = await client.query(
        'SELECT hash FROM ledger_journal ORDER BY sequence_id DESC LIMIT 1'
    );
    let prevHash = lastEntry.rows.length > 0 ? lastEntry.rows[0].hash : 'GENESIS_HASH';

    // Canonical financial decimal representations (never convert to JS float)
    const canonicalNet = toCanonicalDecimal(amount, currency);
    const canonicalGross = decimalAdd(amount, taxWithheld, currency);

    // 2. CHAIN ENTRY 1: DEBIT SENDER (GROSS)
    const payload1 = `${prevHash}${entryId1}${instructionId}${sender}DEBIT${canonicalGross}${currency}${timestamp}`;
    const hash1 = crypto.createHash('sha256').update(payload1).digest('hex');
    await client.query(
        `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
         VALUES ($1, $2, $3, 'DEBIT', $4, $5, $6, $7, $8)`,
        [entryId1, instructionId, sender, canonicalGross, currency, timestamp, hash1, prevHash]
    );

    // 3. CHAIN ENTRY 2: CREDIT RECIPIENT (NET)
    const payload2 = `${hash1}${entryId2}${instructionId}${recipient}CREDIT${canonicalNet}${currency}${timestamp}`;
    const hash2 = crypto.createHash('sha256').update(payload2).digest('hex');
    await client.query(
        `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
         VALUES ($1, $2, $3, 'CREDIT', $4, $5, $6, $7, $8)`,
        [entryId2, instructionId, recipient, canonicalNet, currency, timestamp, hash2, hash1]
    );

    const finalHash = hash2;
    logger.info(`[LEDGER] Atomic Write Success. Final Hash: ${finalHash.substring(0, 8)}`);
}

/**
 * COMPENSATING DOUBLE-ENTRY REFUND LEDGER ENTRY (WITH HASH CHAIN & BALANCED ENTRIES)
 *
 * Reverses captured settlement balances by:
 * - DEBITING recipient (clearing / merchant) for the refunded amount
 * - CREDITING sender (treasury / customer) for the refunded amount
 *
 * @param {object} client - PostgreSQL transaction client
 * @param {string} instructionId - UUID of the instruction being refunded
 * @param {string} originalSender - Original sender account (e.g. ACC_SENDER or treasury)
 * @param {string} originalRecipient - Original recipient account (e.g. ACC_RECIPIENT or clearing)
 * @param {string|number} refundAmount - Amount being refunded
 * @param {string} currency - Currency code
 * @param {string} refundId - Provider refund identifier (e.g. 're_...')
 * @returns {Promise<{ entryIdDebit: string, entryIdCredit: string, hash: string }>}
 */
async function writeCompensatingLedger(
    client,
    instructionId,
    originalSender,
    originalRecipient,
    refundAmount,
    currency,
    refundId
) {
    const entryId1 = crypto.randomUUID();
    const entryId2 = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // 1. Transaction-Level Advisory Lock (SERIALIZABLE SAGA TIP)
    await client.query('SELECT pg_advisory_xact_lock(998877)');

    const lastEntry = await client.query(
        'SELECT hash FROM ledger_journal ORDER BY sequence_id DESC LIMIT 1'
    );
    let prevHash = lastEntry.rows.length > 0 ? lastEntry.rows[0].hash : 'GENESIS_HASH';

    const canonicalRefund = toCanonicalDecimal(refundAmount, currency);

    // 2. CHAIN ENTRY 1: DEBIT RECIPIENT (Reversing the original credit to recipient)
    const payload1 = `${prevHash}${entryId1}${instructionId}${originalRecipient}DEBIT${canonicalRefund}${currency}${timestamp}`;
    const hash1 = crypto.createHash('sha256').update(payload1).digest('hex');
    await client.query(
        `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
         VALUES ($1, $2, $3, 'DEBIT', $4, $5, $6, $7, $8)`,
        [
            entryId1,
            instructionId,
            originalRecipient,
            canonicalRefund,
            currency,
            timestamp,
            hash1,
            prevHash,
        ]
    );

    // 3. CHAIN ENTRY 2: CREDIT SENDER (Reversing the original debit from sender)
    const payload2 = `${hash1}${entryId2}${instructionId}${originalSender}CREDIT${canonicalRefund}${currency}${timestamp}`;
    const hash2 = crypto.createHash('sha256').update(payload2).digest('hex');
    await client.query(
        `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
         VALUES ($1, $2, $3, 'CREDIT', $4, $5, $6, $7, $8)`,
        [
            entryId2,
            instructionId,
            originalSender,
            canonicalRefund,
            currency,
            timestamp,
            hash2,
            hash1,
        ]
    );

    const finalHash = hash2;
    logger.info(
        `[LEDGER] Compensating Refund Write Success. Refund: ${refundId || 'N/A'}, Final Hash: ${finalHash.substring(0, 8)}`
    );

    return {
        entryIdDebit: entryId1,
        entryIdCredit: entryId2,
        hash: finalHash,
    };
}

/**
 * DOUBLE-ENTRY VERIFICATION
 */
async function verifyLedgerIntegrity(client, instructionId, currency, taxWithheld = 0) {
    const ledgerCheck = await client.query(
        `SELECT 
            SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END) as total_debit,
            SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END) as total_credit
         FROM ledger_journal 
         WHERE instruction_id = $1 AND currency = $2`,
        [instructionId, currency]
    );

    const { total_debit, total_credit } = ledgerCheck.rows[0];
    const balancedCredit = decimalAdd(total_credit || 0, taxWithheld || 0, currency);

    if (!decimalEquals(total_debit || 0, balancedCredit, currency)) {
        throw new Error(
            `LEDGER_INTEGRITY_FAILED: Debit (${total_debit}) !== Credit+Tax (${balancedCredit})`
        );
    }
    return true;
}

module.exports = {
    writeLedger,
    writeCompensatingLedger,
    verifyLedgerIntegrity,
    toCanonicalDecimal,
    decimalAdd,
    decimalEquals,
};
