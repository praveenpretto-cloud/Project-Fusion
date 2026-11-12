'use strict';

const logger = require('../../logger');

/**
 * Evaluates whether an outbound instruction breaches the daily velocity limit.
 * If it does, the required approvals are bumped to 2.
 *
 * @param {object} pool - Postgres Pool
 * @param {string} businessId - The business ID
 * @param {number} newInstructionAmount - The amount of the new instruction
 * @returns {Promise<{ requiresTwoCheckers: boolean, limit: number, currentVelocity: number }>}
 */
async function evaluateVelocity(pool, businessId, newInstructionAmount) {
    try {
        // 1. Fetch the business's daily limit
        const limitRes = await pool.query(
            `SELECT daily_velocity_limit FROM businesses WHERE business_id = $1`,
            [businessId]
        );

        const limit = limitRes.rows.length
            ? Number(limitRes.rows[0].daily_velocity_limit)
            : 5000000;

        // 2. Calculate the current daily velocity (sum of all APPROVED/SETTLED today)
        // We look at instructions created today
        const velocityRes = await pool.query(
            `SELECT SUM(amount) as total_outflow 
             FROM instructions 
             WHERE sender = $1 
               AND state IN ('APPROVED', 'SETTLED', 'PENDING_EXECUTION')
               AND created_at >= CURRENT_DATE`,
            [businessId]
        );

        const currentVelocity = Number(velocityRes.rows[0].total_outflow || 0);

        // 3. Evaluate breach
        const totalWithNew = currentVelocity + Number(newInstructionAmount);
        const requiresTwoCheckers = totalWithNew > limit;

        if (requiresTwoCheckers) {
            logger.warn(
                `[VELOCITY] Business ${businessId} breached daily limit (${totalWithNew} > ${limit}). Requiring 2 checkers.`
            );
        }

        return {
            requiresTwoCheckers,
            limit,
            currentVelocity,
        };
    } catch (err) {
        logger.error(`[VELOCITY] Error evaluating velocity for ${businessId}: ${err.message}`);
        throw err;
    }
}

module.exports = { evaluateVelocity };
