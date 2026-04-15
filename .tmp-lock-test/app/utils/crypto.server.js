import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex"); // 32 bytes
export function encryptToken(plaintext) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, KEY, nonce);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
        encrypted: encrypted.toString("base64"),
        nonce: nonce.toString("base64"),
        tag: tag.toString("base64"),
    };
}
export function decryptToken(encryptedB64, nonceB64, tagB64) {
    const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(nonceB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return (decipher.update(Buffer.from(encryptedB64, "base64"), undefined, "utf8") +
        decipher.final("utf8"));
}
