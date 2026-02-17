const vault = require('../vaultProvider');

async function testRotation() {
    console.log('🔐 Testing Vault Key Rotation Simulation...\n');

    // 1. Check Initial State
    const v1 = vault.getAdapterCredential('STRIPE_KEY');
    console.log(`[V1] Current Key (Partial): ${v1 ? v1.substring(0, 10) + '...' : 'NULL'}`);

    // 2. Rotate Key
    console.log('\n🔄 Triggering Rotation...');
    const newVersion = vault.rotateKey('STRIPE_KEY');

    // 3. Verify New State
    const v2 = vault.getAdapterCredential('STRIPE_KEY');
    console.log(`[V2] New Key (Partial):     ${v2 ? v2.substring(0, 10) + '...' : 'NULL'}`);

    if (v1 !== v2) {
        console.log('\n✅ SUCCESS: Key rotated successfully.');
        console.log(`   Version 1 (Archived): ${v1.substring(0, 10)}...`);
        console.log(`   Version ${newVersion} (Active):   ${v2.substring(0, 10)}...`);
    } else {
        console.error('\n❌ FAILED: Key did not change.');
        process.exit(1);
    }
}

testRotation();
