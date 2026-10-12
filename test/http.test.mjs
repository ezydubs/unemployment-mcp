import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { CookieJar } = await import("../dist/jar.js");
const { Http, MsdError, NotLoggedInError, BotDefenceError, NotPermittedError, isChallengePage } = await import("../dist/http.js");

const CHALLENGE = '<!DOCTYPE html><html><head><script>(function(){window["bobcmn"] = "1011";})();</script><script src="/TSPD/080e?type=10"></script></head></html>';
let calls = [];
let script = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const next = script.shift();
  if (!next) throw new Error(`unexpected fetch ${url}`);
  return typeof next === "function" ? next(url, init) : next;
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const fresh = () => {
  calls = [];
  const jar = new CookieJar([{ name: "JSESSIONID", value: "s1", domain: "my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true }]);
  let saved = 0;
  const http = new Http(jar, () => saved++);
  http.csrfToken = "csrf-1";
  return { jar, http, saves: () => saved };
};

test("get sends cookies, XHR headers and query params, parses JSON, stores Set-Cookie", async () => {
  const { http, jar, saves } = fresh();
  script = [json({ ok: 1 }, 200, { "set-cookie": "TSeae47ed5027=rot; Path=/" })];
  assert.deepEqual(await http.get("/rest/appointments/check", { reasonIds: "a,b", endDate: undefined, empty: "" }), { ok: 1 });
  assert.equal(calls[0].url, "https://my.msd.govt.nz/rest/appointments/check?reasonIds=a%2Cb");
  assert.equal(calls[0].init.headers.cookie, "JSESSIONID=s1");
  assert.equal(calls[0].init.headers["x-requested-with"], "XMLHttpRequest");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(jar.header("https://my.msd.govt.nz/"), "JSESSIONID=s1; TSeae47ed5027=rot");
  assert.equal(saves(), 1);
});

test("post injects csrfToken and delete uses the XHR headers", async () => {
  const { http } = fresh();
  script = [json({ done: true }), new Response(null, { status: 204 })];
  await http.post("/rest/housing-register/check-passcode", { passcode: "1234" });
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { passcode: "1234", csrfToken: "csrf-1" });
  assert.equal(calls[0].init.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(await http.delete("/rest/appointments/7"), null);
  assert.equal(calls[1].init.method, "DELETE");
});

test("post with no body sends no body (medical certificate declaration)", async () => {
  const { http } = fresh();
  script = [json({})];
  await http.post("/rest/medicalCertificate");
  assert.equal(calls[0].init.body, undefined);
});

test("error envelope → MsdError; 401 or an unauthenticated code → NotLoggedInError", async () => {
  const { http } = fresh();
  script = [json({ error: { code: "invalid_credentials", message: "nope", data: { attemptsRemaining: 2 } } }, 400)];
  await assert.rejects(http.get("/rest/x"), (e) => e instanceof MsdError && e.code === "invalid_credentials" && e.status === 400 && e.data.attemptsRemaining === 2);
  script = [json({ error: { code: "unauthenticated", message: "x" } }, 401)];
  await assert.rejects(http.get("/rest/x"), NotLoggedInError);
  script = [json({ error: { code: "ap.unauthenticated", message: "x" } }, 403)];
  await assert.rejects(http.get("/rest/x"), NotLoggedInError);
});

test("challenge HTML → BotDefenceError; login-page 403 → NotPermittedError; redirect → NotLoggedInError", async () => {
  const { http } = fresh();
  assert.ok(isChallengePage(CHALLENGE));
  script = [html(CHALLENGE)];
  await assert.rejects(http.get("/rest/session"), BotDefenceError);
  script = [html('<!DOCTYPE html><html class="LoginPage"></html>', 403)];
  await assert.rejects(http.get("/rest/emergency-housing"), NotPermittedError);
  script = [new Response(null, { status: 302, headers: { location: "/login" } })];
  await assert.rejects(http.get("/rest/letters"), NotLoggedInError);
});

test("upload builds the site's multipart form: file/file1..N plus meta-data with csrfToken", async () => {
  const { http } = fresh();
  const dir = mkdtempSync(join(tmpdir(), "mymsd-up-"));
  const a = join(dir, "a.pdf");
  const b = join(dir, "b.png");
  writeFileSync(a, "%PDF-1.4");
  writeFileSync(b, "png");
  script = [json({ id: "f1", isQualityAcceptable: true }), json({ id: "f2" })];
  await http.upload("/rest/hardship/evidence", [{ path: a }], { workType: "GenericUpload" });
  let form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.deepEqual(JSON.parse(form.get("meta-data")), { workType: "GenericUpload", csrfToken: "csrf-1" });
  assert.equal(form.get("file").name, "a.pdf");
  assert.equal(form.get("file").type, "application/pdf");
  assert.equal(calls[0].init.headers["content-type"], undefined);
  await http.upload("/rest/x", [{ path: a }, { path: b }]);
  form = calls[1].init.body;
  assert.equal(form.get("file1").name, "a.pdf");
  assert.equal(form.get("file2").type, "image/png");
  assert.equal(form.get("csrfToken"), "csrf-1");
});

test("download writes the body to a file and refuses HTML", async () => {
  const { http } = fresh();
  const dir = mkdtempSync(join(tmpdir(), "mymsd-dl-"));
  script = [new Response("%PDF-1.4 letter", { status: 200, headers: { "content-type": "application/pdf" } })];
  const r = await http.download("/rest/letters/42", join(dir, "sub", "letter.pdf"));
  assert.equal(readFileSync(r.path, "utf8"), "%PDF-1.4 letter");
  assert.equal(r.bytes, 15);
  assert.equal(r.contentType, "application/pdf");
  script = [html(CHALLENGE)];
  await assert.rejects(http.download("/rest/letters/42", join(dir, "x.pdf")), BotDefenceError);
});
