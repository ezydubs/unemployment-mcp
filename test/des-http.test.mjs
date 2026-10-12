import { test } from "node:test";
import assert from "node:assert/strict";
const { CookieJar } = await import("../dist/jar.js");
const { DesHttp, DesError } = await import("../dist/des-http.js");
const { NotLoggedInError } = await import("../dist/http.js");
const { DES_ORIGIN, DOMAINS } = await import("../dist/paths.js");

let calls, script;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const h = script.shift();
  if (!h) throw new Error(`unexpected fetch ${url}`);
  return h(String(url), init);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html;charset=utf-8" } });
const jar = () =>
  new CookieJar([
    { name: "__Host-csrf", value: "tok", domain: "new.my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: false },
    { name: "__Host-ui", value: "u", domain: "new.my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true },
  ]);

test("paths: the DES origin and its host among the kept domains", () => {
  assert.equal(DES_ORIGIN, "https://new.my.msd.govt.nz");
  assert.ok(DOMAINS.includes("new.my.msd.govt.nz"));
});

test("api sends the SPA's headers: json accept/content-type, same-origin referer and origin, a transaction id, the cookies", async () => {
  calls = [];
  script = [() => json({ statusCode: "200", results: { a: 1 } })];
  const http = new DesHttp(jar());
  const r = await http.api("/bin/sep/vacancies/search", { searchTerms: "x" });
  assert.deepEqual(r.results, { a: 1 });
  const { url, init } = calls[0];
  assert.equal(url, "https://new.my.msd.govt.nz/bin/sep/vacancies/search");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.referer, "https://new.my.msd.govt.nz/en/jobs/");
  assert.equal(init.headers.origin, "https://new.my.msd.govt.nz");
  assert.equal(init.headers.accept, "application/json");
  assert.equal(init.headers["content-type"], "application/json");
  assert.match(init.headers["x-transaction-id"], /^[0-9a-f-]{36}$/);
  assert.ok(init.headers.cookie.includes("__Host-csrf=tok"));
  assert.equal(init.body, JSON.stringify({ searchTerms: "x" }));
  assert.equal(init.redirect, "manual");
});

test("api GET with params is encoded; csrfToken reads the __Host-csrf cookie, empty or missing is null", async () => {
  calls = [];
  script = [() => json({ results: {} })];
  const http = new DesHttp(jar());
  await http.api("/bin/sep/vacancies/details", undefined, { vacancyId: "3007 0041&x", skip: undefined, empty: "" });
  assert.equal(calls[0].url, "https://new.my.msd.govt.nz/bin/sep/vacancies/details?vacancyId=3007+0041%26x");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(http.csrfToken(), "tok");
  assert.equal(new DesHttp(new CookieJar([])).csrfToken(), null);
  assert.equal(new DesHttp(new CookieJar([{ name: "__Host-csrf", value: "", domain: "new.my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: false }])).csrfToken(), null);
});

test("errors: 401 → NotLoggedInError; envelope error → DesError with the site's message; dispatcher 403; HTML 500; redirect → NotLoggedInError", async () => {
  calls = [];
  script = [() => json({ message: "API response error", error: { detail: "API returned status 401" } }, 401)];
  await assert.rejects(new DesHttp(jar()).api("/bin/sep/client-profile"), NotLoggedInError);
  script = [() => json({ statusCode: "400", message: "Job search results could not be fetched", error: { detail: "bad" } }, 400)];
  await assert.rejects(new DesHttp(jar()).api("/bin/sep/vacancies/search", {}), (e) => e instanceof DesError && e.status === 400 && e.code === "400" && e.message === "Job search results could not be fetched" && e.data.detail === "bad");
  script = [() => json({ servlet: "DispatcherServlet", message: "Forbidden", url: "/bin/sep/vacancies/search", status: "403" }, 403)];
  await assert.rejects(new DesHttp(jar()).api("/bin/sep/vacancies/search", {}), (e) => e instanceof DesError && e.status === 403 && e.code === "403" && e.message === "Forbidden");
  script = [() => html("<html><body><h1>Error 500</h1><p>Server error</p></body></html>", 500)];
  await assert.rejects(new DesHttp(jar()).api("/bin/sep/vacancies/match"), (e) => e instanceof DesError && e.status === 500 && e.code === "http_500" && e.message === "Error 500 Server error");
  script = [() => new Response(null, { status: 302, headers: { location: "/en/jobs/error/login" } })];
  await assert.rejects(new DesHttp(jar()).api("/bin/sep/client-profile"), NotLoggedInError);
  script = [() => new Response("", { status: 200 })];
  await assert.rejects(new DesHttp(jar()).api("/bin/sep/client-profile"), (e) => e instanceof DesError && e.code === "http_200" && e.message === "HTTP 200");
});

test("nav goes through the injected transport with the jar's cookies and navigation headers only, and stores Set-Cookie by path", async () => {
  const seen = [];
  const navigate = async (url, headers, form) => {
    seen.push({ url, headers, form });
    return { status: 302, headers: { location: "https://identity.msd.govt.nz/x" }, setCookie: ["__Secure-ex=abc; Path=/bin/auth-redirect; Secure; HttpOnly; SameSite=Lax"], body: "" };
  };
  let saved = 0;
  const j = jar();
  const http = new DesHttp(j, () => saved++, navigate);
  const r = await http.nav("https://new.my.msd.govt.nz/bin/auth/login?rt=%2Fmy-jobs%2F");
  assert.equal(r.status, 302);
  assert.equal(r.location, "https://identity.msd.govt.nz/x");
  assert.equal(seen[0].headers["sec-fetch-mode"], undefined);
  assert.equal(seen[0].headers.origin, undefined);
  assert.match(seen[0].headers.accept, /^text\/html/);
  assert.match(seen[0].headers["user-agent"], /Chrome/);
  assert.ok(seen[0].headers.cookie.includes("__Host-ui=u"));
  assert.equal(seen[0].form, undefined);
  assert.equal(saved, 1);
  assert.ok(j.header("https://new.my.msd.govt.nz/bin/auth-redirect?code=1").includes("__Secure-ex=abc"));
  assert.equal(j.header("https://new.my.msd.govt.nz/my-jobs/").includes("__Secure-ex"), false);
  await http.nav("https://new.my.msd.govt.nz/bin/auth-redirect", "code=1&state=2");
  assert.equal(seen[1].form, "code=1&state=2");
});

test("fetchFile returns the bytes, type and suggested name; an HTML or JSON answer is an error", async () => {
  calls = [];
  script = [() => new Response(Buffer.from("%PDF-1.4 cv"), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="My CV.pdf"' } })];
  const f = await new DesHttp(jar()).fetchFile("/bin/bff/cv");
  assert.equal(f.bytes.toString(), "%PDF-1.4 cv");
  assert.equal(f.contentType, "application/pdf");
  assert.equal(f.filename, "My CV.pdf");
  assert.equal(calls[0].init.headers.referer, "https://new.my.msd.govt.nz/en/jobs/");
  script = [() => html("<html>login</html>", 200)];
  await assert.rejects(new DesHttp(jar()).fetchFile("/bin/bff/cv"), (e) => e instanceof DesError && e.code === "download_failed");
  script = [() => json({ message: "API response error", error: { detail: "API returned status 401" } }, 401)];
  await assert.rejects(new DesHttp(jar()).fetchFile("/bin/bff/cv"), NotLoggedInError);
});

test("the https transport gives up on a hop that never answers", async () => {
  const { makeHttpsNavigate } = await import("../dist/des-http.js");
  const net = await import("node:net");
  const server = net.createServer(() => {}); // accepts the connection and never speaks
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    await assert.rejects(makeHttpsNavigate(200)(`https://127.0.0.1:${port}/bin/auth/login`, {}), /timed out/);
  } finally {
    server.close();
  }
});

test("fetchFile keeps only the base name of the suggested file name and decodes only the RFC 5987 form", async () => {
  calls = [];
  const pdf = (disposition) => () => new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": disposition } });
  script = [pdf('attachment; filename="../../elsewhere/cv.pdf"'), pdf('attachment; filename="CV 100%.pdf"'), pdf("attachment; filename*=UTF-8''My%20CV.pdf"), pdf("inline")];
  assert.equal((await new DesHttp(jar()).fetchFile("/bin/bff/cv")).filename, "cv.pdf");
  assert.equal((await new DesHttp(jar()).fetchFile("/bin/bff/cv")).filename, "CV 100%.pdf");
  assert.equal((await new DesHttp(jar()).fetchFile("/bin/bff/cv")).filename, "My CV.pdf");
  assert.equal((await new DesHttp(jar()).fetchFile("/bin/bff/cv")).filename, null);
});
