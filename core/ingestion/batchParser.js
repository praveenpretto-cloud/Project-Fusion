'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * EXPORTER BATCH PARSER & ROUTER
 * FCSS Exporter Foreign-Currency Management Module — IFSCA 2026 priority
 * ════════════════════════════════════════════════════════════════════════════
 *
 * White-Label Aggregator Model:
 * All instructions are executed using Fusion's master gateway credentials.
 * There is no per-client BYOK (Bring Your Own Key) validation step.
 * The parser focuses purely on payload enrichment and smart routing.
 */

const crypto = require('crypto');
const logger = require('../../logger');
const {
    toCanonicalDecimal,
    decimalCompare,
    ASSET_MIN_AMOUNT,
} = require('../orchestrator/financialDecimal');

/**
 * Parses an incoming API payload or CSV JSON array.
 * Detects Exporter Inflows (FCSS) and auto-enriches rows with required metadata.
 *
 * @param {Array<Object>} rawBatch - Array of instruction objects from the client
 * @returns {Array<Object>} Parsed and enriched instructions
 */
function parseBatch(rawBatch) {
    if (!Array.isArray(rawBatch)) return [];

    return rawBatch.map((item) => {
        if (typeof item.amount === 'number') {
            throw new TypeError(
                'Unsafe JavaScript Number monetary inputs are rejected. Pass amount as a decimal string.'
            );
        }
        if (typeof item.tax_withheld === 'number') {
            throw new TypeError(
                'Unsafe JavaScript Number monetary inputs are rejected. Pass tax_withheld as a decimal string.'
            );
        }
        if (typeof item.net_amount === 'number') {
            throw new TypeError(
                'Unsafe JavaScript Number monetary inputs are rejected. Pass net_amount as a decimal string.'
            );
        }

        const rawCurrency = (item.currency || '').toString().trim().toUpperCase();
        const currency = rawCurrency === 'INDIAN' ? 'INR' : rawCurrency;
        const amount = toCanonicalDecimal(item.amount, currency);
        const purpose = (item.purpose || '').toUpperCase();

        const minAmount =
            currency && ASSET_MIN_AMOUNT && ASSET_MIN_AMOUNT[currency]
                ? ASSET_MIN_AMOUNT[currency]
                : '0.01';
        if (decimalCompare(amount, minAmount, currency) < 0) {
            throw new RangeError(`Amount must be at least ${minAmount} for ${currency}`);
        }

        // 1. Detect Exporter Inflow:
        // Either explicitly flagged via API, OR auto-detected via currency/purpose heuristics.
        const isForeignCurrency = ['USD', 'EUR'].includes(currency);
        const isExporterPurpose =
            purpose.includes('EXPORT') ||
            purpose.includes('SUPPLY') ||
            purpose.includes('TREASURY');

        const isExporterInflow =
            item.isExporterInflow === true ||
            item.isExporterInflow === 'true' ||
            (isForeignCurrency && isExporterPurpose && decimalCompare(amount, '0', currency) > 0);

        const taxWithheld =
            item.tax_withheld !== undefined && item.tax_withheld !== null
                ? toCanonicalDecimal(item.tax_withheld, currency)
                : toCanonicalDecimal(0, currency);

        const netAmount =
            item.net_amount !== undefined && item.net_amount !== null
                ? toCanonicalDecimal(item.net_amount, currency)
                : amount;

        // 2. Base Instruction Assembly
        const instruction = {
            ...item,
            instruction_id: item.instruction_id || crypto.randomUUID(),
            amount,
            currency,
            state: 'PENDING_APPROVAL', // Maker-Checker gate
            created_at: new Date().toISOString(),
            is_exporter_inflow: isExporterInflow,
            tax_withheld: taxWithheld,
            net_amount: netAmount,
        };

        // 3. FCSS & ISO 20022 Enrichment
        if (isExporterInflow) {
            // DISABLED FOR REAL TESTNET RUN: Prefer Stripe/RazorpayX testnets over FCSS mock
            instruction.fcss_eligible = false;
            // CCIL IFSC requires pacs.008 for RTGS credit transfers
            instruction.iso_message_type = 'pacs.008.001.10';
            instruction.settlement_method = 'CLRG';
            instruction.clearing_system = 'FCSS-CCIL-IFSC';
            instruction.regulatory_reporting = 'FEMA_SEC_8';
            logger.info(
                `[BATCH_PARSER] 🌐 Exporter Inflow Detected: ${instruction.instruction_id} (${instruction.currency} ${instruction.amount}) - Routing via Global Fiat Network`
            );
        }

        return instruction;
    });
}

/**
 * Routes a parsed batch to the appropriate SAGA or Kafka topic.
 * Fusion executes all payments using master credentials — no per-client key validation.
 *
 * @param {Array<Object>} parsedInstructions - Instructions from parseBatch()
 * @returns {Promise<Object>} Routing layout { fcssSaga: [], fiat: [], crypto: [], marketplace: [] }
 */
async function routeBatch(parsedInstructions) {
    const fcssSaga = [];
    const fiat = [];
    const cryptoFlow = [];
    const marketplace = [];

    for (const inst of parsedInstructions) {
        // ── FCSS EXPORTER ROUTING ─────────────────────────────────────────────
        // In the aggregator model, FCSS routes directly without any BYOK check.
        // Fusion uses its own master credentials for the FCSS/RTGS rail.
        if (inst.is_exporter_inflow && inst.fcss_eligible) {
            inst._routing_target = 'SAGA_EXPORTER_FX';
            inst.provider = 'FUSION_MASTER';
            fcssSaga.push(inst);
            logger.info(
                `[BATCH_ROUTING] 🏦 Routed to FCSS SAGA: ${inst.instruction_id} (Master Credentials)`
            );
            continue;
        }

        // ── STANDARD ROUTING ──────────────────────────────────────────────────
        if (['USDC', 'XLM', 'BTC', 'ETH'].includes(inst.currency)) {
            inst._routing_target = 'KAFKA_CRYPTO';
            inst.provider = 'FUSION_MASTER';
            cryptoFlow.push(inst);
        } else if (inst.purpose && inst.purpose.toUpperCase().trim() === 'MARKETPLACE_PAYOUT') {
            inst._routing_target = 'KAFKA_MARKETPLACE';
            inst.provider = 'FUSION_MASTER';
            marketplace.push(inst);
        } else {
            inst._routing_target = 'KAFKA_FIAT';
            inst.provider = 'FUSION_MASTER';
            fiat.push(inst);
        }
    }

    return {
        fcssSaga,
        fiat,
        cryptoFlow,
        marketplace,
    };
}

module.exports = {
    parseBatch,
    routeBatch,
};
