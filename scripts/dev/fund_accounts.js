const axios = require('axios');
const { getStellarPublicKey } = require('../../vaultProvider');

async function main() {
    try {
        const hq = await getStellarPublicKey('Corporate_HQ');
        const alice = await getStellarPublicKey('Alice_Retail');

        console.log('HQ Address:', hq);
        console.log('Alice Address:', alice);

        const addresses = [hq, alice];
        for (const addr of addresses) {
            console.log(`Funding account: ${addr}`);
            try {
                const response = await axios.get(`https://friendbot.stellar.org/?addr=${addr}`);
                console.log(`Success: ${response.status}`);
            } catch (err) {
                console.error(
                    `Funding failed or account already exists for ${addr}: ${err.message}`
                );
            }
        }
    } catch (err) {
        console.error('Error in funding script:', err);
    }
}

main();
