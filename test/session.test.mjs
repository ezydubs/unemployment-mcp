import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mymsd-session-"));
process.env.MYMSD_DIR = dir;
const { Session } = await import("../dist/session.js");
const { NotLoggedInError, NotPermittedError } = await import("../dist/http.js");

const SP_FORM = '<form action="https://identity.msd.govt.nz/x/samlp/sso/login" method="post"><input type="hidden" name="SAMLRequest" value="q"/></form>';
const IDP_FORM = '<form method="POST" action="https://my.msd.govt.nz/session/login/samlResponse"><input type="hidden" name="SAMLResponse" value="r"/></form>';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const session = (auth, extra = {}) =>
  json({ isAuthenticated: auth, csrfToken: auth ? "csrf-9" : null, firstName: auth ? "Test" : "", clientNumber: auth ? "000000000" : "", timeout: 900, preferredLoginMethod: "realme", verifiedDevice: true, desUrl: "https://new.my.msd.govt.nz", ...extra });
const ssoHops = () => [
  () => json({ redirectUrl: "/saml2/authenticate/ciam?x=1" }),
  () => html(SP_FORM),
  () => html(IDP_FORM),
  () => new Response(null, { status: 302, headers: { location: "/realme/callback?status=success" } }),
  () => html("spa"),
];
let calls, inits, script;
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  inits.push(init ?? {});
  const h = script.shift();
  if (!h) throw new Error(`unexpected fetch ${url}`);
  return h(String(url), init);
};
const cookie = { name: "JSESSIONID", value: "s", domain: "my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true };
const fresh = () => {
  calls = [];
  inits = [];
  const s = new Session();
  s.forget();
  s.addCookies([cookie]);
  return s;
};

test("no cookies → NotLoggedInError naming the auth actions", async () => {
  calls = [];
  script = [];
  const s = new Session();
  s.forget();
  await assert.rejects(s.ensure(), (e) => e instanceof NotLoggedInError && /import_chrome/.test(e.message) && /login/.test(e.message));
});

test("ensure checks the session, memoises for 60 s, saves the file with mode 600 and the csrf token", async () => {
  const s = fresh();
  script = [() => session(true)];
  const info = await s.ensure();
  assert.equal(info.firstName, "Test");
  assert.equal(s.http.csrfToken, "csrf-9");
  await s.ensure();
  assert.equal(calls.length, 1, "second ensure within the memo window makes no request");
  const file = join(dir, "session.json");
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).info.csrfToken, "csrf-9");
  assert.equal(Session.load().http.csrfToken, "csrf-9");
});

test("an expired session is repaired with the SSO dance, once, even when two calls arrive together", async () => {
  const s = fresh();
  script = [() => session(false), ...ssoHops(), () => session(true)];
  const [a, b] = await Promise.all([s.ensure(), s.ensure()]);
  assert.ok(a.isAuthenticated && b.isAuthenticated);
  assert.equal(calls.filter((u) => u.includes("/idpsaml/ciamsession")).length, 1);
  assert.equal(s.repairs, 1);
});

test("a dead SSO becomes a NotLoggedInError with the next step", async () => {
  const s = fresh();
  script = [() => session(false), () => json({ redirectUrl: "/saml2/authenticate/ciam" }), () => html(SP_FORM), () => html("<form method=post action=/x><input type=text name=user></form>")];
  await assert.rejects(s.ensure(), (e) => e instanceof NotLoggedInError && /mymsd_auth login/.test(e.message));
});

test("run retries once after a call reveals the session died, and keeps a genuine not-permitted", async () => {
  const s = fresh();
  script = [() => session(true), () => json({ error: { code: "unauthenticated" } }, 401), () => session(false), ...ssoHops(), () => session(true), () => json({ letters: [] })];
  const r = await s.run((http) => http.get("/rest/letters"));
  assert.deepEqual(r, { letters: [] });
  script = [() => html("<html class=LoginPage>", 403), () => session(true)];
  await assert.rejects(s.run((http) => http.get("/rest/emergency-housing")), NotPermittedError);
});

test("run retries when a concurrent repair landed while the failing call was in flight", async () => {
  const s = fresh();
  script = [() => session(true), () => session(true), () => json({ letters: [] })];
  let attempts = 0;
  const r = await s.run(async (http) => {
    if (attempts++ === 0) {
      s.repairs++; // another caller's repair finished during this call
      throw new NotLoggedInError("gone");
    }
    return http.get("/rest/letters");
  });
  assert.deepEqual(r, { letters: [] });
});

test("a redirect from /rest/session itself still triggers the SSO repair", async () => {
  const s = fresh();
  script = [() => new Response(null, { status: 302, headers: { location: "/login" } }), ...ssoHops(), () => session(true)];
  const info = await s.ensure();
  assert.ok(info.isAuthenticated);
  assert.equal(s.repairs, 1);
});

test("status reports the jar and timestamps without secrets", async () => {
  const s = fresh();
  script = [() => session(true)];
  await s.ensure();
  const st = s.status();
  assert.equal(st.signedIn, true);
  assert.equal(st.firstName, "Test");
  assert.deepEqual(st.cookies.find((c) => c.domain === "my.msd.govt.nz").names, ["JSESSIONID"]);
  assert.equal(JSON.stringify(st).includes("csrf-9"), false);
});

// --- stored PIN sign-in (mymsd-logon set / MYMSD_* environment) as the fallback when single sign-on is gone ---
const PIN_ENV = { MYMSD_CLIENT_NUMBER: "000000000", MYMSD_DATE_OF_BIRTH: "2000-01-01", MYMSD_PIN: "1234" };
const withPin = (fn) => async () => {
  Object.assign(process.env, PIN_ENV);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(PIN_ENV)) delete process.env[k];
  }
};
const deadSso = () => [() => json({ redirectUrl: "/saml2/authenticate/ciam" }), () => html(SP_FORM), () => html("<form method=post action=/x><input type=text name=user></form>")];
const PIN_URL = "https://my.msd.govt.nz/session/login/pin";

test("dead SSO with a stored PIN sign-in: clears, signs in with the PIN, counts a repair", withPin(async () => {
  const s = fresh();
  script = [() => session(false), ...deadSso(), () => json({}), () => json({}), () => session(true)];
  const info = await s.ensure();
  assert.ok(info.isAuthenticated);
  assert.equal(s.repairs, 1);
  const i = calls.indexOf(PIN_URL);
  assert.ok(i > 3, "the PIN sign-in is posted only after the SSO replay failed");
  assert.equal(calls[i - 1], "https://my.msd.govt.nz/rest/session/clear");
  assert.equal(inits[i].method, "POST");
  assert.deepEqual(JSON.parse(inits[i].body), { clientNumber: "000000000", dateOfBirth: "2000-01-01", pin: "1234", rememberMe: "true", csrfToken: null });
}));

test("no cookies at all but a stored PIN sign-in: signs in with the PIN instead of asking for Chrome", withPin(async () => {
  calls = [];
  inits = [];
  const s = new Session();
  s.forget();
  script = [() => json({}), () => json({}), () => session(true)];
  const info = await s.ensure();
  assert.ok(info.isAuthenticated);
  assert.equal(calls[1], PIN_URL);
  assert.equal(s.repairs, 1);
}));

test("without a stored PIN the dead-SSO error now also names the stored sign-in", async () => {
  const s = fresh();
  script = [() => session(false), ...deadSso()];
  await assert.rejects(s.ensure(), (e) => e instanceof NotLoggedInError && /mymsd_auth login/.test(e.message) && /mymsd-logon set/.test(e.message));
});

test("MyMSD wants to verify the device: the code is sent, the token kept in the session file, the error says how to finish; verifyDevice completes it", withPin(async () => {
  const s = fresh();
  script = [
    () => session(false),
    ...deadSso(),
    () => json({}),
    () => json({ redirectUrl: "/login/verify-device" }),
    () => session(false, { verifiedDevice: false }),
    () => json({ verificationSentTo: "phone", token: "t-1", clientDetails: { maskedPhone: "***123" } }),
  ];
  await assert.rejects(s.ensure(), (e) => e instanceof NotLoggedInError && /verify this device/.test(e.message) && /phone/.test(e.message) && /mymsd-logon verify/.test(e.message));
  const i = calls.indexOf("https://my.msd.govt.nz/rest/logon/verifydevice/send-code");
  assert.deepEqual(JSON.parse(inits[i].body), { verifyUsing: "", token: "", rememberDevice: true, csrfToken: null });
  assert.equal(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).pendingVerification.token, "t-1");
  assert.equal(s.repairs, 0);
  assert.equal(JSON.stringify(s.status()).includes("t-1"), false, "status never shows the verification token");
  assert.equal(s.status().pendingVerification, "phone");
  script = [() => json({}), () => session(true)];
  const info = await s.verifyDevice("123456");
  assert.ok(info.isAuthenticated);
  const j = calls.indexOf("https://my.msd.govt.nz/rest/logon/verifydevice/verify-code");
  assert.deepEqual(JSON.parse(inits[j].body), { code: "123456", token: "t-1", rememberDevice: true, csrfToken: null });
  assert.equal(s.pendingVerification, null);
  assert.equal(s.repairs, 1);
  await assert.rejects(s.verifyDevice("123456"), /no verification code is pending/);
}));

test("a rejected PIN sign-in is reported with MyMSD's own words and nothing is retried", withPin(async () => {
  const s = fresh();
  script = [() => session(false), ...deadSso(), () => json({}), () => json({ error: { code: "err.unauthenticated", message: "Incorrect PIN" } }, 401)];
  await assert.rejects(s.ensure(), (e) => e instanceof NotLoggedInError && /rejected the PIN sign-in/.test(e.message) && /Incorrect PIN/.test(e.message));
  assert.equal(script.length, 0);
  script = [() => session(false), ...deadSso(), () => json({}), () => json({ isAuthenticated: false }), () => session(false)];
  await assert.rejects(s.ensure(true), (e) => e instanceof NotLoggedInError && /rejected the PIN sign-in/.test(e.message) && /no session after/.test(e.message));
}));

test("a session file written by another process (mymsd-logon) is picked up before any repair", async () => {
  const s = fresh();
  script = [() => session(true)];
  await s.ensure();
  const file = join(dir, "session.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.cookies = [{ ...cookie, value: "fresh" }];
  stored.info = null;
  stored.checkedAt = 0;
  writeFileSync(file, JSON.stringify(stored));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  script = [() => session(true)];
  await s.ensure(true);
  assert.match(inits.at(-1).headers.cookie, /JSESSIONID=fresh/);
  assert.equal(s.jar.toJSON().length, 1, "the file replaces the jar, it is not merged into it");
});
