
/**
 * Guardian Sanctions Screening Service
 * Checks if a recipient is on the high-risk sanctions list.
 * 
 * @param {Object} pool - The shared Postgres connection pool
 * @param {string} recipientId - The entity or address to screen
 */
async function checkSanctions(pool, recipientId) {
    if (!recipientId) return { blocked: false };
    
    try {
        // Use the shared pool to prevent connection exhaustion
        const res = await pool.query(
            'SELECT entity_name, reason, risk_level FROM sanctions_list WHERE address_or_id = $1',
            [recipientId]
        );
        
        if (res.rows.length > 0) {
            return {
                blocked: true,
                entity: res.rows[0].entity_name,
                reason: res.rows[0].reason,
                risk_level: res.rows[0].risk_level
            };
        }
        
        return { blocked: false };
    } catch (err) {
        console.error('[GUARDIAN ERROR]', err.message);
        return { blocked: false }; 
    }
}

module.exports = { checkSanctions };
