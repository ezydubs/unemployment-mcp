import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mymsd-logon-"));
process.env.MYMSD_DIR = dir;
const { main } = await import("../dist/logon.js");
const { Session } = await import("../dist/session.js");
const { register } = await import("../dist/tools/auth.js");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = (auth, extra = {}) =>
  json({ isAuthenticated: auth, csrfToken: auth ? "csrf-9" : null, firstName: auth ? "Test" : "", clientNumber: auth ? "000000000" : "", timeout: 900, preferredLoginMethod: "pin", verifiedDevice: true, desUrl: "https://new.my.msd.govt.nz", ...extra });
let calls, script;
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  const h = script.shift();
  if (!h) throw new Error(`unexpected fetch ${url}`);
  return h(String(url), init);
};
const run = async (argv) => {
  const lines = [];
  const code = await main(argv, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
};
const PIN_URL = "https://my.msd.govt.nz/session/login/pin";

test("usage for no command, an unknown command, set without details, verify without a code", async () => {
  calls = [];
  script = [];
  for (const argv of [[], ["bogus"], ["set", "000000000"], ["verify"], ["verify", "12"]]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.out, /mymsd-logon set <client number> <YYYY-MM-DD> <pin>/);
  }
  assert.equal(calls.length, 0);
});

test("login without anything stored says how to store it", async () => {
  calls = [];
  script = [];
  const r = await run(["login"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /No PIN sign-in stored/);
});

test("set stores the details with mode 600 and signs in at once, showing neither the PIN nor the full client number", async () => {
  calls = [];
  script = [() => json({}), () => json({}), () => session(true)];
  const r = await run(["set", "000000000", "2000-01-01", "1234"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
  assert.match(r.out, /Stored the PIN sign-in for client ••••••000/);
  assert.match(r.out, /Signed in to MyMSD as Test/);
  assert.equal(r.out.includes("1234"), false);
  assert.equal(r.out.includes("000000000"), false);
  assert.equal(calls[1], PIN_URL);
  assert.equal(Session.load().info.isAuthenticated, true, "the session file now holds the sign-in for the server to pick up");
});

test("status names the source and the masked client, never the values", async () => {
  calls = [];
  script = [];
  const r = await run(["status"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /PIN sign-in stored \(file\) for client ••••••000/);
  assert.match(r.out, /signed in as Test/);
  assert.equal(r.out.includes("1234"), false);
  assert.equal(r.out.includes("2000-01-01"), false);
});

test("login that needs device verification says where the code went; verify finishes it", async () => {
  calls = [];
  script = [() => json({}), () => json({ redirectUrl: "/login/verify-device" }), () => session(false, { verifiedDevice: false }), () => json({ verificationSentTo: "email", token: "t-9" })];
  const r = await run(["login"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /code was sent to your email/);
  assert.match(r.out, /mymsd-logon verify <code>/);
  const st = await run(["status"]);
  assert.match(st.out, /code was sent to your email/);
  script = [() => json({}), () => session(true)];
  const v = await run(["verify", "654321"]);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /Device verified\. Signed in to MyMSD as Test/);
  assert.equal(calls.at(-2), "https://my.msd.govt.nz/rest/logon/verifydevice/verify-code");
});

test("a rejected sign-in is an error exit with MyMSD's words; clear deletes the details and keeps the session", async () => {
  calls = [];
  script = [() => json({}), () => json({ error: { code: "err.unauthenticated", message: "Incorrect PIN" } }, 401)];
  const r = await run(["login"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /rejected the PIN sign-in/);
  assert.match(r.out, /Incorrect PIN/);
  const c = await run(["clear"]);
  assert.equal(c.code, 0);
  assert.equal(existsSync(join(dir, "credentials.json")), false);
  assert.equal(existsSync(join(dir, "session.json")), true);
});

// --- the MCP tool: login_pin with no details uses the stored sign-in ---
const PIN_ENV = { MYMSD_CLIENT_NUMBER: "000000000", MYMSD_DATE_OF_BIRTH: "2000-01-01", MYMSD_PIN: "1234" };
const text = (r) => r.content[0].text;

test("mymsd_auth login_pin without details: needs a stored sign-in, then uses it; status says where it comes from", async () => {
  const tools = {};
  const s = new Session();
  s.forget();
  register({ registerTool: (name, _meta, handler) => (tools[name] = handler) }, s);
  await run(["clear"]);
  calls = [];
  script = [];
  const none = await tools.mymsd_auth({ action: "login_pin" });
  assert.equal(none.isError, true);
  assert.match(text(none), /mymsd-logon set/);
  assert.equal(calls.length, 0);
  Object.assign(process.env, PIN_ENV);
  try {
    script = [() => json({}), () => json({}), () => session(true)];
    const r = await tools.mymsd_auth({ action: "login_pin" });
    assert.equal(r.isError, undefined, text(r));
    assert.match(text(r), /^Signed in with PIN \(stored, env\)\. Signed in to MyMSD as Test/);
    assert.equal(text(r).includes("1234"), false);
    script = [() => json({ timeRemaining: null, returnToUrl: null })];
    const st = await tools.mymsd_auth({ action: "status" });
    assert.match(text(st), /PIN sign-in stored: env/);
    assert.equal(text(st).includes("1234"), false);
    assert.equal(text(st).includes("2000-01-01"), false);
    script = [() => json({}), () => json({ redirectUrl: "/login/verify-device" }), () => session(false, { verifiedDevice: false }), () => json({ verificationSentTo: "phone", token: "t-2" })];
    const v = await tools.mymsd_auth({ action: "login_pin", rememberMe: false });
    assert.match(text(v), /sent a verification code to your phone/);
    script = [() => json({}), () => session(true)];
    const done = await tools.mymsd_auth({ action: "login_pin", code: "111222" });
    assert.match(text(done), /^Device verified\. Signed in to MyMSD as Test/);
  } finally {
    for (const k of Object.keys(PIN_ENV)) delete process.env[k];
  }
});
