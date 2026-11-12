'use strict';

// DIGITAL ASSET CUSTODIAN ADAPTER

const Stellar = require('@stellar/stellar-sdk');
const crypto = require('crypto');

// Configuration for Stellar Testnet
const server = new Stellar.Horizon.Server('https://horizon-testnet.stellar.org');
const NET_PASSPHRASE = 'Test SDF Network ; September 2015'; // Explicit Testnet

async function executeCryptoRail(instruction) {
    const { amount, sender, recipient } = instruction;

    const logger = require('../logger');
    const instructionId = instruction.instruction_id || instruction.instructionId;
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

        // 4. Ensure Source Account Exists AND has sufficient reserve for the REQUESTED amount
        let sourceAccount;
        const requiredAmount = parseFloat(amount) + 2.0; // Amount + safe reserve
        
        try {
            sourceAccount = await server.loadAccount(sourcePublicKey);
            let balanceXLM = parseFloat(sourceAccount.balances.find(b => b.asset_type === 'native').balance);
            
            let refillCount = 0;
            while (balanceXLM < requiredAmount && refillCount < 3) { // Reduced retries for speed
                logger.info(`[STELLAR] Balance (${balanceXLM} XLM) insufficient for ${amount} XLM request. Refilling... (${refillCount+1}/3)`);
                await fetch(`https://friendbot.stellar.org?addr=${sourcePublicKey}`);
                await new Promise((r) => setTimeout(r, 4000));
                sourceAccount = await server.loadAccount(sourcePublicKey);
                balanceXLM = parseFloat(sourceAccount.balances.find(b => b.asset_type === 'native').balance);
                refillCount++;
            }
        } catch {
            logger.info('[STELLAR] Source not found. Initializing via Friendbot...');
            await fetch(`https://friendbot.stellar.org?addr=${sourcePublicKey}`);
            await new Promise((r) => setTimeout(r, 5000));
            sourceAccount = await server.loadAccount(sourcePublicKey);
        }

        // 5. Build Operation (Create or Pay)
        let destExists = true;
        try {
            await server.loadAccount(destinationPublicKey);
        } catch {
            destExists = false;
        }

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

        // 6. Build and Sign Transaction
        const transaction = new Stellar.TransactionBuilder(sourceAccount, {
            fee: Stellar.BASE_FEE,
            networkPassphrase: NET_PASSPHRASE,
        })
            .addOperation(op)
            .setTimeout(60)
            .build();

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
        // CORRECT API for Stellar SDK v13+:
        await server.transactions().transaction(intentId).call();
        return 'succeeded';
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return 'pending';
        }
        logger.error(`[STELLAR RECONCILE ERROR] ${err.message}`);
        return 'UNKNOWN';
    }
}

/**
 * Fetches real-time XLM balance for a given public key.
 * @param {string} address - Stellar public key
 * @returns {Promise<number>} - Balance in XLM
 */
async function getCryptoBalance(address) {
    const logger = require('../logger');
    try {
        let account;
        try {
            account = await server.loadAccount(address);
        } catch (err) {
            if (err.response && err.response.status === 404) {
                logger.info(`[STELLAR] Syncing NEW account: ${address}. Provisioning via Friendbot...`);
                await fetch(`https://friendbot.stellar.org?addr=${address}`);
                await new Promise((r) => setTimeout(r, 6000));
                account = await server.loadAccount(address);
            } else {
                throw err;
            }
        }
        
        const nativeBalance = account.balances.find((b) => b.asset_type === 'native');
        return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
    } catch (err) {
        logger.error(`[STELLAR BALANCE ERROR] ${err.message}`);
        throw err;
    }
}

module.exports = Object.freeze({
    executeCryptoRail,
    executeCryptoTransfer: executeCryptoRail, // Backward-compatibility alias
    queryStatus,
    getCryptoBalance,
});
