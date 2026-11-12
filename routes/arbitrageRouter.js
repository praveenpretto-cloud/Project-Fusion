'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ARBITRAGE & TREASURY SIMULATION ROUTER
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Exposes deterministic treasury arbitrage simulation endpoints.
 *
 * STRICT GOVERNANCE:
 * - Analytical & simulation only.
 * - Does NOT execute trades, submit orders, or mutate balances.
 * - Rejects incomplete parameters, currency mismatches, and invalid quantities.
 */

const express = require('express');
const router = express.Router();
const {
    calculateArbitragePnl,
    getArbitrageReport,
    FEE_REGISTRY,
    DISCLAIMER_TEXT,
    DATA_PROVENANCE,
} = require('../core/treasury/arbitrage');
const logger = require('../logger');

/**
 * POST /api/treasury/arbitrage/calculate
 * POST /api/arbitrage/calculate
 *
 * Calculates deterministic arbitrage P&L and ROI from explicit parameters.
 */
function handleCalculateArbitrage(req, res) {
    try {
        const result = calculateArbitragePnl(req.body);

        if (result.status !== 'SUCCESS') {
            return res.status(400).json(result);
        }

        return res.json(result);
    } catch (err) {
        logger.error('[ARBITRAGE_API] Unexpected calculation failure:', err);
        return res.status(500).json({
            status: 'ERROR',
            error: 'Internal calculation error occurred.',
            isSimulated: true,
            isExecutable: false,
            disclaimer: DISCLAIMER_TEXT,
            dataProvenance: DATA_PROVENANCE,
        });
    }
}

/**
 * GET /api/treasury/arbitrage/simulation-defaults
 *
 * Provides explicit, documented simulation defaults for portfolio demonstration.
 */
function handleGetSimulationDefaults(req, res) {
    const currency = String(req.query.currency || 'USD')
        .trim()
        .toUpperCase();
    const asset = String(req.query.asset || (currency === 'INR' ? 'USDC' : 'XLM'))
        .trim()
        .toUpperCase();

    const defaults = {
        asset,
        quoteCurrency: currency,
        quantity: '10000',
        buyPrice: currency === 'INR' ? '86.50' : '0.1200',
        sellPrice: currency === 'INR' ? '86.95' : '0.1245',
        buySlippageBps: 10,
        sellSlippageBps: 15,
        buyFeeBps: 20,
        buyFeeFixed: currency === 'INR' ? '15.00' : '0.30',
        sellFeeBps: 20,
        sellFeeFixed: currency === 'INR' ? '15.00' : '0.30',
        networkFee: currency === 'INR' ? '5.00' : '0.10',
        transferFee: currency === 'INR' ? '2.00' : '0.05',
        settlementFee: currency === 'INR' ? '2.00' : '0.05',
        dataProvenance: DATA_PROVENANCE,
        disclaimer: DISCLAIMER_TEXT,
    };

    return res.json({
        status: 'SUCCESS',
        isSimulated: true,
        isExecutable: false,
        defaults,
        feeRegistry: FEE_REGISTRY,
    });
}

/**
 * POST /api/treasury/arbitrage/report
 *
 * Batch comparative report endpoint.
 */
function handleGetBatchReport(req, res) {
    const { amount, currency } = req.body || {};
    const report = getArbitrageReport(amount || 0, currency || 'USD');
    return res.json(report);
}

router.post('/treasury/arbitrage/calculate', handleCalculateArbitrage);
router.post('/arbitrage/calculate', handleCalculateArbitrage);
router.get('/treasury/arbitrage/simulation-defaults', handleGetSimulationDefaults);
router.post('/treasury/arbitrage/report', handleGetBatchReport);

module.exports = router;
