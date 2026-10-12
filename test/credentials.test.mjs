import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mymsd-credentials-"));
process.env.MYMSD_DIR = dir;
const { CREDENTIALS_FILE, clearPinCredentials, loadPinCredentials, savePinCredentials, validatePinCredentials } = await import("../dist/credentials.js");
const noEnv = {};
const creds = { clientNumber: "000000000", dateOfBirth: "2000-01-01", pin: "1234" };

test("nothing stored → null", () => {
  assert.equal(loadPinCredentials(noEnv), null);
});

test("save writes the file with mode 600; load reads it back with source file", () => {
  savePinCredentials({ ...creds, verifyUsing: "phone" });
  assert.equal(CREDENTIALS_FILE, join(dir, "credentials.json"));
  assert.equal(statSync(CREDENTIALS_FILE).mode & 0o777, 0o600);
  assert.deepEqual(loadPinCredentials(noEnv), { source: "file", creds: { ...creds, verifyUsing: "phone" } });
});

test("environment variables win over the file; an incomplete set in the environment is ignored", () => {
  const env = { MYMSD_CLIENT_NUMBER: "111111111", MYMSD_DATE_OF_BIRTH: "1999-12-31", MYMSD_PIN: "9999" };
  assert.deepEqual(loadPinCredentials(env), { source: "env", creds: { clientNumber: "111111111", dateOfBirth: "1999-12-31", pin: "9999" } });
  assert.equal(loadPinCredentials({ MYMSD_PIN: "9999" }).source, "file");
});

test("validation names the field that is wrong and trims what it accepts", () => {
  assert.throws(() => validatePinCredentials({ ...creds, clientNumber: "12" }), /client number/);
  assert.throws(() => validatePinCredentials({ ...creds, dateOfBirth: "23/02/2004" }), /date of birth/);
  assert.throws(() => validatePinCredentials({ ...creds, pin: "20080" }), /PIN/);
  assert.throws(() => validatePinCredentials({ ...creds, verifyUsing: "pigeon" }), /verifyUsing/);
  assert.deepEqual(validatePinCredentials({ clientNumber: " 000000000 ", dateOfBirth: "2000-01-01", pin: "1234\n" }), creds);
});

test("a corrupt file is reported, not silently ignored", () => {
  writeFileSync(CREDENTIALS_FILE, "{not json");
  assert.throws(() => loadPinCredentials(noEnv), /credentials\.json/);
});

test("clear removes the file", () => {
  clearPinCredentials();
  assert.equal(existsSync(CREDENTIALS_FILE), false);
  assert.equal(loadPinCredentials(noEnv), null);
});
