import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
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
let calls, script;
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  const h = script.shift();
  if (!h) throw new Error(`unexpected fetch ${url}`);
  return h(String(url), init);
};
const cookie = { name: "JSESSIONID", value: "s", domain: "my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true };
const fresh = () => {
  calls = [];
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
