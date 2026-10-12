import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
const { ansiPinBlock, importRsaPublicKey, encryptPinBlock } = await import("../dist/pin.js");

test("ANSI PIN block: XOR of the padded PIN block and the PAN block, as the SPA computes it", () => {
  const pin = "1234", pan = "1234567890123456";
  const expected = (BigInt("0x041234FFFFFFFFFF") ^ BigInt("0x0000456789012345")).toString(16).toUpperCase().padStart(16, "0");
  assert.equal(ansiPinBlock(pin, pan), expected);
  assert.equal(ansiPinBlock(pin, pan).length, 16);
});

test("encryptPinBlock: AES-256-CBC with a random IV, key wrapped with RSA-OAEP SHA-1 — round trip", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  assert.ok(pem.startsWith("-----BEGIN PUBLIC KEY-----"));
  const key = importRsaPublicKey(pem);
  const block = ansiPinBlock("9876", "1234567890123456");
  const { pinBlock, iv, key: wrapped } = encryptPinBlock(block, key);
  const aesKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(wrapped, "base64"));
  assert.equal(aesKey.length, 32);
  const d = createDecipheriv("aes-256-cbc", aesKey, Buffer.from(iv, "base64"));
  assert.equal(Buffer.concat([d.update(Buffer.from(pinBlock, "base64")), d.final()]).toString("utf8"), block);
});
