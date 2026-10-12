import { test } from "node:test";
import assert from "node:assert/strict";
const { CookieJar } = await import("../dist/jar.js");
const { DesHttp } = await import("../dist/des-http.js");
const { repairDes, desLoginUrl } = await import("../dist/des-oauth.js");
const { SsoDeadError } = await import("../dist/http.js");

const AUTHORIZE = "https://identity.msd.govt.nz/12788802-9a58-4268-a186-7a2f554aeee6/b2c_1a_aem/oauth2/v2.0/authorize?response_type=code&client_id=740be4e9-aadd-4091-8f23-fe4706e7f1fb&redirect_uri=https%3A%2F%2Fnew.my.msd.govt.nz%2Fbin%2Fauth-redirect&state=s1";
const redirect = (location, setCookie = []) => ({ status: 302, headers: { location }, setCookie, body: "" });
const page = (body, status = 200) => ({ status, headers: { "content-type": "text/html" }, setCookie: [], body });
const SELECTION = '<!DOCTYPE html><html><head><title>Loading...</title></head><body><script>var SETTINGS = {"remoteResource":"https://identity.blbstc.msd.govt.nz/b2c/html/sep_idp_selection.html","api":"CombinedSigninAndSignup"};</script><form id="localAccountForm" method="post"><input type="text" name="signInName"/><input type="password" name="password"/></form></body></html>';
const setup = (script) => {
  const calls = [];
  const jar = new CookieJar([{ name: "x-ms-cpim-sso:msdciam.onmicrosoft.com_0", value: "sso", domain: ".identity.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true }]);
  const navigate = async (url, headers, form) => {
    calls.push({ url, cookie: headers.cookie ?? "", form });
    const h = script.shift();
    if (!h) throw new Error(`unexpected nav ${url}`);
    return h(url);
  };
  return { calls, jar, http: new DesHttp(jar, () => {}, navigate) };
};

test("the login URL returns to My jobs", () => {
  assert.equal(desLoginUrl(), "https://new.my.msd.govt.nz/bin/auth/login?rt=%2Fmy-jobs%2F");
});

test("happy path: login → authorize answered from the SSO cookie → auth-redirect sets the session cookies → return page", async () => {
  const { calls, jar, http } = setup([
    () => redirect(AUTHORIZE, ["__Secure-ex=ex1; Path=/bin/auth-redirect; Secure; HttpOnly; SameSite=Lax"]),
    () => redirect("https://new.my.msd.govt.nz/bin/auth-redirect?code=c1&state=s1"),
    () => redirect("/my-jobs/", ["__Host-ui=ui1; Path=/; Secure; HttpOnly", "__Host-csrf=csrf1; Path=/; Secure", "__Secure-ex=; Path=/bin/auth-redirect; Max-Age=0; Secure; HttpOnly"]),
    () => page("<html>my jobs</html>"),
  ]);
  await repairDes(http);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, "https://new.my.msd.govt.nz/bin/auth/login?rt=%2Fmy-jobs%2F");
  assert.ok(calls[1].cookie.includes("x-ms-cpim-sso"), "the IdP hop carries the SSO cookie");
  assert.ok(calls[2].cookie.includes("__Secure-ex=ex1"), "the exchange cookie goes to /bin/auth-redirect");
  assert.equal(calls[3].url, "https://new.my.msd.govt.nz/my-jobs/");
  assert.equal(http.csrfToken(), "csrf1");
  assert.equal(jar.names("new.my.msd.govt.nz").includes("__Secure-ex"), false);
});

test("no SSO: the IdP shows its selection page → SsoDeadError that says a person is needed", async () => {
  const { http } = setup([() => redirect(AUTHORIZE), () => page(SELECTION)]);
  await assert.rejects(repairDes(http), (e) => e instanceof SsoDeadError && /person/.test(e.message));
});

test("an auto-posting form from the IdP is submitted with its fields", async () => {
  const { calls, http } = setup([
    () => redirect(AUTHORIZE),
    () => page('<html><body><form method="POST" action="https://new.my.msd.govt.nz/bin/auth-redirect"><input type="hidden" name="code" value="c&amp;1"/><input type="hidden" name="state" value="s1"/></form></body></html>'),
    () => redirect("/my-jobs/", ["__Host-ui=ui; Path=/; Secure; HttpOnly"]),
    () => page("ok"),
  ]);
  await repairDes(http);
  assert.equal(calls[2].url, "https://new.my.msd.govt.nz/bin/auth-redirect");
  assert.equal(calls[2].form, "code=c%261&state=s1");
});

test("dead ends: DES's error page, a 403 from the login servlet, a hop to a host we do not drive, too many redirects, an odd status", async () => {
  let s = setup([() => redirect(AUTHORIZE), () => redirect("https://new.my.msd.govt.nz/bin/auth-redirect?error=access_denied"), () => redirect("/en/jobs/error/login?code=x")]);
  await assert.rejects(repairDes(s.http), (e) => e instanceof SsoDeadError && /error\/login/.test(e.message));
  s = setup([() => ({ status: 403, headers: { "content-type": "application/json" }, setCookie: [], body: '{"ok":false,"error":"forbidden"}' })]);
  await assert.rejects(repairDes(s.http), (e) => e instanceof SsoDeadError && /403/.test(e.message) && /forbidden/.test(e.message));
  s = setup([() => redirect(AUTHORIZE), () => redirect("https://login.realme.govt.nz/x")]);
  await assert.rejects(repairDes(s.http), (e) => e instanceof SsoDeadError && /login\.realme\.govt\.nz/.test(e.message));
  s = setup(Array.from({ length: 20 }, () => () => redirect("https://new.my.msd.govt.nz/loop")));
  await assert.rejects(repairDes(s.http), (e) => e instanceof SsoDeadError && /redirects/.test(e.message));
  s = setup([() => page("busy", 503)]);
  await assert.rejects(repairDes(s.http), (e) => e instanceof SsoDeadError && /503/.test(e.message));
});
