import { test } from "node:test";
import assert from "node:assert/strict";
const { CookieJar } = await import("../dist/jar.js");
const { Http, SsoDeadError, BotDefenceError } = await import("../dist/http.js");
const { parseAutoPostForm, repairSso } = await import("../dist/sso.js");

const SP_FORM = `<!DOCTYPE html><html><body><noscript><p>Since your browser does not support JavaScript, you must press the Continue button once to proceed.</p></noscript>
<form action="https://identity.msd.govt.nz/msdciam.onmicrosoft.com/B2C_1A_MSD_CIAM_MyMSDSignUpOrSignin/samlp/sso/login" method="post">
<input type="hidden" name="SAMLRequest" value="PHNhbWxwOk&#x2b;QXV0aG5SZXF1ZXN0"/><input type="hidden" name="RelayState" value="a&amp;b"/>
<noscript><input type="submit" value="Continue"/></noscript></form></body></html>`;
const IDP_FORM = `<html><body><form method="POST" name="hiddenform" action="https://my.msd.govt.nz/session/login/samlResponse">
<input type="hidden" name="SAMLResponse" value="PHNhbWxwOlJlc3BvbnNl" /><input type="hidden" name="RelayState" value="a&amp;b" /></form></body></html>`;
const IDP_LOGIN = `<html><body><form id="localAccountForm" action="/x" method="post"><input type="text" name="signInName"/><input type="password" name="password"/></form></body></html>`;
const CHALLENGE = '<html><head><script>window["bobcmn"] = "1";</script></head></html>';

test("parseAutoPostForm takes the first POST form with hidden inputs and decodes entities", () => {
  const f = parseAutoPostForm(SP_FORM);
  assert.equal(f.action, "https://identity.msd.govt.nz/msdciam.onmicrosoft.com/B2C_1A_MSD_CIAM_MyMSDSignUpOrSignin/samlp/sso/login");
  assert.deepEqual(f.fields, { SAMLRequest: "PHNhbWxwOk+QXV0aG5SZXF1ZXN0", RelayState: "a&b" });
  assert.equal(parseAutoPostForm(IDP_LOGIN), null);
  assert.equal(parseAutoPostForm('<form method="post" action="/rel"><input type="hidden" name="a" value="1"></form>', "https://x.test/p/q").action, "https://x.test/rel");
});

let calls, script;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const h = script.shift();
  if (!h) throw new Error(`unexpected fetch ${url}`);
  return h(String(url), init);
};
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "content-type": "text/html;charset=UTF-8", ...headers } });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const setup = () => {
  calls = [];
  const jar = new CookieJar([{ name: "x-ms-cpim-sso:msdciam.onmicrosoft.com_0", value: "sso", domain: ".identity.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true }]);
  return { jar, http: new Http(jar) };
};

test("the happy path: ciamsession → SP form → IdP answers from its SSO cookie → samlResponse → callback", async () => {
  const { http, jar } = setup();
  script = [
    () => json({ redirectUrl: "/saml2/authenticate/ciam?allowCreate=true&token=welcome_dashboard" }),
    () => html(SP_FORM, 200, { "set-cookie": "JSESSIONID=new; Path=/; Secure; HttpOnly" }),
    (url, init) => {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
      assert.ok(init.headers.cookie.includes("x-ms-cpim-sso"));
      assert.equal(new URLSearchParams(init.body).get("SAMLRequest"), "PHNhbWxwOk+QXV0aG5SZXF1ZXN0");
      return html(IDP_FORM);
    },
    (url, init) => {
      assert.equal(url, "https://my.msd.govt.nz/session/login/samlResponse");
      assert.ok(init.headers.cookie.includes("JSESSIONID=new"));
      return new Response(null, { status: 302, headers: { location: "/realme/callback?from=null&status=success&rememberMe=true&intendedUrl=/dashboard" } });
    },
    (url) => {
      assert.equal(url, "https://my.msd.govt.nz/realme/callback?from=null&status=success&rememberMe=true&intendedUrl=/dashboard");
      return html("<html>spa</html>");
    },
  ];
  await repairSso(http);
  assert.equal(calls[0].url, "https://my.msd.govt.nz/idpsaml/ciamsession?intendedUrl=%252Fdashboard");
  assert.equal(calls.length, 5);
  assert.ok(jar.header("https://my.msd.govt.nz/").includes("JSESSIONID=new"));
});

test("an IdP login page (no hand-off form) means a person is needed", async () => {
  const { http } = setup();
  script = [() => json({ redirectUrl: "/saml2/authenticate/ciam?x=1" }), () => html(SP_FORM), () => html(IDP_LOGIN)];
  await assert.rejects(repairSso(http), SsoDeadError);
});

test("a failed callback status is reported; a challenge page is a BotDefenceError", async () => {
  const { http } = setup();
  script = [
    () => json({ redirectUrl: "/saml2/authenticate/ciam?x=1" }),
    () => html(SP_FORM),
    () => html(IDP_FORM),
    () => new Response(null, { status: 302, headers: { location: "/realme/callback?status=realme_unknown_user" } }),
  ];
  await assert.rejects(repairSso(http), (e) => e instanceof SsoDeadError && /realme_unknown_user/.test(e.message));
  script = [() => json({ redirectUrl: "/saml2/authenticate/ciam?x=1" }), () => html(CHALLENGE)];
  await assert.rejects(repairSso(http), BotDefenceError);
});

test("redirects between hops are followed with the jar", async () => {
  const { http } = setup();
  script = [
    () => json({ redirectUrl: "/saml2/authenticate/ciam?x=1" }),
    () => new Response(null, { status: 302, headers: { location: "https://my.msd.govt.nz/saml2/authenticate/ciam?x=2" } }),
    () => html(SP_FORM),
    () => html(IDP_FORM),
    () => new Response(null, { status: 302, headers: { location: "/realme/callback?status=success" } }),
    () => html("ok"),
  ];
  await repairSso(http);
  assert.equal(calls[2].url, "https://my.msd.govt.nz/saml2/authenticate/ciam?x=2");
});
