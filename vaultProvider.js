// VAULT PROVIDER (HSM/KMS Simulation)

const crypto = require('crypto');
const Stellar = require('@stellar/stellar-sdk');

// Internal isolated storage (Simulating HSM memory)
const SECRETS = {
    // These would be pulled from encrypted hardware or cloud KMS in production
    STRIPE_KEY: process.env.STRIPE_TEST_SECRET_KEY,
    // We deterministically derive keys from sender names for the prototype
    // but in a real system, the Vault would hold unique cold/hot seeds.
};

// SIMULATED HSM SIGNING
async function signStellarTransaction(senderName, transaction, networkPassphrase) {
    console.log(`[VAULT-HSM] Signing request received for: ${senderName}`);

    // Simulate HSM hardware latency
    await new Promise((resolve) => setTimeout(resolve, 50));

    // SECURE KEY DERIVATION (HMAC-based, not weak Buffer.write)
    // In production, this would retrieve a pre-generated seed from encrypted storage
    // For testnet, we derive deterministically but with full 32-byte entropy
    const masterSecret = process.env.VAULT_MASTER_SECRET;
    if (!masterSecret) throw new Error('VAULT_MASTER_SECRET not set');
    const derivedSeed = crypto.createHmac('sha256', masterSecret).update(senderName).digest(); // Returns full 32 bytes

    const keypair = Stellar.Keypair.fromRawEd25519Seed(derivedSeed);

    // Sign the transaction inside the "Vault"
    transaction.sign(keypair);

    console.log(`[VAULT-HSM] Transaction signed successfully. Key remained isolated.`);
    return transaction;
}

// Returns the public key for a given sender in a secure way.
async function getStellarPublicKey(senderName) {
    const masterSecret = process.env.VAULT_MASTER_SECRET;
    if (!masterSecret) throw new Error('VAULT_MASTER_SECRET not set');
    const derivedSeed = crypto.createHmac('sha256', masterSecret).update(senderName).digest();

    const keypair = Stellar.Keypair.fromRawEd25519Seed(derivedSeed);
    return keypair.publicKey();
}

// SECURE SECRET ACCESS
function getAdapterCredential(keyName) {
    if (!SECRETS[keyName]) {
        console.warn(`[VAULT] Access requested for unknown key: ${keyName}`);
        return null;
    }
    // Logic: In a real vault, we might return a short-lived token instead of the raw key
    return SECRETS[keyName];
}

module.exports = {
    signStellarTransaction,
    getStellarPublicKey,
    getAdapterCredential,
};
