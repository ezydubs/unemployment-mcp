import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";

/**
 * The payment-card PIN scheme from cards/controllers/set-pin and resources/utils/encryption: an ANSI format-0 PIN
 * block, AES-256-CBC-encrypted with a fresh key that is itself wrapped with MSD's RSA public key (OAEP, SHA-1).
 */
export function ansiPinBlock(pin: string, pan: string): string {
  const pinBlock = `0${pin.length}${pin}`.padEnd(16, "F");
  const panBlock = `0000${pan.substring(pan.length - 13, pan.length - 1)}`;
  return (BigInt(`0x${pinBlock}`) ^ BigInt(`0x${panBlock}`)).toString(16).toUpperCase().padStart(16, "0");
}

/** The SPA cuts the PEM the same way: substring(26, length-24) = the base64 between the BEGIN and END lines. */
export function importRsaPublicKey(pem: string): KeyObject {
  const b64 = pem.substring(26, pem.length - 24).trim();
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

export function encryptPinBlock(block: string, publicKey: KeyObject): { pinBlock: string; iv: string; key: string } {
  const aesKey = randomBytes(32);
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", aesKey, iv);
  const encrypted = Buffer.concat([c.update(block, "utf8"), c.final()]);
  const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, aesKey);
  return { pinBlock: encrypted.toString("base64"), iv: iv.toString("base64"), key: wrapped.toString("base64") };
}
