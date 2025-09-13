import { createClient } from 'redis';
import * as crypto from "node:crypto";

export async function storeCredentials(credentials: any, usernameUrlKey:string) {
    const redis = createClient({
        url: import.meta.env.REDIS_URL,
    });
    await redis.connect();

    if (!credentials.refreshToken) throw new Error('refreshToken is required');
    const id = crypto.createHash('md5').update(usernameUrlKey).digest('hex');
    const key = `bakalari:${id}`;
    const exists = await redis.exists(key);

    if (exists) {
        redis.destroy();
        return { id, alreadyCreated: true };
    }

    await redis.set(key, JSON.stringify(credentials));
    redis.destroy();
    return { id, alreadyCreated: false };
}

export async function getCredentials(hash:any) {
    const redis = createClient({
        url: import.meta.env.REDIS_URL,
    });
    await redis.connect();

    let data = await redis.get(`bakalari:${hash}`);
    redis.destroy();
    return data;
}

export async function updateCredentials(credentials:any, hash:any) {
    const redis = createClient({
        url: import.meta.env.REDIS_URL,
    });
    await redis.connect();
    const key = `bakalari:${hash}`;
    if (!await redis.exists(key)) {
        throw new Error('redis expired');
    }
    await redis.set(key, JSON.stringify(credentials));
    redis.destroy();
}