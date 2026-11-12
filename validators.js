/**
 * INPUT VALIDATION SCHEMAS (Institutional Grade)
 *
 * Uses Joi for request validation before processing.
 * Prevents garbage data from entering the system.
 */

const Joi = require('joi');
const { CURRENCIES, LIMITS, ASSET_PRECISION, ASSET_MIN_AMOUNT } = require('./constants');
const { decimalCompare } = require('./core/orchestrator/financialDecimal');

/**
 * Validates financial amounts:
 * - Rejects unsafe JavaScript Number inputs.
 * - Requires exact decimal strings.
 * - Rejects empty, non-string, negative, zero, or malformed amounts.
 * - Rejects scientific notation (e.g. 1e-5).
 * - Enforces currency-specific precision limits (XLM: 7 decimals, fiat: 2 decimals).
 * - Enforces minimum and maximum transaction bounds.
 */
const validateMonetaryAmount = (value, helpers) => {
    if (typeof value === 'number') {
        return helpers.message(
            'Unsafe JavaScript Number monetary inputs are rejected. Pass amount as a decimal string.'
        );
    }
    if (typeof value !== 'string') {
        return helpers.message('Amount must be a decimal string');
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return helpers.message('Amount cannot be empty');
    }
    if (trimmed.startsWith('-')) {
        return helpers.message('Amount must be positive');
    }
    if (/[eE]/.test(trimmed)) {
        return helpers.message(
            'Scientific notation is not permitted. Pass amount as an explicit decimal string.'
        );
    }
    const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) {
        return helpers.message('Amount must be a valid positive decimal string');
    }
    const intPart = match[1];
    const fracPart = match[2] || '';
    if (/^0+$/.test(intPart) && /^0*$/.test(fracPart)) {
        return helpers.message('Amount must be positive');
    }

    const parent = helpers.state.ancestors[0];
    const currency = parent ? parent.currency : null;
    const maxDecimals =
        currency && ASSET_PRECISION && ASSET_PRECISION[currency] !== undefined
            ? ASSET_PRECISION[currency]
            : LIMITS.MAX_DECIMAL_PLACES;

    if (fracPart.length > maxDecimals) {
        return helpers.message(
            `Amount for ${currency || 'currency'} cannot have more than ${maxDecimals} decimal places`
        );
    }

    if (decimalCompare(trimmed, LIMITS.MAX_TRANSACTION_AMOUNT, currency) > 0) {
        return helpers.message(`Amount cannot exceed ${LIMITS.MAX_TRANSACTION_AMOUNT}`);
    }

    const minAmount =
        currency && ASSET_MIN_AMOUNT && ASSET_MIN_AMOUNT[currency]
            ? ASSET_MIN_AMOUNT[currency]
            : LIMITS.MIN_TRANSACTION_AMOUNT;
    if (decimalCompare(trimmed, minAmount, currency) < 0) {
        return helpers.message(`Amount must be at least ${minAmount}`);
    }

    return trimmed;
};

const instructionInitiateSchema = Joi.object({
    amount: Joi.any().custom(validateMonetaryAmount).required().messages({
        'any.required': 'Amount is required',
    }),

    currency: Joi.string()
        .valid(...CURRENCIES.ALL)
        .required()
        .messages({
            'any.only': `Currency must be one of: ${CURRENCIES.ALL.join(', ')}`,
        }),

    sender: Joi.string()
        .min(2)
        .max(100)
        .pattern(/^[a-zA-Z0-9_@.-]+$/)
        .required()
        .messages({
            'string.pattern.base':
                'Sender ID must contain only letters, numbers, underscores, hyphens, and @/.',
        }),

    recipient: Joi.string()
        .min(2)
        .max(100)
        .pattern(/^[a-zA-Z0-9_@.-]+$/)
        .required()
        .messages({
            'string.pattern.base':
                'Recipient ID must contain only letters, numbers, underscores, hyphens, and @/.',
        }),

    purpose: Joi.string().max(50).required(),

    auth_token: Joi.string()
        .pattern(/^afat_[a-fA-F0-9-]+$/)
        .required()
        .messages({
            'string.pattern.base': 'auth_token must be a valid AFA token format',
        }),
});

const instructionIdSchema = Joi.object({
    instructionId: Joi.string().uuid().required().messages({
        'string.guid': 'Instruction ID must be a valid UUID',
    }),
});

const adapterExecuteSchema = Joi.object({
    instructionId: Joi.string().uuid().required().messages({
        'string.guid': 'Instruction ID must be a valid UUID',
    }),
    adapter: Joi.string()
        .valid(
            'ADAPTER_PAYNOW',
            'ADAPTER_STRIPE',
            'ADAPTER_RAZORPAY',
            'ADAPTER_CRYPTO_CUSTODIAN',
            'ADAPTER_MOCK_HFT'
        )
        .optional()
        .description(
            'Deprecated: Adapter routing is determined authoritatively by instruction currency and policy'
        ),
});

module.exports = {
    instructionInitiateSchema,
    instructionIdSchema,
    adapterExecuteSchema,
};
