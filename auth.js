/**
 * PROTOTYPE AUTHENTICATION MODULE
 * 
 * This module implements API-Key authentication for rapid iteration.
 * 
 * PROTOTYPE ONLY: In production, this would be replaced by:
 * - mTLS (Mutual TLS) for server-to-server calls
 * - OAuth2 + PKCE for user-facing web/mobile flows
 * - Hardware Security Module (HSM) signing for critical operations
 */

const authenticateClient = (req, res, next) => {
    // PROTOTYPE ONLY: API-Key from environment
    const clientKey = req.headers['x-api-key'];
    const expectedKey = process.env.API_SECRET_KEY;
    
    if (!clientKey || clientKey !== expectedKey) {
        return res.status(401).json({ 
            error: "Unauthorized", 
            detail: "Invalid or missing API credentials (PROTOTYPE AUTH)" 
        });
    }
    
    // In production, would also verify:
    // - Client certificate (mTLS)
    // - OAuth2 bearer token scope
    // - Rate-limit quotas
    req.authenticatedClient = { type: 'API_KEY', timestamp: new Date() };
    next();
};

module.exports = { authenticateClient };
