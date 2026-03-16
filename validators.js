/**
 * INPUT VALIDATION SCHEMAS (Institutional Grade)
 *
 * Uses Joi for request validation before processing.
 * Prevents garbage data from entering the system.
 */

const Joi = require('joi');
const { CURRENCIES, LIMITS } = require('./constants');

const instructionInitiateSchema = Joi.object({
    amount: Joi.number()
        .positive()
        .max(LIMITS.MAX_TRANSACTION_AMOUNT)
        .min(LIMITS.MIN_TRANSACTION_AMOUNT)
        .precision(LIMITS.MAX_DECIMAL_PLACES)
        .strict()
        .required()
        .messages({
            'number.positive': 'Amount must be positive',
            'number.max': `Amount cannot exceed ${LIMITS.MAX_TRANSACTION_AMOUNT}`,
            'number.min': `Amount must be at least ${LIMITS.MIN_TRANSACTION_AMOUNT}`,
            'number.precision': 'Amount can have at most 2 decimal places',
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
    instructionId: Joi.string().uuid().required(),
    adapter: Joi.string()
        .valid(
            'ADAPTER_PAYNOW',
            'ADAPTER_STRIPE', // ✅ Added
            'ADAPTER_RAZORPAY', // ✅ Added
            'ADAPTER_CRYPTO_CUSTODIAN'
        )
        .required(),
});

module.exports = {
    instructionInitiateSchema,
    instructionIdSchema,
    adapterExecuteSchema,
};
