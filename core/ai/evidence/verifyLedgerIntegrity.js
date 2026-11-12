'use strict';

const { toCanonicalDecimal, decimalAdd, decimalEquals } = require('../../orchestrator/financialDecimal');
const { computePayloadHash } = require('./ledgerHashHelper');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Verifies that prevHash is the immediate preceding committed global ledger entry.
 * Validates either GENESIS_HASH or linear NOT EXISTS continuity.
 * 
 * @param {object} client - Database query client
 * @param {string} prevHash - Predecessor hash reference
 * @param {number|string} currentSeq - Sequence ID of the entry being verified
 * @returns {Promise<'PREDECESSOR_VERIFIED' | 'GENESIS_VERIFIED' | 'PREDECESSOR_NOT_IMMEDIATE' | 'PREDECESSOR_HASH_NOT_FOUND' | 'PREDECESSOR_SEQUENCE_VIOLATION' | 'INVALID_GENESIS_PREDECESSOR_EXISTS'>}
 */
async function verifyImmediatePredecessor(client, prevHash, currentSeq) {
    if (prevHash === 'GENESIS_HASH') {
        const genesisSql = `
            SELECT NOT EXISTS (
                SELECT 1 
                FROM ledger_journal 
                WHERE sequence_id < $1
            ) AS is_valid_genesis;
        `;
        const genesisResult = await client.query(genesisSql, [currentSeq]);
        const isValidGenesis = (genesisResult && genesisResult.rows && genesisResult.rows.length > 0)
            ? Boolean(genesisResult.rows[0].is_valid_genesis)
            : false;

        return isValidGenesis
            ? 'GENESIS_VERIFIED'
            : 'INVALID_GENESIS_PREDECESSOR_EXISTS';
    }

    const predSql = `
        SELECT 1 
        FROM ledger_journal P
        WHERE P.hash = $1 
          AND P.sequence_id < $2
          AND NOT EXISTS (
              SELECT 1 
              FROM ledger_journal I 
              WHERE I.sequence_id > P.sequence_id 
                AND I.sequence_id < $2
          )
        LIMIT 1;
    `;
    const predResult = await client.query(predSql, [prevHash, currentSeq]);

    if (predResult && predResult.rows && predResult.rows.length > 0) {
        return 'PREDECESSOR_VERIFIED';
    }

    // Diagnostics if immediate check fails
    const diagSql = `
        SELECT sequence_id 
        FROM ledger_journal 
        WHERE hash = $1 
        LIMIT 1;
    `;
    const diagResult = await client.query(diagSql, [prevHash]);

    if (!diagResult || !diagResult.rows || diagResult.rows.length === 0) {
        return 'PREDECESSOR_HASH_NOT_FOUND';
    }

    const foundSeq = BigInt(diagResult.rows[0].sequence_id);
    if (foundSeq >= BigInt(currentSeq)) {
        return 'PREDECESSOR_SEQUENCE_VIOLATION';
    }

    return 'PREDECESSOR_NOT_IMMEDIATE';
}

/**
 * Tool 5: verifyLedgerIntegrity
 * 
 * Conducts a rigorous five-dimension transaction-scoped verification of ledger entries.
 * Evaluates:
 * 1. Application posting consistency (total_debit === total_credit + tax_withheld).
 * 2. Debit-credit arithmetic equality (DEBITS_EQUAL_CREDITS).
 * 3. Individual entry hash validity (SHA-256 payload integrity, canonical & legacy).
 * 4. Internal transaction link continuity (Entry 2 prev_hash === Entry 1 hash).
 * 5. Immediate global predecessor validity for BOTH Entry 1 and Entry 2 (NOT EXISTS intervening rows).
 * 
 * Prohibits: collapsing results into a single misleading status; assuming conventional
 * double-entry balance when tax is withheld; leaking predecessor financial fields.
 * 
 * @param {object} client - Database query client ({ query: Function })
 * @param {string} instructionId - Target instruction UUID
 * @returns {Promise<object>} Structured five-dimension verification report
 */
async function verifyLedgerIntegrity(client, instructionId) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('verifyLedgerIntegrity: client with query method is required');
    }

    if (!instructionId || typeof instructionId !== 'string' || !UUID_REGEX.test(instructionId.trim())) {
        return {
            success: false,
            status: 'INVALID_IDENTIFIER',
            message: 'instructionId must be a valid UUID string',
            dimensions: null
        };
    }

    const cleanId = instructionId.trim();

    // Step 1: Query target instruction metadata
    const instSql = `
        SELECT instruction_id, currency, tax_withheld, state 
        FROM instructions 
        WHERE instruction_id = $1 
        LIMIT 1;
    `;
    const instResult = await client.query(instSql, [cleanId]);

    if (!instResult || !instResult.rows || instResult.rows.length === 0) {
        return {
            success: false,
            status: 'NOT_FOUND',
            message: `No instruction found for ID '${cleanId}'`,
            dimensions: null
        };
    }

    const instruction = instResult.rows[0];
    const currency = instruction.currency;

    // Step 2: Query ledger journal entries ordered by sequence_id ASC
    const ledgerSql = `
        SELECT 
            entry_id, 
            instruction_id, 
            account_id, 
            direction, 
            amount, 
            currency, 
            timestamp, 
            hash, 
            prev_hash, 
            sequence_id
        FROM ledger_journal
        WHERE instruction_id = $1
        ORDER BY sequence_id ASC;
    `;
    const ledgerResult = await client.query(ledgerSql, [cleanId]);
    const ledgerRows = (ledgerResult && ledgerResult.rows) ? ledgerResult.rows : [];

    // Case 2A: Zero ledger entries recorded
    if (ledgerRows.length === 0) {
        return {
            success: true,
            status: 'NO_LEDGER_ENTRIES_RECORDED',
            instruction_id: cleanId,
            instruction_state: instruction.state,
            discrepancy: instruction.state === 'SETTLED' ? 'INCONSISTENCY_SETTLED_WITHOUT_LEDGER' : null,
            message: 'No ledger journal entries found for this instruction',
            dimensions: null
        };
    }

    // Case 2B: Unexpected entry count (Standard Fusion posting requires exactly 2: 1 DEBIT, 1 CREDIT)
    if (ledgerRows.length !== 2) {
        return {
            success: false,
            status: 'UNEXPECTED_ENTRY_COUNT',
            instruction_id: cleanId,
            message: `Expected exactly 2 entries for standard transaction posting, found ${ledgerRows.length}`,
            entries_found: ledgerRows.length,
            dimensions: null
        };
    }

    // Identify DEBIT and CREDIT entries
    const debitEntry = ledgerRows.find(r => r.direction === 'DEBIT');
    const creditEntry = ledgerRows.find(r => r.direction === 'CREDIT');

    if (!debitEntry || !creditEntry) {
        return {
            success: false,
            status: 'INCOMPLETE_POSTING_PAIR',
            message: 'Ledger entries do not form a valid DEBIT and CREDIT pair',
            dimensions: null
        };
    }

    // Currency consistency check across instruction and entries
    if (debitEntry.currency !== currency || creditEntry.currency !== currency) {
        return {
            success: false,
            status: 'CURRENCY_MISMATCH',
            message: `Currency mismatch: instruction is '${currency}', debit entry is '${debitEntry.currency}', credit entry is '${creditEntry.currency}'`,
            dimensions: null
        };
    }

    // =========================================================================
    // DIMENSION 1: APPLICATION POSTING CONSISTENCY
    // =========================================================================
    let applicationPostingConsistency = 'UNVERIFIED';
    let taxWithheldStatus = 'VERIFIED';
    let canonicalGross = null;
    let canonicalNet = null;
    let taxWithheldStr = null;

    if (instruction.tax_withheld === null || instruction.tax_withheld === undefined) {
        applicationPostingConsistency = 'UNVERIFIABLE_MISSING_TAX_DATA';
        taxWithheldStatus = 'TAX_DATA_UNAVAILABLE';
        canonicalGross = toCanonicalDecimal(debitEntry.amount, currency);
        canonicalNet = toCanonicalDecimal(creditEntry.amount, currency);
    } else {
        canonicalGross = toCanonicalDecimal(debitEntry.amount, currency);
        canonicalNet = toCanonicalDecimal(creditEntry.amount, currency);
        taxWithheldStr = toCanonicalDecimal(instruction.tax_withheld, currency);

        const expectedGross = decimalAdd(canonicalNet, taxWithheldStr, currency);
        const matchesPostingEquation = decimalEquals(canonicalGross, expectedGross, currency);

        applicationPostingConsistency = matchesPostingEquation
            ? 'CONSISTENT'
            : 'POSTING_ARITHMETIC_MISMATCH';
    }

    // =========================================================================
    // DIMENSION 2: CONVENTIONAL DOUBLE-ENTRY BALANCE (DEBITS_EQUAL_CREDITS)
    // =========================================================================
    let conventionalDoubleEntryBalance = 'UNVERIFIED';
    let debitsEqualCredits = false;

    if (canonicalGross && canonicalNet) {
        debitsEqualCredits = decimalEquals(canonicalGross, canonicalNet, currency);

        if (taxWithheldStr && !decimalEquals(taxWithheldStr, 0, currency)) {
            // Tax was withheld; no credit posting to tax liability account exists
            conventionalDoubleEntryBalance = 'UNBALANCED_NO_TAX_LIABILITY_POSTING';
        } else if (debitsEqualCredits) {
            conventionalDoubleEntryBalance = 'DEBITS_EQUAL_CREDITS';
        } else {
            conventionalDoubleEntryBalance = 'ARITHMETIC_EQUALITY_FAILED';
        }
    }

    // =========================================================================
    // DIMENSION 3: INDIVIDUAL ENTRY HASH VALIDITY
    // =========================================================================
    let entryHashValidity = 'VALID';
    const entry1HashResult = computePayloadHash(ledgerRows[0]);
    const entry2HashResult = computePayloadHash(ledgerRows[1]);

    const entry1Matches = (ledgerRows[0].hash && ledgerRows[0].hash === entry1HashResult.hash);
    const entry2Matches = (ledgerRows[1].hash && ledgerRows[1].hash === entry2HashResult.hash);

    if (!entry1Matches || !entry2Matches) {
        entryHashValidity = 'ENTRY_HASH_MISMATCH';
    } else if (entry1HashResult.format !== 'CANONICAL' || entry2HashResult.format !== 'CANONICAL') {
        entryHashValidity = 'VERIFIED_LEGACY_FORMAT';
    }

    // =========================================================================
    // DIMENSION 4 & 5: INTERNAL LINK CONTINUITY & IMMEDIATE GLOBAL PREDECESSORS
    // =========================================================================
    let internalLinkContinuity = 'CONTINUOUS';
    const entry1Hash = ledgerRows[0].hash;
    const entry2PrevHash = ledgerRows[1].prev_hash;
    const seq1 = BigInt(ledgerRows[0].sequence_id);
    const seq2 = BigInt(ledgerRows[1].sequence_id);

    if (entry2PrevHash !== entry1Hash || seq2 <= seq1) {
        internalLinkContinuity = 'INTERNAL_LINK_BROKEN';
    }

    // Verify immediate global predecessor for Entry 1
    const entry1PrevHash = ledgerRows[0].prev_hash;
    const entry1Seq = ledgerRows[0].sequence_id;
    const entry1PredStatus = await verifyImmediatePredecessor(client, entry1PrevHash, entry1Seq);

    // Verify immediate global predecessor for Entry 2
    const entry2Seq = ledgerRows[1].sequence_id;
    const entry2PredStatus = await verifyImmediatePredecessor(client, entry2PrevHash, entry2Seq);

    // If Entry 2 has an intervening committed row, internal link is not immediate
    if (entry2PredStatus === 'PREDECESSOR_NOT_IMMEDIATE') {
        internalLinkContinuity = 'INTERNAL_LINK_NOT_IMMEDIATE';
    } else if (entry2PredStatus === 'PREDECESSOR_HASH_NOT_FOUND' || entry2PredStatus === 'PREDECESSOR_SEQUENCE_VIOLATION') {
        internalLinkContinuity = 'INTERNAL_LINK_BROKEN';
    }

    let immediateGlobalPredecessor = 'UNVERIFIED';
    if (entry1PredStatus !== 'PREDECESSOR_VERIFIED' && entry1PredStatus !== 'GENESIS_VERIFIED') {
        immediateGlobalPredecessor = entry1PredStatus;
    } else if (entry2PredStatus !== 'PREDECESSOR_VERIFIED') {
        immediateGlobalPredecessor = entry2PredStatus;
    } else if (entry1PredStatus === 'GENESIS_VERIFIED') {
        immediateGlobalPredecessor = 'GENESIS_VERIFIED';
    } else {
        immediateGlobalPredecessor = 'PREDECESSOR_VERIFIED';
    }

    const allDimensionsPassed = 
        applicationPostingConsistency === 'CONSISTENT' &&
        (entryHashValidity === 'VALID' || entryHashValidity === 'VERIFIED_LEGACY_FORMAT') &&
        internalLinkContinuity === 'CONTINUOUS' &&
        (entry1PredStatus === 'PREDECESSOR_VERIFIED' || entry1PredStatus === 'GENESIS_VERIFIED') &&
        entry2PredStatus === 'PREDECESSOR_VERIFIED';

    return {
        success: true,
        status: allDimensionsPassed ? 'LEDGER_VERIFIED' : 'LEDGER_INTEGRITY_MISMATCH',
        instruction_id: cleanId,
        currency,
        dimensions: {
            application_posting_consistency: applicationPostingConsistency,
            conventional_double_entry_balance: conventionalDoubleEntryBalance,
            debits_equal_credits: conventionalDoubleEntryBalance,
            entry_hash_validity: entryHashValidity,
            internal_link_continuity: internalLinkContinuity,
            immediate_global_predecessor: immediateGlobalPredecessor,
            predecessor_detail: {
                entry_1: entry1PredStatus,
                entry_2: entry2PredStatus
            }
        },
        arithmetic_summary: {
            debits_equal_credits: debitsEqualCredits,
            debit_gross: canonicalGross,
            credit_net: canonicalNet,
            tax_withheld: taxWithheldStr,
            tax_withheld_status: taxWithheldStatus
        },
        audit_note: 'Conventional double-entry equality (DEBITS_EQUAL_CREDITS) is distinct from application posting consistency; tax withheld is not credited to a separate liability account.'
    };
}

module.exports = {
    verifyLedgerIntegrity,
    verifyImmediatePredecessor,
};

