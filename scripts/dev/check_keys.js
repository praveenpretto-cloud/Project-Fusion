const { getStellarPublicKey } = require('../../vaultProvider');

async function main() {
    const hq = await getStellarPublicKey('Corporate_HQ');
    const alice = await getStellarPublicKey('Alice_Retail');
    console.log('--- BEGIN ADDRESSES ---');
    console.log('HQ:', hq);
    console.log('Alice:', alice);
    console.log('--- END ADDRESSES ---');
    process.exit(0);
}

main();
