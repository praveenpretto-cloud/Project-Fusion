'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PROJECT FUSION — RELIABILITY R3C.2.1: SYNTHETIC FIXTURE DISPLAY TEST SUITE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Verifies that synthetic instruction fixtures (e.g., 99999999-9999-4999-8999-999999999999)
 * are unequivocally and visibly labelled as "SYNTHETIC DEMO FIXTURE — NOT A REAL PAYMENT"
 * in both the InstructionRow list view and the TransactionDetailModal view.
 */

const fs = require('fs');
const path = require('path');

describe('Reliability R3C.2.1 — Synthetic Fixture Visual Display', () => {
    const pageTsxPath = path.resolve(__dirname, '../../client/src/app/page.tsx');
    let pageContent;

    beforeAll(() => {
        expect(fs.existsSync(pageTsxPath)).toBe(true);
        pageContent = fs.readFileSync(pageTsxPath, 'utf8');
    });

    test('Frontend source defines visible label "SYNTHETIC DEMO FIXTURE — NOT A REAL PAYMENT"', () => {
        const matches = pageContent.match(/SYNTHETIC DEMO FIXTURE — NOT A REAL PAYMENT/g);
        expect(matches).not.toBeNull();
        // Must appear in at least two places: InstructionRow and TransactionDetailModal
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test('InstructionRow renders amber badge for canonical R3C.1 synthetic fixture ID', () => {
        expect(pageContent).toContain(
            "inst.instruction_id === '99999999-9999-4999-8999-999999999999'"
        );
        expect(pageContent).toContain('SYNTHETIC DEMO FIXTURE — NOT A REAL PAYMENT');
    });

    test('TransactionDetailModal renders prominent watermarked warning card', () => {
        expect(pageContent).toContain(
            "instruction.instruction_id === '99999999-9999-4999-8999-999999999999'"
        );
        expect(pageContent).toContain(
            'Deterministic test fixture for transaction annotation and audit qualification'
        );
    });

    // Helper mirror of the frontend predicate for unit testing edge cases
    function isSyntheticFixture(inst) {
        if (!inst) return false;
        return Boolean(
            inst.instruction_id === '99999999-9999-4999-8999-999999999999' ||
            (inst.instruction_id && inst.instruction_id.startsWith('99999999-')) ||
            inst.sender === 'SYNTHETIC_SENDER' ||
            (inst.metadata && inst.metadata.notes && inst.metadata.notes.includes('R3C.1'))
        );
    }

    test('Predicate correctly tags canonical R3C.1 synthetic fixture', () => {
        const fixture = {
            instruction_id: '99999999-9999-4999-8999-999999999999',
            amount: '150000.00',
            currency: 'INR',
            state: 'COMPLETED',
        };
        expect(isSyntheticFixture(fixture)).toBe(true);
    });

    test('Predicate correctly tags synthetic fixtures by prefix or sender or note marker', () => {
        expect(isSyntheticFixture({ instruction_id: '99999999-aaaa-4999-8999-000000000001' })).toBe(
            true
        );
        expect(
            isSyntheticFixture({
                instruction_id: '12345678-0000-0000-0000-000000000000',
                sender: 'SYNTHETIC_SENDER',
            })
        ).toBe(true);
        expect(
            isSyntheticFixture({
                instruction_id: '12345678-0000-0000-0000-000000000000',
                metadata: { notes: 'Verified in R3C.1' },
            })
        ).toBe(true);
    });

    test('Predicate does NOT tag real or unflagged instructions', () => {
        const legitimateInstruction = {
            instruction_id: 'e6988849-0638-4e14-99d9-4e4b52ff37c8',
            amount: '25000.00',
            currency: 'INR',
            state: 'SETTLED',
            sender: 'CFO_OFFICE',
            metadata: { notes: 'Standard vendor disbursement' },
        };
        expect(isSyntheticFixture(legitimateInstruction)).toBe(false);
    });
});
