import {createClient} from 'redis';
import * as crypto from "node:crypto";

export async function storeCredentials(
    credentials: any,
    usernameUrlKey: string,
    password: string
) {
    const redis = createClient({url: import.meta.env.REDIS_URL});
    await redis.connect();

    if (!credentials.refreshToken) throw new Error('refreshToken is required');

    // Derive hash and Redis key
    const id = crypto.createHash("sha256").update(usernameUrlKey).digest("hex");
    const key = `bakalari:${id}`;

    const exists = await redis.exists(key);

    // Derive AES key from password + salt (id)
    const aesKeyBuffer = crypto.scryptSync(password, id, 32); // 256-bit key
    const aesKeyHex = aesKeyBuffer.toString('hex'); // return as hex string

    if (exists) {
        await redis.quit();
        return {id, alreadyCreated: true, aesKey: aesKeyHex};
    }

    try {
        // --- encrypt credentials ---
        const iv = crypto.randomBytes(12); // AES-GCM 96-bit IV
        const cipher = crypto.createCipheriv('aes-256-gcm', aesKeyBuffer, iv);

        const encrypted = Buffer.concat([
            cipher.update(JSON.stringify(credentials), 'utf8'),
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();

        // calculate expiration to be 31st july (if it is after 31st july, then 31st july next year)
        const now = new Date();
        const currentYear = now.getFullYear();
        const expirationDate = new Date(now > new Date(currentYear, 6, 31) ? currentYear + 1 : currentYear, 6, 31);
        const EX = Math.floor((expirationDate.getTime() - now.getTime()) / 1000);

        // Store iv + authTag + ciphertext in Redis as base64
        const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');
        await redis.set(key, payload, {
            EX
        });
    } finally {
        await redis.quit();
    }

    return {id, alreadyCreated: false, aesKey: aesKeyHex};
}


export async function deleteCredentials(hash: string) {
    const redis = createClient({url: import.meta.env.REDIS_URL});
    await redis.connect();

    if (!await redis.exists(hash)) {
        await redis.quit();
        return false;
    }

    try {
        const key = `bakalari:${hash}`;
        await redis.del(key);
    } finally {
        await redis.quit();
    }
    return true;
}

export async function getCredentials(hash: string, aesKey: string) {
    const redis = createClient({
        url: import.meta.env.REDIS_URL,
    });
    await redis.connect();

    try {
        // Fetch the encrypted payload
        const payloadB64 = await redis.get(`bakalari:${hash}`);
        if (!payloadB64) throw new Error('Credentials not found');

        const data = Buffer.from(payloadB64, 'base64');

        // Extract IV, authTag, and ciphertext
        const iv = data.subarray(0, 12);       // 96-bit IV
        const authTag = data.subarray(12, 28); // 16-byte tag
        const encrypted = data.subarray(28);

        const keyBuffer = Buffer.from(aesKey, 'hex'); // or 'base64', depending on how you store it

        // Decrypt using provided AES key
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

        // Parse JSON and return credentials
        return JSON.parse(decrypted);
    } finally {
        await redis.quit();
    }
}

export async function updateCredentials(credentials: any, hash: string, aesKey: string) {
    const redis = createClient({url: import.meta.env.REDIS_URL});
    await redis.connect();

    try {
        const key = `bakalari:${hash}`;
        const exists = await redis.exists(key);
        if (!exists) throw new Error('Redis key does not exist or expired');

        // Convert AES key to Buffer
        const keyBuffer = Buffer.from(aesKey, 'hex'); // or 'base64'

        // Encrypt credentials
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();

        const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');

        // calculate expiration to be 31st july (if it is after 31st july, then 31st july next year)
        const now = new Date();
        const currentYear = now.getFullYear();
        const expirationDate = new Date(now > new Date(currentYear, 6, 31) ? currentYear + 1 : currentYear, 6, 31);
        const EX = Math.floor((expirationDate.getTime() - now.getTime()) / 1000);

        // Store updated encrypted credentials
        await redis.set(key, payload, {EX});
    } finally {
        await redis.quit();
    }
}