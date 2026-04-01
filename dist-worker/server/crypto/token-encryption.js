/**
 * File: server/crypto/token-encryption.ts
 * Purpose: Encrypt and decrypt long-lived Shopify offline access tokens before
 * they are persisted outside the Session table.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const ENCRYPTION_KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");
if (ENCRYPTION_KEY.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
}
export function encryptToken(plaintext) {
    const nonce = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, nonce);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted: encrypted.toString("base64"),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
    };
}
export function decryptToken(encryptedToken, nonce, tag) {
    const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, Buffer.from(nonce, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return (decipher.update(Buffer.from(encryptedToken, "base64"), undefined, "utf8") +
        decipher.final("utf8"));
}
