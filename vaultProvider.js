// VAULT PROVIDER (HSM/KMS Simulation)
// SAFETY NOTE: This is a SIMULATION. It does not connect to real Hardware Security Modules.
// All keys are generated locally for testing purposes.

const crypto = require('crypto');
const Stellar = require('@stellar/stellar-sdk');

// Internal isolated storage (Simulating HSM memory)
// In a real system, this would be AWS KMS or HashiCorp Vault.
// Here, we simulate "Versions" of keys.
const KEY_STORE = {
    STRIPE_KEY: {
        latest_version: 1,
        versions: {
            1: process.env.STRIPE_TEST_SECRET_KEY || 'sk_test_mock_key_v1',
        },
    },
    RAZORPAY_KEY_ID: {
        latest_version: 1,
        versions: {
            1: process.env.RAZORPAY_KEY_ID || 'rzp_test_SRnXnFMObOaShd',
        },
    },
    RAZORPAY_KEY_SECRET: {
        latest_version: 1,
        versions: {
            1: process.env.RAZORPAY_KEY_SECRET || 'IYyLIUdxLYBcge5ZpQ0PP1jV',
        },
    },
    // We deterministically derive keys from sender names for the prototype
    // but in a real system, the Vault would hold unique cold/hot seeds.
    MASTER_SEED: {
        latest_version: 1,
        versions: {
            1: process.env.VAULT_MASTER_SECRET || 'project_fusion_master_seed_v1',
        },
    },
};

// SIMULATED HSM SIGNING
async function signStellarTransaction(senderName, transaction) {
    console.log(`[VAULT-HSM] Signing request received for: ${senderName}`);

    // Simulate HSM hardware latency
    await new Promise((resolve) => setTimeout(resolve, 50));

    // SECURE KEY DERIVATION (HMAC-based)
    // Always use the LATEST master seed version for new signatures
    const masterKeyData = KEY_STORE.MASTER_SEED;
    const masterSecret = masterKeyData.versions[masterKeyData.latest_version];

    if (!masterSecret) throw new Error('VAULT_MASTER_SECRET not set');

    const derivedSeed = crypto.createHmac('sha256', masterSecret).update(senderName).digest();

    const keypair = Stellar.Keypair.fromRawEd25519Seed(derivedSeed);

    // Sign the transaction inside the "Vault"
    transaction.sign(keypair);

    console.log(`[VAULT-HSM] Transaction signed successfully. Key remained isolated.`);
    return transaction;
}

// Returns the public key for a given sender in a secure way.
async function getStellarPublicKey(senderName) {
    const masterKeyData = KEY_STORE.MASTER_SEED;
    const masterSecret = masterKeyData.versions[masterKeyData.latest_version];

    if (!masterSecret) throw new Error('VAULT_MASTER_SECRET not set');

    const derivedSeed = crypto.createHmac('sha256', masterSecret).update(senderName).digest();

    const keypair = Stellar.Keypair.fromRawEd25519Seed(derivedSeed);
    return keypair.publicKey();
}

// SECURE SECRET ACCESS (With Rotation Support)
function getAdapterCredential(keyName, version = 'latest') {
    const keyData = KEY_STORE[keyName];
    if (!keyData) {
        console.warn(`[VAULT] Access requested for unknown key: ${keyName}`);
        return null;
    }

    if (version === 'latest') {
        return keyData.versions[keyData.latest_version];
    }

    return keyData.versions[version] || null;
}

// ADMIN: SIMULATE KEY ROTATION
// This mimics the "Rotate Key" command sent to an HSM
function rotateKey(keyName) {
    const keyData = KEY_STORE[keyName];
    if (!keyData) throw new Error(`Cannot rotate unknown key: ${keyName}`);

    const newVersion = keyData.latest_version + 1;

    console.log(`[VAULT-ADMIN] 🔄 Rotating ${keyName} to version ${newVersion}...`);

    // In a real system, we would generate a new cryptographically secure key here.
    // For the prototype simulation, we'll append the version number to a mock string
    // or use a dummy value, unless it's the Stripe key where we might just keep the old one
    // if we don't have a real second key.

    // For safety in this demo, we will just simulate the existence of a new key.
    keyData.versions[newVersion] = `${keyData.versions[1]}_rotated_v${newVersion}`;
    keyData.latest_version = newVersion;

    console.log(`[VAULT-ADMIN] ✅ Rotation Complete. Active Version: ${newVersion}`);
    return newVersion;
}

module.exports = {
    signStellarTransaction,
    getStellarPublicKey,
    getAdapterCredential,
    rotateKey,
};
