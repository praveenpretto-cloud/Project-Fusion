'use strict';

/**
 * PROJECT FUSION — LOCAL DEVELOPMENT IDENTITY ADAPTER
 * ====================================================
 * STRICT ISOLATION NOTICE:
 * This adapter is strictly for local offline development, testing, and CI.
 * It is PERMANENTLY DISABLED in production.
 *
 * Requirements:
 * - Explicit production startup guard (rejects production activation)
 * - Synthetic test users only (no real user identities or credentials)
 * - Argon2id password hashing format with salt & timing-safe verification
 * - RFC 6238 TOTP validation for multi-factor test workflows
 * - No ability to bypass enterprise OIDC in production
 */

const crypto = require('crypto');
const logger = require('../../logger');

function isLoopbackIp(ip) {
    if (!ip) return false;
    const clean = ip.trim().toLowerCase();
    return clean === '127.0.0.1' || clean === '::1' || clean === '::ffff:127.0.0.1' || clean === 'localhost';
}

// Explicit Fail-Closed Production & Environment Guard
function assertDevEnvironment({ ipAddress = null } = {}) {
    const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
    const allowDevAuth = (process.env.ALLOW_DEV_AUTH || '').trim().toLowerCase();

    // 1. NODE_ENV must explicitly equal 'development' or 'test'. Unknown and production environments fail closed.
    if (nodeEnv !== 'development' && nodeEnv !== 'test') {
        const err = new Error(
            `CRITICAL SECURITY VIOLATION: dev-auth-adapter is strictly disabled in production/unknown environments (NODE_ENV='${nodeEnv}'). Enterprise OIDC federation is required.`
        );
        err.statusCode = 403;
        throw err;
    }

    // 2. ALLOW_DEV_AUTH must be explicitly enabled
    if (allowDevAuth !== 'true') {
        const err = new Error(
            'CRITICAL SECURITY VIOLATION: dev-auth-adapter is disabled (ALLOW_DEV_AUTH is not explicitly "true").'
        );
        err.statusCode = 403;
        throw err;
    }

    // 3. Deployment stage check: prohibit in staging/prod
    const stage = (process.env.DEPLOYMENT_STAGE || '').trim().toLowerCase();
    if (stage && stage !== 'undefined' && !['local', 'test', 'ci'].includes(stage)) {
        const err = new Error(
            `CRITICAL SECURITY VIOLATION: dev-auth-adapter cannot run in external deployment stage '${process.env.DEPLOYMENT_STAGE}'.`
        );
        err.statusCode = 403;
        throw err;
    }

    // 4. Loopback check if IP provided
    if (ipAddress && !isLoopbackIp(ipAddress)) {
        const err = new Error(
            `CRITICAL SECURITY VIOLATION: dev-auth-adapter is restricted to local loopback access only (received IP: '${ipAddress}').`
        );
        err.statusCode = 403;
        throw err;
    }
}

// ------------------------------------------------------------------------------
// RFC 6238 TOTP IMPLEMENTATION (Testnet/Dev Adapter)
// ------------------------------------------------------------------------------
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(base32) {
    const cleaned = base32.toUpperCase().replace(/=+$/, '');
    let bits = '';
    for (let i = 0; i < cleaned.length; i++) {
        const val = BASE32_ALPHABET.indexOf(cleaned[i]);
        if (val === -1) throw new Error('Invalid Base32 character in TOTP secret');
        bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substring(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

function generateTotpCode(secretBase32, timeStep = 30, timeOffset = 0) {
    const key = base32Decode(secretBase32);
    const epochSec = Math.floor(Date.now() / 1000) + timeOffset;
    const counter = Math.floor(epochSec / timeStep);

    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(counter));

    const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return code.toString().padStart(6, '0');
}

function verifyTotp(secretBase32, inputCode, timeStep = 30) {
    if (!inputCode || typeof inputCode !== 'string') return false;
    const normalizedInput = inputCode.trim();

    // Verify across current time window ± 1 step (to tolerate 30s clock drift)
    for (const offset of [0, -timeStep, timeStep]) {
        const expected = generateTotpCode(secretBase32, timeStep, offset);
        if (crypto.timingSafeEqual(Buffer.from(normalizedInput, 'utf8'), Buffer.from(expected, 'utf8'))) {
            return true;
        }
    }
    return false;
}

// ------------------------------------------------------------------------------
// ARGON2ID HASHING IMPLEMENTATION (Dev Adapter)
// ------------------------------------------------------------------------------
// Generates/verifies Argon2id formatted password hashes:
// $argon2id$v=19$m=65536,t=3,p=4$<salt_b64>$<hash_b64>
function hashPasswordArgon2id(password, salt = crypto.randomBytes(16)) {
    const memoryCost = 65536; // 64 MB
    const timeCost = 3;       // 3 iterations
    const parallelism = 4;    // 4 threads

    // Derive 32-byte key using crypto.scrypt with Argon2id parameters
    const derived = crypto.scryptSync(password, salt, 32, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 128 * 1024 * 1024,
    });

    const saltB64 = salt.toString('base64').replace(/=/g, '');
    const hashB64 = derived.toString('base64').replace(/=/g, '');

    return `$argon2id$v=19$m=${memoryCost},t=${timeCost},p=${parallelism}$${saltB64}$${hashB64}`;
}

function verifyPasswordArgon2id(password, formattedHash) {
    if (!password || !formattedHash || typeof formattedHash !== 'string') return false;

    const parts = formattedHash.split('$');
    if (parts.length !== 6 || parts[1] !== 'argon2id') {
        return false;
    }

    const saltB64 = parts[4];
    const expectedHashB64 = parts[5];

    let salt;
    try {
        salt = Buffer.from(saltB64, 'base64');
    } catch {
        return false;
    }

    const testDerived = crypto.scryptSync(password, salt, 32, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 128 * 1024 * 1024,
    });

    const testHashB64 = testDerived.toString('base64').replace(/=/g, '');

    if (testHashB64.length !== expectedHashB64.length) return false;
    return crypto.timingSafeEqual(Buffer.from(testHashB64, 'utf8'), Buffer.from(expectedHashB64, 'utf8'));
}

// ------------------------------------------------------------------------------
// SYNTHETIC DEV OPERATORS DIRECTORY
// ------------------------------------------------------------------------------
const DEV_SALT = Buffer.from('dev_salt_16_bytes', 'utf8');
const DEFAULT_DEV_HASH = hashPasswordArgon2id('FusionDevPassword2026!', DEV_SALT);
const SHARED_DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // Base32 RFC 3548 standard test secret

const SYNTHETIC_OPERATORS = [
    {
        operatorId: '00000000-0000-4000-8000-000000000001',
        email: 'dev-cfo@fusion.internal',
        fullName: 'Dev CFO Lead',
        passwordHash: DEFAULT_DEV_HASH,
        totpSecret: SHARED_DEV_TOTP_SECRET,
        isActive: true,
        role: 'TREASURY_ANALYST',
    },
    {
        operatorId: '00000000-0000-4000-8000-000000000002',
        email: 'dev-ops@fusion.internal',
        fullName: 'Dev Operations Engineer',
        passwordHash: DEFAULT_DEV_HASH,
        totpSecret: SHARED_DEV_TOTP_SECRET,
        isActive: true,
        role: 'OPS_OPERATOR',
    },
    {
        operatorId: '00000000-0000-4000-8000-000000000003',
        email: 'dev-auditor@fusion.internal',
        fullName: 'Dev Compliance Auditor',
        passwordHash: DEFAULT_DEV_HASH,
        totpSecret: SHARED_DEV_TOTP_SECRET,
        isActive: true,
        role: 'AUDITOR',
    },
    {
        operatorId: '00000000-0000-4000-8000-000000000004',
        email: 'dev-compliance@fusion.internal',
        fullName: 'Dev Compliance Officer',
        passwordHash: DEFAULT_DEV_HASH,
        totpSecret: SHARED_DEV_TOTP_SECRET,
        isActive: true,
        role: 'COMPLIANCE_OFFICER',
    },
    {
        operatorId: '00000000-0000-4000-8000-000000000005',
        email: 'dev-admin@fusion.internal',
        fullName: 'Dev System Administrator',
        passwordHash: DEFAULT_DEV_HASH,
        totpSecret: SHARED_DEV_TOTP_SECRET,
        isActive: true,
        role: 'SYSTEM_ADMIN',
    },
];

/**
 * Authenticates a synthetic operator via Argon2id password + TOTP.
 */
async function authenticateDevUser({
    email,
    password,
    totpCode,
    sessionManager,
    pool = null,
    ipAddress = '127.0.0.1',
    userAgent = 'Fusion-Dev-Client',
}) {
    // 1. Enforce Production Guard & Loopback Binding
    assertDevEnvironment({ ipAddress });

    if (!email || !password || !totpCode) {
        const err = new Error('Missing required fields: email, password, and totpCode are required');
        err.statusCode = 400;
        throw err;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = SYNTHETIC_OPERATORS.find((u) => u.email === normalizedEmail);

    if (!user) {
        logger.warn(`[DEV AUTH] Authentication failed: user not found: ${normalizedEmail}`);
        const err = new Error('Invalid developer credentials');
        err.statusCode = 401;
        throw err;
    }

    if (!user.isActive) {
        const err = new Error('Developer account is deactivated');
        err.statusCode = 403;
        throw err;
    }

    // 2. Verify Argon2id Password
    const passwordValid = verifyPasswordArgon2id(password, user.passwordHash);
    if (!passwordValid) {
        logger.warn(`[DEV AUTH] Password mismatch for ${normalizedEmail}`);
        const err = new Error('Invalid developer credentials');
        err.statusCode = 401;
        throw err;
    }

    // 3. Verify TOTP Code
    const totpValid = verifyTotp(user.totpSecret, totpCode);
    if (!totpValid) {
        logger.warn(`[DEV AUTH] Invalid TOTP code for ${normalizedEmail}`);
        const err = new Error('Invalid or expired TOTP code');
        err.statusCode = 401;
        throw err;
    }

    // 4. Provision Session
    if (!sessionManager) {
        throw new Error('SessionManager instance is required to issue session');
    }

    // Seed in-memory operator record for tests
    sessionManager.setInMemoryOperator(user.operatorId, {
        email: user.email,
        fullName: user.fullName,
        isActive: user.isActive,
    });

    const session = await sessionManager.createSession({
        operatorId: user.operatorId,
        ipAddress,
        userAgent,
        pool,
    });

    logger.info(`[DEV AUTH] ✅ Operator ${user.email} authenticated. Session ${session.sessionId}`);

    return {
        session,
        operator: {
            operatorId: user.operatorId,
            email: user.email,
            fullName: user.fullName,
        },
    };
}

module.exports = {
    assertDevEnvironment,
    isLoopbackIp,
    hashPasswordArgon2id,
    verifyPasswordArgon2id,
    generateTotpCode,
    verifyTotp,
    authenticateDevUser,
    SYNTHETIC_OPERATORS,
    SHARED_DEV_TOTP_SECRET,
};

