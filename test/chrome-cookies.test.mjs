import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const { readChromeCookies, deriveKey, decryptValue, chromeTimeToEpoch } = await import("../dist/chrome-cookies.js");

const PASSWORD = "test-safe-storage-password";
const key = deriveKey(PASSWORD);
const encrypt = (plain) => {
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), c.update(plain), c.final()]);
};
const chromeTime = (epochSeconds) => (epochSeconds + 11_644_473_600) * 1_000_000;

function makeDb(version, rows) {
  const dir = mkdtempSync(join(tmpdir(), "mymsd-chrome-test-"));
  const path = join(dir, "Cookies");
  const db = new DatabaseSync(path);
  db.exec(`create table meta (key text, value text);
    create table cookies (host_key text, name text, path text, value text, encrypted_value blob, expires_utc integer, is_secure integer, is_httponly integer);`);
  db.prepare("insert into meta values ('version', ?)").run(String(version));
  const ins = db.prepare("insert into cookies values (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) {
    const plain = version >= 24 ? Buffer.concat([createHash("sha256").update(r.host_key).digest(), Buffer.from(r.value)]) : Buffer.from(r.value);
    ins.run(r.host_key, r.name, r.path ?? "/", "", encrypt(plain), r.expires ?? 0, r.secure ? 1 : 0, r.httpOnly ? 1 : 0);
  }
  db.close();
  return path;
}

const rows = [
  { host_key: "my.msd.govt.nz", name: "JSESSIONID", value: "sess-123", expires: chromeTime(1_900_000_000), secure: true, httpOnly: true },
  { host_key: "my.msd.govt.nz", name: "TSPD_101_DID", value: "tok" },
  { host_key: ".msd.govt.nz", name: "_ga", value: "ga" },
  { host_key: ".login.realme.govt.nz", name: "x-ms-cpim-sso:x_0", value: "sso" },
  { host_key: ".google.com", name: "NID", value: "nope" },
];
const domains = ["my.msd.govt.nz", "identity.msd.govt.nz", "login.realme.govt.nz"];

test("decrypts v10 values, strips the host hash on DB version 24+, keeps domain cookies, drops other sites", async () => {
  const cookies = await readChromeCookies({ cookiesPath: makeDb(24, rows), password: PASSWORD, domains });
  const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ["JSESSIONID", "TSPD_101_DID", "_ga", "x-ms-cpim-sso:x_0"]);
  assert.equal(byName.JSESSIONID.value, "sess-123");
  assert.equal(byName.JSESSIONID.expires, 1_900_000_000);
  assert.ok(byName.JSESSIONID.secure && byName.JSESSIONID.httpOnly);
  assert.equal(byName.TSPD_101_DID.expires, -1);
  assert.equal(byName._ga.domain, ".msd.govt.nz");
});

test("a pre-24 database has no host hash prefix", async () => {
  const cookies = await readChromeCookies({ cookiesPath: makeDb(20, rows.slice(0, 1)), password: PASSWORD, domains });
  assert.equal(cookies[0].value, "sess-123");
});

test("decryptValue and chromeTimeToEpoch edge cases", () => {
  assert.equal(decryptValue(Buffer.alloc(0), key, true), "");
  assert.equal(decryptValue(Buffer.from("plain"), key, true), "plain");
  assert.equal(chromeTimeToEpoch(0), -1);
  assert.equal(chromeTimeToEpoch(chromeTime(1_700_000_000)), 1_700_000_000);
});
