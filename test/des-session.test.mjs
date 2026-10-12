import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mymsd-des-session-"));
process.env.MYMSD_DIR = dir;
const { Session } = await import("../dist/session.js");
const { DesSession, DES_NEXT_STEP } = await import("../dist/des-session.js");
const { CookieJar } = await import("../dist/jar.js");
const { NotLoggedInError } = await import("../dist/http.js");
const { DesError } = await import("../dist/des-http.js");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const check = (auth, remaining = 840) =>
  json(auth ? { authenticated: true, remaining, renew: false, clientNumber: "000000000", firstName: "Test", lastName: "Person", profileCompleteness: "Complete", profileStatus: "Active", migratedUser: "" } : { authenticated: false, reason: "no_session", remaining: 0, renew: false });
let calls, script;
globalThis.fetch = async (url, init) => {
  calls.push(String(url));
  const h = script.shift();
  if (!h) throw new Error(`unexpected fetch ${url}`);
  return typeof h === "function" ? h(String(url), init) : h; // a scripted entry is a function or a ready Response
};
const AUTHORIZE = "https://identity.msd.govt.nz/t/b2c_1a_aem/oauth2/v2.0/authorize?x=1";
const redirect = (location, setCookie = []) => ({ status: 302, headers: { location }, setCookie, body: "" });
const page = (body, status = 200) => ({ status, headers: { "content-type": "text/html" }, setCookie: [], body });
const SELECTION = '<html><form id="localAccountForm" method="post"><input type="text" name="signInName"/></form></html>';
const hops = () => [
  () => redirect(AUTHORIZE, ["__Secure-ex=ex1; Path=/bin/auth-redirect; Secure; HttpOnly"]),
  () => redirect("https://new.my.msd.govt.nz/bin/auth-redirect?code=c1&state=s1"),
  () => redirect("/my-jobs/", ["__Host-ui=ui1; Path=/; Secure; HttpOnly", "__Host-csrf=csrf1; Path=/; Secure"]),
  () => page("ok"),
];
const DES = [
  { name: "__Host-ui", value: "u", domain: "new.my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true },
  { name: "__Host-csrf", value: "t", domain: "new.my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: false },
];
const SSO = { name: "x-ms-cpim-sso:msdciam.onmicrosoft.com_0", value: "sso", domain: ".identity.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true };
const GA = { name: "_ga", value: "g", domain: ".msd.govt.nz", path: "/", expires: -1, secure: false, httpOnly: false };
const fresh = ({ des = true, sso = true } = {}) => {
  calls = [];
  const jar = new CookieJar([GA, ...(des ? DES : []), ...(sso ? [SSO] : [])]);
  const navs = [];
  const navigate = async (url) => {
    calls.push(`nav ${url}`);
    const h = navs.shift();
    if (!h) throw new Error(`unexpected nav ${url}`);
    return h(url);
  };
  let saves = 0;
  const s = new DesSession(jar, () => saves++, undefined, navigate);
  return { s, jar, nav: (arr) => navs.push(...arr), saves: () => saves };
};

test("ensure posts the SPA's userInfo check, records who is signed in, memoises for 60 s, saves", async () => {
  const { s, saves } = fresh();
  script = [check(true)];
  const info = await s.ensure();
  assert.equal(info.firstName, "Test");
  assert.equal(info.remaining, 840);
  assert.equal(calls[0], "https://new.my.msd.govt.nz/bin/auth/check");
  await s.ensure();
  assert.equal(calls.length, 1, "second ensure within the memo window makes no request");
  assert.equal(saves(), 1);
  assert.equal(s.status().signedIn, true);
  assert.equal(s.status().clientNumber, "000000000");
  assert.ok(s.status().remainingSeconds > 800);
  assert.deepEqual(s.status().cookies, ["__Host-ui", "__Host-csrf"]);
  assert.equal(JSON.stringify(s.status()).includes('"t"'), false, "no cookie values in the status");
});

test("memo honours remaining: a session about to expire is re-checked", async () => {
  const { s } = fresh();
  script = [check(true, 10), check(true, 840)];
  await s.ensure();
  await s.ensure();
  assert.equal(calls.length, 2);
});

test("no DES cookies and no SSO cookie → NotLoggedInError naming des_auth, without a request; GA cookies on .msd.govt.nz do not count as SSO", async () => {
  const { s } = fresh({ des: false, sso: false });
  script = [];
  assert.equal(s.hasCookies(), false);
  assert.equal(s.hasSso(), false);
  await assert.rejects(s.ensure(), (e) => e instanceof NotLoggedInError && /des_auth login/.test(e.message) && /import_chrome/.test(e.message));
  assert.equal(calls.length, 0);
});

test("an ended session is repaired through B2C's SSO once, even for two concurrent callers", async () => {
  const { s, nav } = fresh();
  script = [check(false), check(true)];
  nav(hops());
  const [a, b] = await Promise.all([s.ensure(), s.ensure()]);
  assert.ok(a.authenticated && b.authenticated);
  assert.equal(calls.filter((c) => c.includes("/bin/auth/login")).length, 1);
  assert.equal(s.repairs, 1);
  assert.equal(s.http.csrfToken(), "csrf1");
});

test("DES cookies present but a 401 on the check is treated as no session and repaired", async () => {
  const { s, nav } = fresh();
  script = [() => json({ message: "API response error", error: { detail: "API returned status 401" } }, 401), check(true)];
  nav(hops());
  const info = await s.ensure();
  assert.ok(info.authenticated);
  assert.equal(s.repairs, 1);
});

test("a dead SSO becomes a NotLoggedInError with the next step", async () => {
  const { s, nav } = fresh();
  script = [check(false)];
  nav([() => redirect(AUTHORIZE), () => page(SELECTION)]);
  await assert.rejects(s.ensure(), (e) => e instanceof NotLoggedInError && /silent sign-in failed/.test(e.message) && e.message.endsWith(DES_NEXT_STEP));
});

test("run retries once after a 401 when a repair happened; a genuine DesError passes through", async () => {
  const { s, nav } = fresh();
  script = [check(true), () => json({ message: "x", error: { detail: "401" } }, 401), check(false), check(true), () => json({ results: { ok: 1 } })];
  nav(hops());
  const r = await s.run((http) => http.api("/bin/sep/client-profile"));
  assert.deepEqual(r, { results: { ok: 1 } });
  script = [() => json({ statusCode: "500", message: "boom" }, 500)];
  await assert.rejects(s.run((http) => http.api("/bin/sep/client-profile")), DesError);
});

test("addCookies drops empty values (a logout's leftovers) and resets the memo; forget drops only DES cookies", async () => {
  const { s, jar } = fresh({ des: false });
  const desNames = () => jar.toJSON().filter((c) => c.domain === "new.my.msd.govt.nz").map((c) => c.name);
  s.addCookies([{ ...DES[0], value: "" }, DES[1]]);
  assert.deepEqual(desNames(), ["__Host-csrf"]);
  s.forget();
  assert.deepEqual(desNames(), []);
  assert.equal(s.hasSso(), true);
  assert.equal(s.info, null);
});

test("the MyMSD Session carries the DES session on the same jar and saves it in the same file; forget clears it", () => {
  const s = new Session();
  s.forget();
  assert.equal(s.des.jar, s.jar);
  s.des.info = { authenticated: true, reason: null, remaining: 800, renew: false, clientNumber: "000000000", firstName: "Test", lastName: "Person", profileCompleteness: "Complete", profileStatus: "Active", migratedUser: "" };
  s.des.checkedAt = Date.now();
  s.save();
  assert.equal(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).des.info.firstName, "Test");
  const again = Session.load();
  assert.equal(again.des.info.firstName, "Test");
  assert.equal(again.des.jar, again.jar);
  again.forget();
  assert.equal(again.des.info, null);
  assert.equal(again.des.checkedAt, 0);
});
