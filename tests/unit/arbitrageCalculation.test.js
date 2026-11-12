'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PROJECT FUSION — RELIABILITY R2C.1
 * ARBITRAGE PRECISION & NUMERICAL INTEGRITY TEST SUITE
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * Verifies the numerical precision, intermediate fidelity, and governance
 * corrections specified in Reliability R2C.1 Task 6:
 * 
 * 1. The exact Scenario 1 fixture (reconciling to 91.3002 raw / 91.30 rounded, 7.58% ROI).
 * 2. Scenario 2 with negative net P&L.
 * 3. Very small unit prices and large quantities.
 * 4. High-precision adjusted buy and sell prices.
 * 5. Fractional quantities where permitted.
 * 6. Positive and negative half-up rounding boundaries.
 * 7. ROI calculation precision.
 * 8. Monetary input supplied as unsafe JavaScript Number.
 * 9. Large monetary inputs supplied as decimal strings.
 * 10. Sell slippage at and above 10,000 bps.
 * 11. Currency non-comparability returning NOT_COMPARABLE.
 * 12. Explicit fee assumptions and provenance.
 */

const fs = require('fs');
const path = require('path');
const {
    decimalAdd,
    decimalSubtract,
    decimalMultiply,
    decimalDivide,
    decimalRound,
    trimTrailingZeros,
    parseDecimalParts,
    toCanonicalDecimal
} = require('../../core/orchestrator/financialDecimal');
const {
    calculateArbitragePnl,
    validateArbitrageInput,
    getArbitrageReport,
    calculateEstimatedFee,
    FEE_REGISTRY,
    DISCLAIMER_TEXT,
    DATA_PROVENANCE
} = require('../../core/treasury/arbitrage');
const arbitrageRouter = require('../../routes/arbitrageRouter');

/**
 * Helper to invoke Express router handler with mock req/res
 */
function invokeRouterHandler(routePath, method, body, query = {}) {
    return new Promise((resolve) => {
        const req = {
            method,
            path: routePath,
            url: routePath,
            body: body || {},
            query: query || {},
            headers: { 'content-type': 'application/json' }
        };
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(data) {
                this.body = data;
                resolve({ statusCode: this.statusCode, body: this.body });
                return this;
            }
        };

        const layer = arbitrageRouter.stack.find((l) => {
            return l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()];
        });

        if (layer) {
            layer.route.stack[0].handle(req, res);
        } else {
            resolve({ statusCode: 404, body: { error: 'Route not found in test harness' } });
        }
    });
}

describe('Project Fusion — R2C.1: Financial Decimal Utility Extensions', () => {
    test('decimalSubtract: computes exact differences and handles arbitrary precision', () => {
        expect(decimalSubtract('10.50', '2.25', 'USD')).toBe('8.25');
        expect(decimalSubtract('5.00', '10.00', 'USD')).toBe('-5.00');
        expect(decimalSubtract('100.0000000', '99.9999999', 'XLM')).toBe('0.0000001');
        expect(decimalSubtract('0.00', '0.00', 'USD')).toBe('0.00');
        expect(decimalSubtract('1295.6026', '1204.3024', 4)).toBe('91.3002');
    });

    test('decimalMultiply: multiplies exact decimals with half-up rounding', () => {
        expect(decimalMultiply('10', '0.125', 2)).toBe('1.25');
        expect(decimalMultiply('10', '0.1254', 2)).toBe('1.25');
        expect(decimalMultiply('10', '0.1255', 2)).toBe('1.26'); // Half-up rounds 5 up
        expect(decimalMultiply('1000', '0.0001', 2)).toBe('0.10');
        expect(decimalMultiply('-5', '2.5', 2)).toBe('-12.50');
    });

    test('decimalDivide: divides exact decimals with half-up rounding', () => {
        expect(decimalDivide('10', '3', 2)).toBe('3.33');
        expect(decimalDivide('2', '3', 2)).toBe('0.67');
        expect(decimalDivide('1', '8', 2)).toBe('0.13'); // 0.125 -> 0.13
        expect(decimalDivide('1', '4', 1)).toBe('0.3');  // 0.25 -> 0.3
        expect(decimalDivide('-10', '4', 2)).toBe('-2.50');
        expect(() => decimalDivide('10', '0', 2)).toThrow(/Division by zero/);
    });

    test('decimalRound: rounds half-away-from-zero accurately for positive and negative numbers', () => {
        expect(decimalRound('0.005', 2)).toBe('0.01');
        expect(decimalRound('0.004', 2)).toBe('0.00');
        expect(decimalRound('-0.005', 2)).toBe('-0.01');
        expect(decimalRound('-0.004', 2)).toBe('0.00');
        expect(decimalRound('6.1998', 2)).toBe('6.20');
        expect(decimalRound('91.3002', 2)).toBe('91.30');
        expect(decimalRound('-91.3050', 2)).toBe('-91.31');
        expect(decimalRound('-91.3049', 2)).toBe('-91.30');
    });

    test('trimTrailingZeros: preserves canonical representation while removing unnecessary trailing zeroes', () => {
        expect(trimTrailingZeros('0.12012000', 4)).toBe('0.12012');
        expect(trimTrailingZeros('0.12987000', 4)).toBe('0.12987');
        expect(trimTrailingZeros('1201.20000000', 2)).toBe('1201.20');
        expect(trimTrailingZeros('91.30020000', 2)).toBe('91.3002');
    });
});

describe('Project Fusion — R2C.1: Arbitrage Precision and Numerical Integrity (12 Scenarios)', () => {

    // SCENARIO 1: The exact Scenario 1 fixture from R2C.1 Task 1
    test('Scenario 1: Exact Scenario 1 fixture reconciles precisely to documented intermediate and final values', () => {
        const input = {
            quantity: '10000',
            asset: 'XLM',
            quoteCurrency: 'USD',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buySlippageBps: 10,
            sellSlippageBps: 10,
            buyFeeBps: 20,
            sellFeeBps: 20,
            buyFeeFixed: '0.50',
            sellFeeFixed: '0.50',
            networkFee: '0.20',
            transferFee: '0.00',
            settlementFee: '0.00'
        };

        const result = calculateArbitragePnl(input);

        expect(result.status).toBe('SUCCESS');
        expect(result.isProfitable).toBe(true);

        // Exact intermediate and calculation reconciliation as documented:
        expect(result.adjustedBuyPrice).toBe('0.12012');
        expect(result.adjustedSellPrice).toBe('0.12987');
        expect(result.buyNotional).toBe('1201.20');
        expect(result.sellNotional).toBe('1298.70');
        expect(result.fees.buyPercentageFee).toBe('2.4024');
        expect(result.fees.sellPercentageFee).toBe('2.5974');
        expect(result.fees.totalBuyFee).toBe('2.9024');
        expect(result.fees.totalSellFee).toBe('3.0974');
        expect(result.totalEstimatedCosts).toBe('6.1998');
        expect(result.totalAcquisitionCost).toBe('1204.3024');
        expect(result.netSaleProceeds).toBe('1295.6026');
        expect(result.netProceeds).toBe('1295.6026');
        expect(result.estimatedNetPnL).toBe('91.3002');
        expect(result.netProfit).toBe('91.3002');
        expect(result.grossProceeds).toBe('1298.70');
        expect(result.grossTotalOutlays).toBe('1207.3998');
        expect(result.rawRoiPercent).toBe('7.581169%');
        expect(result.estimatedRoiPercent).toBe('7.58%');

        // Final display/settlement rounded outputs (quoteScale = 2):
        expect(result.display.buyNotional).toBe('1201.20');
        expect(result.display.sellNotional).toBe('1298.70');
        expect(result.display.grossProceeds).toBe('1298.70');
        expect(result.display.totalEstimatedCosts).toBe('6.20');
        expect(result.display.totalAcquisitionCost).toBe('1204.30');
        expect(result.display.grossTotalOutlays).toBe('1207.40');
        expect(result.display.netSaleProceeds).toBe('1295.60');
        expect(result.display.netProceeds).toBe('1295.60');
        expect(result.display.estimatedNetPnL).toBe('91.30');
        expect(result.display.netProfit).toBe('91.30');
        expect(result.display.estimatedRoiPercent).toBe('7.58%');
    });

    // SCENARIO 2: Scenario 2 with negative net P&L
    test('Scenario 2: Unprofitable scenario with negative net P&L and correct negative rounding', () => {
        const result = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '1000',
            buyPrice: '0.1250',
            sellPrice: '0.1200',
            buySlippageBps: 10,
            sellSlippageBps: 10,
            buyFeeBps: 20,
            buyFeeFixed: '0.30',
            sellFeeBps: 20,
            sellFeeFixed: '0.30',
            networkFee: '0.10',
            transferFee: '0.05',
            settlementFee: '0.05'
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.isProfitable).toBe(false);
        expect(parseFloat(result.estimatedNetPnL)).toBeLessThan(0);
        expect(parseFloat(result.estimatedRoiPercent)).toBeLessThan(0);
        expect(result.display.estimatedNetPnL.startsWith('-')).toBe(true);
    });

    // SCENARIO 3: Very small unit prices and large quantities
    test('Scenario 3: Very small unit prices and large quantities retain precision without underflow', () => {
        const result = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '100000000', // 100M units
            buyPrice: '0.00001234',
            sellPrice: '0.00001290',
            buySlippageBps: 5,
            sellSlippageBps: 5,
            buyFeeBps: 10,
            buyFeeFixed: '1.00',
            sellFeeBps: 10,
            sellFeeFixed: '1.00',
            networkFee: '0.50',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(result.status).toBe('SUCCESS');
        expect(parseFloat(result.adjustedBuyPrice)).toBeGreaterThan(0.00001234);
        expect(parseFloat(result.adjustedSellPrice)).toBeLessThan(0.00001290);
        expect(parseFloat(result.buyNotional)).toBeGreaterThan(0);
        expect(parseFloat(result.estimatedNetPnL)).toBeGreaterThan(0);
    });

    // SCENARIO 4: High-precision adjusted buy and sell prices
    test('Scenario 4: High-precision adjusted prices do not suffer premature rounding to 4 decimals', () => {
        // Buy price 0.1200 with 10 bps slippage -> exact 0.12012 (5 decimals)
        // Sell price 0.1300 with 10 bps slippage -> exact 0.12987 (5 decimals)
        const result = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '1',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buySlippageBps: 10,
            sellSlippageBps: 10,
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(result.adjustedBuyPrice).toBe('0.12012');
        expect(result.adjustedSellPrice).toBe('0.12987');
        expect(result.adjustedBuyPrice).not.toBe('0.1201'); // Not truncated
        expect(result.adjustedSellPrice).not.toBe('0.1299'); // Not truncated
    });

    // SCENARIO 5: Fractional quantities where permitted
    test('Scenario 5: Fractional quantities preserve exact precision', () => {
        const result = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '123.4567890', // Exact fractional XLM
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buySlippageBps: 0,
            sellSlippageBps: 0,
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.quantity).toBe('123.4567890');
        expect(result.buyNotional).toBe('14.81481468');
        expect(result.display.buyNotional).toBe('14.81');
    });

    // SCENARIO 6: Positive and negative half-up rounding boundaries
    test('Scenario 6: Positive and negative half-up rounding boundaries conform to commercial policy', () => {
        expect(decimalRound('10.0050', 2)).toBe('10.01');
        expect(decimalRound('10.0049', 2)).toBe('10.00');
        expect(decimalRound('-10.0050', 2)).toBe('-10.01');
        expect(decimalRound('-10.0049', 2)).toBe('-10.00');

        // Exact half-cent boundaries on net P&L
        expect(decimalRound('91.3050', 2)).toBe('91.31');
        expect(decimalRound('91.3049', 2)).toBe('91.30');
        expect(decimalRound('-91.3050', 2)).toBe('-91.31');
        expect(decimalRound('-91.3049', 2)).toBe('-91.30');
    });

    // SCENARIO 7: ROI calculation precision
    test('Scenario 7: ROI division retains high precision before final percentage rounding', () => {
        const input = {
            quantity: '10000',
            asset: 'XLM',
            quoteCurrency: 'USD',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buySlippageBps: 10,
            sellSlippageBps: 10,
            buyFeeBps: 20,
            sellFeeBps: 20,
            buyFeeFixed: '0.50',
            sellFeeFixed: '0.50',
            networkFee: '0.20',
            transferFee: '0.00',
            settlementFee: '0.00'
        };

        const result = calculateArbitragePnl(input);
        // 91.3002 / 1204.3024 = 0.075811689... -> 7.581169%
        expect(result.rawRoiPercent).toBe('7.581169%');
        expect(result.estimatedRoiPercent).toBe('7.58%');
    });

    // SCENARIO 8: Monetary input supplied as unsafe JavaScript Number
    test('Scenario 8: Monetary inputs supplied as unsafe JavaScript Numbers (> MAX_SAFE_INTEGER) are rejected', () => {
        const unsafeNum = Number.MAX_SAFE_INTEGER + 100; // Unsafe JS float
        const result = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: unsafeNum,
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(result.status).toBe('INVALID_NUMERIC_VALUE');
        expect(result.error).toMatch(/MAX_SAFE_INTEGER/i);
    });

    // SCENARIO 9: Large monetary inputs supplied as decimal strings
    test('Scenario 9: Large monetary inputs supplied as decimal strings compute without precision loss', () => {
        // String representation beyond MAX_SAFE_INTEGER
        const safeStringHuge = '10000000000000000'; // 10^16 (exceeds 9e15 MAX_SAFE_INTEGER)
        const result = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: safeStringHuge,
            buyPrice: '0.1200',
            sellPrice: '0.1250',
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.buyNotional).toBe('1200000000000000.00');
        expect(result.sellNotional).toBe('1250000000000000.00');
        expect(result.estimatedNetPnL).toBe('50000000000000.0000');
        expect(result.display.estimatedNetPnL).toBe('50000000000000.00');
    });

    // SCENARIO 10: Sell slippage at and above 10,000 bps
    test('Scenario 10: Sell slippage at and above 10,000 bps is strictly rejected', () => {
        const atTenThousand = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '1000',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            sellSlippageBps: 10000, // 100% slippage
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });
        expect(atTenThousand.status).toBe('INVALID_SLIPPAGE_BPS');
        expect(atTenThousand.error).toMatch(/cannot equal or exceed 10,000 basis points/i);

        const aboveTenThousand = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '1000',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            sellSlippageBps: 12500, // 125% slippage
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });
        expect(aboveTenThousand.status).toBe('INVALID_SLIPPAGE_BPS');
    });

    // SCENARIO 11: Currency non-comparability returning NOT_COMPARABLE
    test('Scenario 11: Non-comparable rail currencies return NOT_COMPARABLE and null savings', () => {
        // Domestic INR batch vs Digital rail USD (currencies differ)
        const report = getArbitrageReport('10000.00', 'INR');

        expect(report.comparison_status).toBe('NOT_COMPARABLE');
        expect(report.potential_savings).toBeNull();
        expect(report.recommendation).toBe('NOT_COMPARABLE');
        expect(report.intelligence_note).toMatch(/NOT_COMPARABLE/);
        expect(report.intelligence_note).toMatch(/explicit FX conversion/i);
    });

    // SCENARIO 12: Explicit fee assumptions and provenance
    test('Scenario 12: Baseline fee registry explicitly categorizes entries as SIMULATED_ASSUMPTION', () => {
        expect(FEE_REGISTRY.STANDARD_FIAT_USD.category).toBe('SIMULATED_ASSUMPTION');
        expect(FEE_REGISTRY.STANDARD_FIAT_USD.isSimulatedAssumption).toBe(true);
        expect(FEE_REGISTRY.STANDARD_FIAT_USD.disclaimer).toMatch(/Illustrative scenario assumption/i);

        expect(FEE_REGISTRY.STANDARD_FIAT_INR.category).toBe('SIMULATED_ASSUMPTION');
        expect(FEE_REGISTRY.STANDARD_FIAT_INR.isSimulatedAssumption).toBe(true);

        expect(FEE_REGISTRY.DIGITAL_RAIL_SIMULATED.category).toBe('SIMULATED_ASSUMPTION');
        expect(FEE_REGISTRY.DIGITAL_RAIL_SIMULATED.isSimulatedAssumption).toBe(true);
    });
});

describe('Project Fusion — R2C.2: Precision Boundary and Input Contract Verification', () => {
    // 1. High-precision buy price with slippage
    test('Task 5.1: High-precision buy price with slippage retains exact dynamic precision', () => {
        const res = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '100000000',
            buyPrice: '0.00001234',
            sellPrice: '0.00001300',
            buySlippageBps: 10,
            sellSlippageBps: 0,
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.status).toBe('SUCCESS');
        // buyPrice * (1 + 10 / 10000) = 0.00001234 * 1.0010 = 0.00001235234
        expect(res.adjustedBuyPrice).toBe('0.00001235234');
        // buyNotional = 100000000 * 0.00001235234 = 1235.234
        expect(res.buyNotional).toBe('1235.234');
        expect(res.display.buyNotional).toBe('1235.23');
    });

    // 2. High-precision sell price with slippage
    test('Task 5.2: High-precision sell price with slippage retains exact dynamic precision', () => {
        const res = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '100000000',
            buyPrice: '0.00001200',
            sellPrice: '0.00001234',
            buySlippageBps: 0,
            sellSlippageBps: 10,
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.status).toBe('SUCCESS');
        // sellPrice * (1 - 10 / 10000) = 0.00001234 * 0.9990 = 0.00001232766
        expect(res.adjustedSellPrice).toBe('0.00001232766');
        // sellNotional = 100000000 * 0.00001232766 = 1232.766
        expect(res.sellNotional).toBe('1232.766');
        expect(res.display.sellNotional).toBe('1232.77');
    });

    // 3. Micro-price combined with very large quantity
    test('Task 5.3: Micro-price combined with very large quantity calculates without underflow or overflow', () => {
        const res = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '100000000000', // 100 billion units
            buyPrice: '0.00000001',
            sellPrice: '0.00000002',
            buySlippageBps: 0,
            sellSlippageBps: 0,
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.status).toBe('SUCCESS');
        expect(res.buyNotional).toBe('1000.00');
        expect(res.sellNotional).toBe('2000.00');
        expect(res.estimatedNetPnL).toBe('1000.0000');
        expect(res.display.estimatedNetPnL).toBe('1000.00');
        expect(res.estimatedRoiPercent).toBe('100.00%');
    });

    // 4. Monetary input supplied as a safe JavaScript Number is rejected
    test('Task 5.4: Monetary input supplied as a safe JavaScript Number is rejected with INVALID_INPUT_TYPE', () => {
        const res = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: 10000, // Safe JS number, must be rejected
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buySlippageBps: 10,
            sellSlippageBps: 10,
            buyFeeBps: 20,
            sellFeeBps: 20,
            buyFeeFixed: '0.50',
            sellFeeFixed: '0.50',
            networkFee: '0.20',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.status).toBe('INVALID_INPUT_TYPE');
        expect(res.error).toMatch(/must be provided as a decimal string/i);
        expect(res.error).toMatch(/IEEE 754/i);
    });

    // 5. Monetary input supplied as a high-precision decimal string is accepted
    test('Task 5.5: Monetary input supplied as high-precision decimal string (up to 18 decimals) is accepted', () => {
        const res = calculateArbitragePnl({
            asset: 'ETH',
            quoteCurrency: 'USD',
            quantity: '1.000000000000000000', // 18 decimals
            buyPrice: '2500.123456789012345678', // 18 decimals
            sellPrice: '2600.000000000000000000',
            buySlippageBps: 0,
            sellSlippageBps: 0,
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.status).toBe('SUCCESS');
        expect(res.buyPrice).toBe('2500.123456789012345678');
        expect(res.buyNotional).toBe('2500.123456789012345678');
        expect(res.display.buyNotional).toBe('2500.12');
    });

    // 6. Excessively long decimal input is rejected with EXCESSIVE_PRECISION
    test('Task 5.6: Excessively long decimal input (>18 decimals or >50 characters) is rejected with EXCESSIVE_PRECISION', () => {
        // Exceeds 18 decimal places (19 decimals)
        const excessiveDecimals = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '1000',
            buyPrice: '0.1234567890123456789', // 19 decimals
            sellPrice: '0.1300',
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(excessiveDecimals.status).toBe('EXCESSIVE_PRECISION');
        expect(excessiveDecimals.error).toMatch(/exceeds maximum supported precision of 18 decimal places/i);

        // Exceeds 50 characters length
        const longString = '1000000000000000000000000000000000000000000000000000'; // 52 chars
        const excessiveLength = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: longString,
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(excessiveLength.status).toBe('EXCESSIVE_PRECISION');
        expect(excessiveLength.error).toMatch(/exceeds maximum allowed input length of 50 characters/i);
    });

    // 7. Exact notional and fee calculations after dynamic precision adjustment
    test('Task 5.7: Exact notional, fee, and net P&L calculations after dynamic intermediate precision', () => {
        const res = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '100000000',
            buyPrice: '0.00001234',
            sellPrice: '0.00001500',
            buySlippageBps: 10,
            sellSlippageBps: 10,
            buyFeeBps: 20, // 0.20%
            buyFeeFixed: '0.50',
            sellFeeBps: 20, // 0.20%
            sellFeeFixed: '0.50',
            networkFee: '0.20',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.status).toBe('SUCCESS');
        expect(res.adjustedBuyPrice).toBe('0.00001235234');
        expect(res.adjustedSellPrice).toBe('0.000014985');
        expect(res.buyNotional).toBe('1235.234');
        expect(res.sellNotional).toBe('1498.50');
        // buy pct fee = 1235.234 * 0.0020 = 2.470468 -> trimmed to 2.470468
        expect(res.fees.buyPercentageFee).toBe('2.470468');
        expect(res.fees.totalBuyFee).toBe('2.970468');
        // sell pct fee = 1498.50 * 0.0020 = 2.997 -> min scale 4 is 2.9970
        expect(res.fees.sellPercentageFee).toBe('2.9970');
        expect(res.fees.totalSellFee).toBe('3.4970');
        // total costs = 2.970468 + 3.497 + 0.20 = 6.667468
        expect(res.totalEstimatedCosts).toBe('6.667468');
        expect(res.display.totalEstimatedCosts).toBe('6.67');
        // net sale proceeds = 1498.50 - 3.4970 = 1495.003 -> min scale 4 is 1495.0030
        expect(res.netSaleProceeds).toBe('1495.0030');
        // acquisition cost = 1235.234 + 2.970468 + 0.20 = 1238.404468
        expect(res.totalAcquisitionCost).toBe('1238.404468');
        expect(res.display.totalAcquisitionCost).toBe('1238.40');
        // net P&L = 1495.003 - 1238.404468 = 256.598532
        expect(res.estimatedNetPnL).toBe('256.598532');
        expect(res.display.estimatedNetPnL).toBe('256.60');
    });

    // 8. Basis point parameters support both numbers and strings
    test('Task 5.8: Basis-point parameters accept valid integers and integer strings', () => {
        const resNumeric = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '1000',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buySlippageBps: 10,
            sellSlippageBps: 15,
            buyFeeBps: 20,
            sellFeeBps: 25,
            buyFeeFixed: '0.50',
            sellFeeFixed: '0.50',
            networkFee: '0.10',
            transferFee: '0.00',
            settlementFee: '0.00'
        });
        expect(resNumeric.status).toBe('SUCCESS');

        const resString = calculateArbitragePnl({
            asset: 'XLM',
            quoteCurrency: 'USD',
            quantity: '1000',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buySlippageBps: '10',
            sellSlippageBps: '15',
            buyFeeBps: '20',
            sellFeeBps: '25',
            buyFeeFixed: '0.50',
            sellFeeFixed: '0.50',
            networkFee: '0.10',
            transferFee: '0.00',
            settlementFee: '0.00'
        });
        expect(resString.status).toBe('SUCCESS');
        expect(resNumeric.estimatedNetPnL).toBe(resString.estimatedNetPnL);
    });
});

describe('Project Fusion — R2C.1 & R2C.2: HTTP Router Endpoints', () => {
    test('POST /treasury/arbitrage/calculate returns 200 with exact Scenario 1 reconciliation', async () => {
        const res = await invokeRouterHandler('/treasury/arbitrage/calculate', 'POST', {
            quantity: '10000',
            asset: 'XLM',
            quoteCurrency: 'USD',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buySlippageBps: 10,
            sellSlippageBps: 10,
            buyFeeBps: 20,
            sellFeeBps: 20,
            buyFeeFixed: '0.50',
            sellFeeFixed: '0.50',
            networkFee: '0.20',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('SUCCESS');
        expect(res.body.estimatedNetPnL).toBe('91.3002');
        expect(res.body.display.estimatedNetPnL).toBe('91.30');
        expect(res.body.estimatedRoiPercent).toBe('7.58%');
    });

    test('POST /treasury/arbitrage/calculate returns 400 for sell slippage >= 10,000 bps', async () => {
        const res = await invokeRouterHandler('/treasury/arbitrage/calculate', 'POST', {
            quantity: '1000',
            asset: 'XLM',
            quoteCurrency: 'USD',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            sellSlippageBps: 10000,
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('INVALID_SLIPPAGE_BPS');
    });

    // RESTORED HTTP ROUTER TEST 1: Missing required fees
    test('POST /treasury/arbitrage/calculate returns 400 when required fees are omitted', async () => {
        const res = await invokeRouterHandler('/treasury/arbitrage/calculate', 'POST', {
            quantity: '1000',
            asset: 'XLM',
            quoteCurrency: 'USD',
            buyPrice: '0.1200',
            sellPrice: '0.1300'
            // required fees omitted
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('INCOMPLETE_DATA');
    });

    // RESTORED HTTP ROUTER TEST 2: Incompatible currency
    test('POST /treasury/arbitrage/calculate returns 400 when currencies mismatch', async () => {
        const res = await invokeRouterHandler('/treasury/arbitrage/calculate', 'POST', {
            quantity: '1000',
            asset: 'XLM',
            quoteCurrency: 'USD',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            feeCurrency: 'EUR',
            buyFeeBps: 20,
            sellFeeBps: 20,
            buyFeeFixed: '0.50',
            sellFeeFixed: '0.50',
            networkFee: '0.20',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('INCOMPATIBLE_CURRENCY');
    });

    // RESTORED HTTP ROUTER TEST 3: Simulation defaults
    test('GET /treasury/arbitrage/simulation-defaults returns 200 and explicit defaults', async () => {
        const res = await invokeRouterHandler('/treasury/arbitrage/simulation-defaults', 'GET', null, { currency: 'USD' });

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('SUCCESS');
        expect(res.body.defaults).toBeDefined();
        expect(res.body.defaults.quoteCurrency).toBe('USD');
    });

    // RESTORED HTTP ROUTER TEST 4: Comparative report without hardcoded 2.9%
    test('POST /treasury/arbitrage/report returns comparative simulation without hardcoded 2.9%', async () => {
        const res = await invokeRouterHandler('/treasury/arbitrage/report', 'POST', {
            amount: '10000.00',
            currency: 'USD'
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.comparison_status).toBe('COMPARABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/2\.9%/);
    });

    // R2C.2 NEW ROUTER TEST: Rejection of Number-typed monetary inputs via HTTP
    test('POST /treasury/arbitrage/calculate returns 400 with INVALID_INPUT_TYPE for Number-typed inputs', async () => {
        const res = await invokeRouterHandler('/treasury/arbitrage/calculate', 'POST', {
            quantity: 1000, // Number instead of string
            asset: 'XLM',
            quoteCurrency: 'USD',
            buyPrice: '0.1200',
            sellPrice: '0.1300',
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('INVALID_INPUT_TYPE');
    });

    // R2C.2 NEW ROUTER TEST: Rejection of excessive precision via HTTP
    test('POST /treasury/arbitrage/calculate returns 400 with EXCESSIVE_PRECISION for >18 decimal places', async () => {
        const res = await invokeRouterHandler('/treasury/arbitrage/calculate', 'POST', {
            quantity: '1000',
            asset: 'XLM',
            quoteCurrency: 'USD',
            buyPrice: '0.1234567890123456789', // 19 decimals
            sellPrice: '0.1300',
            buyFeeBps: 0,
            buyFeeFixed: '0.00',
            sellFeeBps: 0,
            sellFeeFixed: '0.00',
            networkFee: '0.00',
            transferFee: '0.00',
            settlementFee: '0.00'
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.status).toBe('EXCESSIVE_PRECISION');
    });
});
