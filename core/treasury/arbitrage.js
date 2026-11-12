'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * TREASURY ARBITRAGE & SIMULATION ENGINE (RELIABILITY R2C.1)
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * Provides deterministic financial calculations for cross-rail treasury
 * analysis, fee comparison, and multi-venue price simulation.
 * 
 * GOVERNANCE & SAFETY BOUNDARIES:
 * - All calculations are strictly deterministic fixed-point decimal arithmetic.
 * - Zero IEEE 754 floating-point operations in financial calculation paths.
 * - Strictly analytical and simulation-only: NO live trading, NO order execution,
 *   NO private-key actions, and NO financial mutation.
 * - Every simulation output carries explicit data provenance ('SYNTHETIC_SIMULATION')
 *   and mandatory non-executable disclaimers.
 * - Disclosed fee rates are explicitly categorized as SIMULATED_ASSUMPTION.
 * - Non-comparable currencies return comparison_status: 'NOT_COMPARABLE' and
 *   potential_savings: null rather than inventing 0.00 savings.
 */

const {
    getAssetScale,
    toCanonicalDecimal,
    parseDecimalParts,
    decimalAdd,
    decimalSubtract,
    decimalMultiply,
    decimalDivide,
    decimalRound,
    trimTrailingZeros,
    decimalCompare
} = require('../orchestrator/financialDecimal');

const DISCLAIMER_TEXT = 'SIMULATED — NOT AN EXECUTABLE QUOTE. Actual execution outcomes can differ due to liquidity, market movements, fees, and slippage.';
const DATA_PROVENANCE = 'SYNTHETIC_SIMULATION';

// Staged Precision Policy:
// - Intermediate price calculations retain at least 8 decimal places or max(8, inputPriceScale + 4).
// - Intermediate notionals, fees, and P&L retain at least 8 decimal places until final display rounding.
// - Quotients for ROI division retain at least 8 decimal places before percentage conversion.
const INTERMEDIATE_PRICE_SCALE = 8;
const INTERMEDIATE_CALC_SCALE = 8;

// Resource & Security Limits
const MAX_INPUT_LENGTH = 50;
const MAX_INPUT_DECIMALS = 18;

/**
 * Institutional baseline fee registry for comparative simulation.
 * All percentage fees are denominated in basis points (1 bps = 0.01% = 0.0001).
 * All fixed fees are denominated in the stated rail currency.
 * 
 * GOVERNANCE: All registry entries are explicitly marked as SIMULATED_ASSUMPTION
 * to distinguish illustrative scenario baselines from verified provider contracts.
 */
const FEE_REGISTRY = {
    STANDARD_FIAT_USD: {
        railName: 'Standard Fiat Gateway (USD)',
        bps: 200, // 2.0%
        fixed: '0.30',
        currency: 'USD',
        category: 'SIMULATED_ASSUMPTION',
        isSimulatedAssumption: true,
        disclaimer: 'Illustrative scenario assumption for portfolio demonstration; not verified universal provider pricing.'
    },
    STANDARD_FIAT_INR: {
        railName: 'Standard Domestic Payout (INR)',
        bps: 150, // 1.5%
        fixed: '5.00',
        currency: 'INR',
        category: 'SIMULATED_ASSUMPTION',
        isSimulatedAssumption: true,
        disclaimer: 'Illustrative scenario assumption for portfolio demonstration; not verified universal provider pricing.'
    },
    DIGITAL_RAIL_SIMULATED: {
        railName: 'Digital Settlement Rail (Simulated)',
        bps: 25, // 0.25%
        fixed: '0.10',
        currency: 'USD',
        category: 'SIMULATED_ASSUMPTION',
        isSimulatedAssumption: true,
        disclaimer: 'Synthetic simulation benchmark rail; not an executable market quote or verified settlement fee schedule.'
    }
};

/**
 * Validates and extracts required arbitrage input parameters.
 * Rejects missing data, non-numeric values, negative prices/fees, unsafe numbers,
 * currency mismatches, and out-of-range slippage.
 * 
 * @param {Object} params
 * @returns {{ valid: boolean, error?: string, status?: string, data?: Object }}
 */
function validateArbitrageInput(params) {
    if (!params || typeof params !== 'object') {
        return {
            valid: false,
            status: 'INCOMPLETE_DATA',
            error: 'Input parameters object is required.'
        };
    }

    const { asset, quoteCurrency } = params;
    if (!asset || typeof asset !== 'string' || !asset.trim()) {
        return {
            valid: false,
            status: 'INCOMPLETE_DATA',
            error: 'Asset symbol is required (e.g. XLM, USDC, BTC).'
        };
    }
    if (!quoteCurrency || typeof quoteCurrency !== 'string' || !quoteCurrency.trim()) {
        return {
            valid: false,
            status: 'INCOMPLETE_DATA',
            error: 'Quote currency is required (e.g. USD, INR, EUR).'
        };
    }

    const cleanAsset = asset.trim().toUpperCase();
    const cleanQuote = quoteCurrency.trim().toUpperCase();

    // Helper to validate strictly typed monetary decimal strings
    function validateMonetaryField(val, fieldName) {
        if (val === undefined || val === null || val === '') {
            return {
                valid: false,
                status: 'INCOMPLETE_DATA',
                error: `${fieldName} is required.`
            };
        }

        if (typeof val === 'number') {
            if (!Number.isFinite(val) || val > Number.MAX_SAFE_INTEGER || val < Number.MIN_SAFE_INTEGER) {
                return {
                    valid: false,
                    status: 'INVALID_NUMERIC_VALUE',
                    error: `${fieldName} exceeds JavaScript MAX_SAFE_INTEGER. Pass large financial values as decimal strings to prevent silent precision loss.`
                };
            }
            return {
                valid: false,
                status: 'INVALID_INPUT_TYPE',
                error: `Field '${fieldName}' must be provided as a decimal string. JavaScript Numbers are rejected to prevent IEEE 754 precision loss.`
            };
        }

        if (typeof val !== 'string') {
            return {
                valid: false,
                status: 'INVALID_INPUT_TYPE',
                error: `Field '${fieldName}' must be provided as a decimal string.`
            };
        }

        const trimmed = val.trim();
        if (!trimmed) {
            return {
                valid: false,
                status: 'INCOMPLETE_DATA',
                error: `${fieldName} cannot be empty.`
            };
        }

        if (trimmed.length > MAX_INPUT_LENGTH) {
            return {
                valid: false,
                status: 'EXCESSIVE_PRECISION',
                error: `Field '${fieldName}' exceeds maximum allowed input length of ${MAX_INPUT_LENGTH} characters.`
            };
        }

        let p;
        try {
            p = parseDecimalParts(trimmed);
        } catch {
            return {
                valid: false,
                status: 'INVALID_NUMERIC_VALUE',
                error: `Invalid numeric value for '${fieldName}': '${trimmed}'`
            };
        }

        if (p.scale > MAX_INPUT_DECIMALS) {
            return {
                valid: false,
                status: 'EXCESSIVE_PRECISION',
                error: `Field '${fieldName}' exceeds maximum supported precision of ${MAX_INPUT_DECIMALS} decimal places.`
            };
        }

        return { valid: true, parsed: p, str: trimmed };
    }

    // Helper to validate basis-point parameters (integer numbers or integer strings)
    function validateBpsField(val, fieldName, required = true) {
        if (val === undefined || val === null || val === '') {
            if (required) {
                return {
                    valid: false,
                    status: 'INCOMPLETE_DATA',
                    error: `Missing required fee parameter: '${fieldName}'. All fee fields must be explicitly supplied (use 0 for fee-free operations).`
                };
            }
            return { valid: true, num: 0, str: '0' };
        }

        if (typeof val === 'number') {
            if (!Number.isFinite(val) || !Number.isInteger(val)) {
                return {
                    valid: false,
                    status: 'INVALID_NUMERIC_VALUE',
                    error: `Field '${fieldName}' must be an integer.`
                };
            }
            if (val < 0) {
                return {
                    valid: false,
                    status: 'INVALID_NUMERIC_VALUE',
                    error: `${fieldName} cannot be negative.`
                };
            }
            if (val > Number.MAX_SAFE_INTEGER) {
                return {
                    valid: false,
                    status: 'INVALID_NUMERIC_VALUE',
                    error: `${fieldName} exceeds JavaScript MAX_SAFE_INTEGER.`
                };
            }
            return { valid: true, num: val, str: String(val) };
        }

        if (typeof val === 'string') {
            const trimmed = val.trim();
            if (!/^\d+$/.test(trimmed)) {
                return {
                    valid: false,
                    status: 'INVALID_NUMERIC_VALUE',
                    error: `Field '${fieldName}' must be a non-negative integer.`
                };
            }
            if (trimmed.length > MAX_INPUT_LENGTH) {
                return {
                    valid: false,
                    status: 'EXCESSIVE_PRECISION',
                    error: `Field '${fieldName}' exceeds maximum allowed input length.`
                };
            }
            try {
                const bigVal = BigInt(trimmed);
                if (bigVal > BigInt(Number.MAX_SAFE_INTEGER)) {
                    return {
                        valid: false,
                        status: 'INVALID_NUMERIC_VALUE',
                        error: `${fieldName} exceeds JavaScript MAX_SAFE_INTEGER.`
                    };
                }
            } catch {
                return {
                    valid: false,
                    status: 'INVALID_NUMERIC_VALUE',
                    error: `Invalid numeric value for ${fieldName}: '${trimmed}'`
                };
            }
            return { valid: true, num: Number(trimmed), str: trimmed };
        }

        return {
            valid: false,
            status: 'INVALID_INPUT_TYPE',
            error: `Field '${fieldName}' must be an integer or integer string.`
        };
    }

    // 1. Quantity validation (strictly decimal string)
    const qtyCheck = validateMonetaryField(params.quantity, 'Quantity');
    if (!qtyCheck.valid) {
        return qtyCheck;
    }
    if (qtyCheck.parsed.isNegative || qtyCheck.parsed.rawBigInt === 0n) {
        return {
            valid: false,
            status: 'INVALID_QUANTITY',
            error: 'Quantity must be a positive finite number greater than zero.'
        };
    }

    // 2. Buy and sell price validation (strictly decimal strings)
    const buyCheck = validateMonetaryField(params.buyPrice, 'Buy price');
    if (!buyCheck.valid) {
        return buyCheck;
    }
    if (buyCheck.parsed.isNegative || buyCheck.parsed.rawBigInt === 0n) {
        return {
            valid: false,
            status: 'INVALID_NUMERIC_VALUE',
            error: 'Buy price must be a positive finite number greater than zero.'
        };
    }

    const sellCheck = validateMonetaryField(params.sellPrice, 'Sell price');
    if (!sellCheck.valid) {
        return sellCheck;
    }
    if (sellCheck.parsed.isNegative || sellCheck.parsed.rawBigInt === 0n) {
        return {
            valid: false,
            status: 'INVALID_NUMERIC_VALUE',
            error: 'Sell price must be a positive finite number greater than zero.'
        };
    }

    // 3. Slippage validation (bps)
    const buySlipCheck = validateBpsField(params.buySlippageBps, 'buySlippageBps', false);
    if (!buySlipCheck.valid) return buySlipCheck;

    const sellSlipCheck = validateBpsField(params.sellSlippageBps, 'sellSlippageBps', false);
    if (!sellSlipCheck.valid) return sellSlipCheck;

    // Specific Governance Gate: Sell slippage must never produce a non-positive adjusted selling price
    if (sellSlipCheck.num >= 10000) {
        return {
            valid: false,
            status: 'INVALID_SLIPPAGE_BPS',
            error: `Sell slippage (${sellSlipCheck.num} bps) cannot equal or exceed 10,000 basis points (100%), as this produces a non-positive adjusted sell price.`
        };
    }

    // 4. Fee parameter verification
    const fees = (params.fees && typeof params.fees === 'object' && !Array.isArray(params.fees)) ? params.fees : params;

    // Currency verification across fee definitions
    const topFeeCurrency = fees.currency || fees.feeCurrency || params.feeCurrency;
    if (topFeeCurrency && topFeeCurrency.trim().toUpperCase() !== cleanQuote) {
        return {
            valid: false,
            status: 'INCOMPATIBLE_CURRENCY',
            error: `Fee currency '${topFeeCurrency}' does not match quote currency '${cleanQuote}'. Incompatible currencies cannot be combined.`
        };
    }

    // Percentage fee bps
    const buyFeeBpsCheck = validateBpsField(fees.buyFeeBps, 'buyFeeBps', true);
    if (!buyFeeBpsCheck.valid) return buyFeeBpsCheck;

    const sellFeeBpsCheck = validateBpsField(fees.sellFeeBps, 'sellFeeBps', true);
    if (!sellFeeBpsCheck.valid) return sellFeeBpsCheck;

    // Fixed monetary fee fields (strictly decimal strings)
    const fixedFeeFields = [
        'buyFeeFixed',
        'sellFeeFixed',
        'networkFee',
        'transferFee',
        'settlementFee'
    ];

    const parsedFees = {
        buyFeeBps: buyFeeBpsCheck.str,
        sellFeeBps: sellFeeBpsCheck.str
    };

    for (const field of fixedFeeFields) {
        let rawVal = fees[field];
        if (typeof rawVal === 'object' && rawVal !== null && !Array.isArray(rawVal)) {
            if (rawVal.currency && rawVal.currency.trim().toUpperCase() !== cleanQuote) {
                return {
                    valid: false,
                    status: 'INCOMPATIBLE_CURRENCY',
                    error: `Fee currency '${rawVal.currency}' for '${field}' does not match quote currency '${cleanQuote}'.`
                };
            }
            rawVal = rawVal.amount;
        }

        if (rawVal === undefined || rawVal === null || rawVal === '') {
            return {
                valid: false,
                status: 'INCOMPLETE_DATA',
                error: `Missing required fee parameter: '${field}'. All fee fields must be explicitly supplied (use 0 for fee-free operations).`
            };
        }

        const feeCheck = validateMonetaryField(rawVal, field);
        if (!feeCheck.valid) return feeCheck;

        if (feeCheck.parsed.isNegative) {
            return {
                valid: false,
                status: 'INVALID_NUMERIC_VALUE',
                error: `Fee parameter '${field}' cannot be negative.`
            };
        }

        parsedFees[field] = feeCheck.str;
    }

    return {
        valid: true,
        data: {
            asset: cleanAsset,
            quoteCurrency: cleanQuote,
            quantity: qtyCheck.str,
            buyPrice: buyCheck.str,
            sellPrice: sellCheck.str,
            buySlippageBps: buySlipCheck.str,
            sellSlippageBps: sellSlipCheck.str,
            fees: parsedFees
        }
    };
}

/**
 * Calculates deterministic arbitrage P&L and ROI from explicit inputs.
 * Strictly adheres to the canonical 8-step calculation specification:
 * 
 * 1. Adjusted buy price = buy price * (1 + buy slippage bps / 10,000)
 * 2. Adjusted sell price = sell price * (1 - sell slippage bps / 10,000)
 * 3. Buy notional = quantity * adjusted buy price
 * 4. Sell notional = quantity * adjusted sell price
 * 5. Total acquisition cost = buy notional + buy fees + applicable transfer/network/settlement costs
 * 6. Net sale proceeds = sell notional - sell fees
 * 7. Estimated net P&L = net sale proceeds - total acquisition cost
 * 8. Estimated ROI = (estimated net P&L / total acquisition cost) * 100
 * 
 * NUMERICAL INTEGRITY POLICY (R2C.1):
 * - Adjusted prices retain exact fractional precision (no premature rounding to 4 decimals).
 * - Notional, fee, and net P&L intermediate calculations retain 8 decimal places.
 * - Final display amounts are rounded half-up according to quote-currency scale.
 * 
 * @param {Object} params
 * @returns {Object} Deterministic simulation report or error status
 */
function calculateArbitragePnl(params) {
    const validation = validateArbitrageInput(params);
    if (!validation.valid) {
        return {
            status: validation.status,
            error: validation.error,
            isSimulated: true,
            isExecutable: false,
            disclaimer: DISCLAIMER_TEXT,
            dataProvenance: DATA_PROVENANCE
        };
    }

    const {
        asset,
        quoteCurrency,
        quantity,
        buyPrice,
        sellPrice,
        buySlippageBps,
        sellSlippageBps,
        fees
    } = validation.data;

    const quoteScale = getAssetScale(quoteCurrency);
    const assetScale = getAssetScale(asset);

    // Resolve price scale: preserves full input scale for high-precision micro-prices (e.g. 0.00001234)
    const pBuy = parseDecimalParts(buyPrice);
    const pSell = parseDecimalParts(sellPrice);
    const pQty = parseDecimalParts(quantity);
    const inputPriceScale = Math.max(quoteScale, 4, pBuy.scale, pSell.scale);
    const intermediatePriceScale = Math.max(INTERMEDIATE_PRICE_SCALE, inputPriceScale + 4);
    const intermediateCalcScale = Math.max(INTERMEDIATE_CALC_SCALE, intermediatePriceScale);

    // 1. Adjusted buy price = buy price * (1 + buy slippage bps / 10,000)
    // Retain full intermediate precision (up to intermediatePriceScale decimal places)
    const buySlippageFraction = decimalDivide(buySlippageBps, '10000', intermediatePriceScale);
    const buyMultiplier = decimalAdd('1', buySlippageFraction, intermediatePriceScale);
    const adjustedBuyPriceFull = decimalMultiply(buyPrice, buyMultiplier, intermediatePriceScale);
    const adjustedBuyPrice = trimTrailingZeros(adjustedBuyPriceFull, Math.min(inputPriceScale, 4));

    // 2. Adjusted sell price = sell price * (1 - sell slippage bps / 10,000)
    const sellSlippageFraction = decimalDivide(sellSlippageBps, '10000', intermediatePriceScale);
    const sellMultiplier = decimalSubtract('1', sellSlippageFraction, intermediatePriceScale);
    const adjustedSellPriceFull = decimalMultiply(sellPrice, sellMultiplier, intermediatePriceScale);
    const adjustedSellPrice = trimTrailingZeros(adjustedSellPriceFull, Math.min(inputPriceScale, 4));

    // 3. Buy notional = quantity * adjusted buy price
    // Intermediate notional retains dynamic intermediate precision (at least 8 decimal places)
    const buyNotionalFull = decimalMultiply(quantity, adjustedBuyPriceFull, intermediateCalcScale);
    const buyNotional = trimTrailingZeros(buyNotionalFull, quoteScale);

    // 4. Sell notional = quantity * adjusted sell price
    const sellNotionalFull = decimalMultiply(quantity, adjustedSellPriceFull, intermediateCalcScale);
    const sellNotional = trimTrailingZeros(sellNotionalFull, quoteScale);

    // Gross price spread (before slippage and fees)
    const grossPriceSpreadFull = decimalSubtract(sellPrice, buyPrice, inputPriceScale);
    const grossPriceSpread = trimTrailingZeros(grossPriceSpreadFull, Math.min(inputPriceScale, 4));
    const grossSpreadNotionalFull = decimalMultiply(quantity, grossPriceSpreadFull, intermediateCalcScale);
    const grossSpreadNotional = trimTrailingZeros(grossSpreadNotionalFull, quoteScale);

    // Fees calculation:
    // buy fees = (buy notional * buyFeeBps / 10,000) + buyFeeFixed
    const buyFeePctDec = decimalDivide(fees.buyFeeBps, '10000', intermediateCalcScale);
    const buyPctFeeFull = decimalMultiply(buyNotionalFull, buyFeePctDec, intermediateCalcScale);
    const buyPercentageFee = trimTrailingZeros(buyPctFeeFull, 4);
    const buyTotalFeeFull = decimalAdd(buyPctFeeFull, fees.buyFeeFixed, intermediateCalcScale);
    const totalBuyFee = trimTrailingZeros(buyTotalFeeFull, 4);

    // sell fees = (sell notional * sellFeeBps / 10,000) + sellFeeFixed
    const sellFeePctDec = decimalDivide(fees.sellFeeBps, '10000', intermediateCalcScale);
    const sellPctFeeFull = decimalMultiply(sellNotionalFull, sellFeePctDec, intermediateCalcScale);
    const sellPercentageFee = trimTrailingZeros(sellPctFeeFull, 4);
    const totalSellFeeFull = decimalAdd(sellPctFeeFull, fees.sellFeeFixed, intermediateCalcScale);
    const totalSellFee = trimTrailingZeros(totalSellFeeFull, 4);

    // Operational fees: transfer/network/settlement
    const opFeesPart1 = decimalAdd(fees.networkFee, fees.transferFee, intermediateCalcScale);
    const totalOperationalFeesFull = decimalAdd(opFeesPart1, fees.settlementFee, intermediateCalcScale);
    const totalOperationalFees = trimTrailingZeros(totalOperationalFeesFull, quoteScale);

    // Total estimated costs (counted exactly once across all fee categories)
    const totalEstimatedCostsFull = decimalAdd(
        decimalAdd(buyTotalFeeFull, totalSellFeeFull, intermediateCalcScale),
        totalOperationalFeesFull,
        intermediateCalcScale
    );
    const totalEstimatedCosts = trimTrailingZeros(totalEstimatedCostsFull, 4);

    // 5. Total acquisition cost = buy notional + buy fees + applicable transfer/network/settlement costs
    const totalAcquisitionCostFull = decimalAdd(
        decimalAdd(buyNotionalFull, buyTotalFeeFull, intermediateCalcScale),
        totalOperationalFeesFull,
        intermediateCalcScale
    );
    const totalAcquisitionCost = trimTrailingZeros(totalAcquisitionCostFull, 4);

    // 6. Net sale proceeds = sell notional - sell fees
    const netSaleProceedsFull = decimalSubtract(sellNotionalFull, totalSellFeeFull, intermediateCalcScale);
    const netSaleProceeds = trimTrailingZeros(netSaleProceedsFull, 4);

    // 7. Estimated net P&L = net sale proceeds - total acquisition cost
    const estimatedNetPnLFull = decimalSubtract(netSaleProceedsFull, totalAcquisitionCostFull, intermediateCalcScale);
    const estimatedNetPnL = trimTrailingZeros(estimatedNetPnLFull, 4);

    // 8. Estimated ROI = (estimated net P&L / total acquisition cost) * 100
    let rawRoiPercent = '0.00%';
    let estimatedRoiPercent = '0.00%';
    if (decimalCompare(totalAcquisitionCostFull, '0', intermediateCalcScale) > 0) {
        const roiQuotient = decimalDivide(estimatedNetPnLFull, totalAcquisitionCostFull, intermediateCalcScale);
        rawRoiPercent = decimalMultiply(roiQuotient, '100', 6) + '%';
        estimatedRoiPercent = decimalMultiply(roiQuotient, '100', 2) + '%';
    }

    const isProfitable = decimalCompare(estimatedNetPnLFull, '0', intermediateCalcScale) > 0;

    const grossTotalOutlaysFull = decimalAdd(buyNotionalFull, totalEstimatedCostsFull, intermediateCalcScale);
    const grossTotalOutlays = trimTrailingZeros(grossTotalOutlaysFull, 4);

    // Display rounded amounts according to quote currency scale (standard institutional cents)
    const display = {
        buyNotional: decimalRound(buyNotionalFull, quoteScale),
        sellNotional: decimalRound(sellNotionalFull, quoteScale),
        grossProceeds: decimalRound(sellNotionalFull, quoteScale),
        grossSpreadNotional: decimalRound(grossSpreadNotionalFull, quoteScale),
        totalEstimatedCosts: decimalRound(totalEstimatedCostsFull, quoteScale),
        totalAcquisitionCost: decimalRound(totalAcquisitionCostFull, quoteScale),
        grossTotalOutlays: decimalRound(grossTotalOutlaysFull, quoteScale),
        netSaleProceeds: decimalRound(netSaleProceedsFull, quoteScale),
        netProceeds: decimalRound(netSaleProceedsFull, quoteScale),
        estimatedNetPnL: decimalRound(estimatedNetPnLFull, quoteScale),
        netProfit: decimalRound(estimatedNetPnLFull, quoteScale),
        estimatedRoiPercent
    };

    return {
        status: 'SUCCESS',
        isSimulated: true,
        isExecutable: false,
        disclaimer: DISCLAIMER_TEXT,
        dataProvenance: DATA_PROVENANCE,
        asset,
        quoteCurrency,
        quantity: trimTrailingZeros(toCanonicalDecimal(quantity, Math.max(assetScale, pQty.scale)), assetScale),
        buyPrice: trimTrailingZeros(toCanonicalDecimal(buyPrice, inputPriceScale), 4),
        sellPrice: trimTrailingZeros(toCanonicalDecimal(sellPrice, inputPriceScale), 4),
        adjustedBuyPrice,
        adjustedSellPrice,
        buyNotional,
        sellNotional,
        grossProceeds: sellNotional,
        grossPriceSpread,
        grossSpreadNotional,
        fees: {
            buyFeeBps: Number(fees.buyFeeBps),
            buyFeeFixed: trimTrailingZeros(fees.buyFeeFixed, quoteScale),
            buyPercentageFee,
            totalBuyFee,
            sellFeeBps: Number(fees.sellFeeBps),
            sellFeeFixed: trimTrailingZeros(fees.sellFeeFixed, quoteScale),
            sellPercentageFee,
            totalSellFee,
            networkFee: trimTrailingZeros(fees.networkFee, quoteScale),
            transferFee: trimTrailingZeros(fees.transferFee, quoteScale),
            settlementFee: trimTrailingZeros(fees.settlementFee, quoteScale),
            totalOperationalFees,
            totalEstimatedCosts
        },
        totalEstimatedCosts,
        totalAcquisitionCost,
        grossTotalOutlays,
        netSaleProceeds,
        netProceeds: netSaleProceeds,
        estimatedNetPnL,
        netProfit: estimatedNetPnL,
        rawRoiPercent,
        estimatedRoiPercent,
        isProfitable,
        display
    };
}

/**
 * Calculates estimated fee for a registered rail.
 * Replaces hardcoded values with deterministic scale-aware calculation.
 * 
 * @param {number|string} amount
 * @param {string} rail
 * @returns {string} Fee canonical string
 */
function calculateEstimatedFee(amount, rail) {
    const config = FEE_REGISTRY[rail];
    if (!config) return '0.00';

    try {
        const amtStr = String(amount);
        const bpsDec = decimalDivide(config.bps, '10000', 6);
        const pctFee = decimalMultiply(amtStr, bpsDec, config.currency);
        return decimalAdd(pctFee, config.fixed, config.currency);
    } catch {
        return '0.00';
    }
}

/**
 * Generates transparent comparative treasury intelligence for a given batch volume.
 * Eliminates all invented performance percentages and hardcoded savings figures.
 * 
 * CURRENCY COMPARABILITY GOVERNANCE (R2C.1):
 * When rail currencies differ without an explicit FX conversion:
 * - comparison_status is explicitly 'NOT_COMPARABLE'
 * - potential_savings is explicitly null (never 0.00)
 * - recommendation is 'NOT_COMPARABLE'
 * - explains that an FX conversion and its costs are required
 * 
 * @param {number|string} amount - Total batch volume
 * @param {string} currency - Batch currency
 * @param {Object} [options] - Additional simulation overrides
 * @returns {Object} Transparent simulation summary
 */
function getArbitrageReport(amount, currency = 'USD', options = {}) {
    const cleanCurrency = String(currency || 'USD').trim().toUpperCase();
    const scale = getAssetScale(cleanCurrency);

    let amountStr;
    try {
        amountStr = toCanonicalDecimal(amount, scale);
    } catch {
        amountStr = '0.00';
    }

    const fiatRail = cleanCurrency === 'INR' ? 'STANDARD_FIAT_INR' : 'STANDARD_FIAT_USD';
    const fiatFee = calculateEstimatedFee(amountStr, fiatRail);
    const digitalFee = calculateEstimatedFee(amountStr, 'DIGITAL_RAIL_SIMULATED');

    const fiatConfig = FEE_REGISTRY[fiatRail];
    const digitalConfig = FEE_REGISTRY.DIGITAL_RAIL_SIMULATED;

    let potentialDiff = null;
    let recommendation = 'NOT_COMPARABLE';
    let comparisonStatus = 'NOT_COMPARABLE';
    let intelligenceNote = `[SIMULATION] Volume ${amountStr} ${cleanCurrency}: Rail currencies differ (${fiatConfig.currency} vs ${digitalConfig.currency}). Comparison status: NOT_COMPARABLE. Cross-currency fee comparison requires an explicit FX conversion and associated conversion costs, which are not currently modeled.`;

    if (fiatConfig.currency === digitalConfig.currency) {
        comparisonStatus = 'COMPARABLE';
        if (decimalCompare(fiatFee, digitalFee, scale) > 0) {
            potentialDiff = decimalSubtract(fiatFee, digitalFee, scale);
            recommendation = 'DIGITAL_RAIL_SIMULATED';
            intelligenceNote = `[SIMULATION] Volume ${amountStr} ${cleanCurrency}: Digital rail simulated fee is ${digitalFee} vs standard gateway ${fiatFee} (Potential simulated difference: ${potentialDiff} ${cleanCurrency}).`;
        } else {
            potentialDiff = '0.00';
            recommendation = fiatRail;
            intelligenceNote = `[SIMULATION] Volume ${amountStr} ${cleanCurrency}: Standard gateway estimated fee (${fiatFee}) is competitive with or lower than simulated digital rail (${digitalFee}).`;
        }
    }

    return {
        target_currency: cleanCurrency,
        gross_amount: amountStr,
        isSimulated: true,
        isExecutable: false,
        comparison_status: comparisonStatus,
        disclaimer: DISCLAIMER_TEXT,
        dataProvenance: DATA_PROVENANCE,
        options: {
            fiat: { rail: fiatRail, estimated_fee: fiatFee, currency: fiatConfig.currency },
            digital: { rail: 'DIGITAL_RAIL_SIMULATED', estimated_fee: digitalFee, currency: digitalConfig.currency }
        },
        potential_savings: potentialDiff,
        recommendation,
        intelligence_note: intelligenceNote
    };
}

module.exports = {
    DISCLAIMER_TEXT,
    DATA_PROVENANCE,
    INTERMEDIATE_PRICE_SCALE,
    INTERMEDIATE_CALC_SCALE,
    FEE_REGISTRY,
    validateArbitrageInput,
    calculateArbitragePnl,
    calculateEstimatedFee,
    getArbitrageReport
};
