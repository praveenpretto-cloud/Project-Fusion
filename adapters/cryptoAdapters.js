// DIGITAL ASSET CUSTODIAN ADAPTER

const Stellar = require('@stellar/stellar-sdk');

// Configuration for Stellar Testnet
const server = new Stellar.Horizon.Server('https://horizon-testnet.stellar.org');
const NET_PASSPHRASE = 'Test SDF Network ; September 2015'; // Explicit Testnet

async function executeCryptoTransfer(instruction) {
    const { amount, sender, recipient } = instruction;

    const logger = require('../logger');
    logger.info(`[STELLAR] Executing: ${amount} XLM from ${sender} to ${recipient}`);

    try {
        // 1. Get Secure Public Keys from Vault (Keys remain isolated)
        const { getStellarPublicKey, signStellarTransaction } = require('../vaultProvider');

        const sourcePublicKey = await getStellarPublicKey(sender);
        const destinationPublicKey = await getStellarPublicKey(recipient);

        const isRedacted = process.env.PII_REDACTION !== 'false';

        logger.info(
            `[STELLAR] Source: ${isRedacted ? sourcePublicKey.substring(0, 4) + '...' + sourcePublicKey.substring(52) : sourcePublicKey}`
        );
        logger.info(
            `[STELLAR] Dest:   ${isRedacted ? destinationPublicKey.substring(0, 4) + '...' + destinationPublicKey.substring(52) : destinationPublicKey}`
        );

        // 2. Ensure Source Account Exists (Fund via Friendbot if Demo)
        try {
            await server.loadAccount(sourcePublicKey);
        } catch {
            logger.info('[STELLAR] Source not found. Funding via Friendbot...');
            await fetch(`https://friendbot.stellar.org?addr=${sourcePublicKey}`);
            logger.info('[STELLAR] Waiting for ledger (8s)...');
            await new Promise((r) => setTimeout(r, 8000));
        }

        // 3. Load Source Account for Sequence Number
        const sourceAccount = await server.loadAccount(sourcePublicKey);

        // 4. Check if Destination Exists
        let destExists = true;
        try {
            await server.loadAccount(destinationPublicKey);
        } catch {
            destExists = false;
        }

        // 5. Build Operation (Create or Pay)
        const op = destExists
            ? Stellar.Operation.payment({
                  destination: destinationPublicKey,
                  asset: Stellar.Asset.native(),
                  amount: amount.toString(),
              })
            : Stellar.Operation.createAccount({
                  destination: destinationPublicKey,
                  startingBalance: amount.toString(),
              });

        // 6. Build Transaction (Using secure source public key)
        const transaction = new Stellar.TransactionBuilder(sourceAccount, {
            fee: Stellar.BASE_FEE,
            networkPassphrase: NET_PASSPHRASE,
        })
            .addOperation(op)
            .setTimeout(60)
            .build();

        // 7. Sign via HSM Vault (Key remains isolated)
        await signStellarTransaction(sender, transaction, NET_PASSPHRASE);

        // 8. Submit to Network
        logger.info('[STELLAR] Submitting to Horizon Testnet...');
        const result = await server.submitTransaction(transaction);
        logger.info(`[STELLAR] SUCCESS! Hash: ${result.hash}`);

        return {
            adapter_type: 'CRYPTO_CUSTODIAN',
            status: 'SUCCESS',
            intent_id: result.hash,
            blockchain_hash: result.hash,
            ledger: result.ledger,
            explorer_url: `https://stellar.expert/explorer/testnet/tx/${result.hash}`,
            timestamp: new Date().toISOString(),
        };
    } catch (err) {
        let stellarError = err.message;
        if (err.response && err.response.data && err.response.data.extras) {
            stellarError = `Stellar ${err.response.data.title}: ${JSON.stringify(err.response.data.extras.result_codes)}`;
        }
        logger.error(`[STELLAR ERROR] ${stellarError}`);
        return {
            status: 'FAILED',
            error: stellarError,
            timestamp: new Date().toISOString(),
        };
    }
}

async function queryStatus(intentId) {
    if (!intentId) return 'UNKNOWN';
    const logger = require('../logger');
    try {
        logger.info(`[STELLAR] Querying Horizon for transaction status: ${intentId}`);
        // We can actually check the Stellar network
        await server.loadTransaction(intentId);
        return 'succeeded';
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return 'pending';
        }
        return 'UNKNOWN';
    }
}

module.exports = { executeCryptoTransfer, queryStatus };
