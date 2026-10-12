import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mymsd-des-tools-"));
process.env.MYMSD_DIR = dir;
const { Session } = await import("../dist/session.js");
const { register } = await import("../dist/tools/des.js");

let calls, script;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const h = script.shift();
  if (!h) throw new Error(`unexpected fetch ${url}`);
  return h(String(url), init);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const check = (auth) => () =>
  json(auth ? { authenticated: true, remaining: 840, renew: false, clientNumber: "000000000", firstName: "Test", lastName: "Person", profileCompleteness: "Complete", profileStatus: "Active" } : { authenticated: false, reason: "no_session", remaining: 0, renew: false });
const DES = [
  { name: "__Host-ui", value: "u", domain: "new.my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true },
  { name: "__Host-csrf", value: "tok/1", domain: "new.my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: false },
];
const detail = (extra = {}) => json({ statusCode: "200", results: { vacancyDetails: { vacancyId: "30071088", vacancyTitle: "Cleaner", vacancyStatus: "Open", displayPayOnListing: false, vacancyPosting: { startDate: "2026-09-14", endDate: "2099-01-01" } }, client: {}, ...extra } });
const tools = {};
const session = new Session();
session.forget();
register({ registerTool: (name, _meta, handler) => (tools[name] = handler) }, session);
const text = (r) => r.content[0].text;
const data = (r) => JSON.parse(text(r).split("\n\n").slice(1).join("\n\n"));

test("every DES tool is registered", () => {
  assert.deepEqual(Object.keys(tools).sort(), ["des_applications", "des_apply", "des_auth", "des_cv", "des_job", "des_locations", "des_matches", "des_profile", "des_search"]);
});

test("des_job without any DES cookies uses the public endpoint directly", async () => {
  calls = [];
  script = [() => detail()];
  const r = await tools.des_job({ id: "30071088" });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /^30071088: Cleaner/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://new.my.msd.govt.nz/bin/sep/vacancies/details?vacancyId=30071088");
});

test("des_job with DES cookies but a dead session and no SSO cookie falls back to the public endpoint", async () => {
  session.des.addCookies(DES);
  calls = [];
  script = [check(false), () => detail()];
  const r = await tools.des_job({ id: "30071088" });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /^30071088: Cleaner/);
  assert.equal(calls.length, 2);
  assert.equal((calls[1].init.headers.cookie ?? "").includes("__Host-"), false, "the public fallback is anonymous: no dead session cookies");
  session.des.forget();
});

test("des_search validates before any request and reports the site's error text", async () => {
  calls = [];
  script = [];
  const r = await tools.des_search({ limit: 20 });
  assert.equal(r.isError, true);
  assert.match(text(r), /query, occupationGroups, regions or districts/);
  assert.equal(calls.length, 0);
  script = [() => json({ statusCode: "500", message: "Job search results could not be fetched" }, 500)];
  const e = await tools.des_search({ query: "cleaner", limit: 20 });
  assert.equal(text(e), "Error: 500: Job search results could not be fetched");
});

test("des_apply: dry run fetches the detail, sends no POST and masks the csrf token; refusals name the reason", async () => {
  session.des.addCookies(DES);
  calls = [];
  script = [check(true), () => detail()];
  const r = await tools.des_apply({ id: "30071088", cv: "existing", reference: "No", confirm: false });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /^Dry run — nothing sent\. With confirm: true, an application for "Cleaner" \(job 30071088\) will be submitted with the CV MSD already holds and reference: No/);
  const d = data(r);
  assert.equal(d.request.path, "/bin/sep/vacancy-apply-submit?csrf=<__Host-csrf>");
  assert.deepEqual(d.request.body, { vacancyId: "30071088", selectedCV: "existing", selectedReference: "No" });
  assert.equal(calls.length, 2, "check + detail only");
  script = [() => detail({ applicationForm: { applicationFormName: "AF-1", applicationStage: "Submitted" } })];
  const already = await tools.des_apply({ id: "30071088", cv: "existing", reference: "No", confirm: true });
  assert.equal(already.isError, true);
  assert.match(text(already), /cannot apply for Cleaner: you already applied \(AF-1, Submitted\)/);
  assert.equal(calls.length, 3, "no POST after a refusal");
});

test("des_apply with confirm posts the SPA's body with the csrf token in the query and reports the application id", async () => {
  calls = [];
  script = [() => detail(), () => json({ statusCode: "200", results: { applicationFormId: "a0X1", applicationFormName: "AF-000124" } })];
  const r = await tools.des_apply({ id: "30071088", cv: "own", reference: "Yes", confirm: true });
  assert.equal(r.isError, undefined);
  assert.equal(calls[1].url, "https://new.my.msd.govt.nz/bin/sep/vacancy-apply-submit?csrf=tok%2F1");
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), { vacancyId: "30071088", selectedCV: "own", selectedReference: "Yes" });
  assert.match(text(r), /^Applied for Cleaner: application AF-000124 \(a0X1\)\. Reply to MSD's confirmation email with your CV attached\./);
});

test("a confirmed des_apply whose POST loses the session is not re-sent", async () => {
  calls = [];
  script = [() => detail(), () => json({ message: "API response error", error: { detail: "API returned status 401" } }, 401)];
  const r = await tools.des_apply({ id: "30071088", cv: "existing", reference: "No", confirm: true });
  assert.equal(r.isError, true);
  assert.match(text(r), /may or may not have been recorded/);
  assert.match(text(r), /des_applications/);
  assert.equal(calls.length, 2, "detail + one POST, no retry");
});

test("des_matches treats the site's 404 as no matches", async () => {
  calls = [];
  script = [() => new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } })];
  const r = await tools.des_matches({ limit: 3 });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /^No job matches/);
});

test("des_cv saves the file where asked", async () => {
  calls = [];
  script = [() => new Response(Buffer.from("%PDF cv"), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="cv.pdf"' } })];
  const r = await tools.des_cv({ path: join(dir, "out", "my-cv.pdf") });
  assert.equal(r.isError, undefined);
  assert.equal(readFileSync(join(dir, "out", "my-cv.pdf"), "utf8"), "%PDF cv");
  assert.match(text(r), /Saved your CV \(7 bytes, application\/pdf\) to /);
});

test("des_auth status and forget; a signed-in tool without any session says how to sign in", async () => {
  calls = [];
  script = [];
  const st = await tools.des_auth({ action: "status" });
  assert.match(text(st), /^Signed in to DES as Test Person \(client 000000000\)/);
  const f = await tools.des_auth({ action: "forget" });
  assert.match(text(f), /^Forgot the DES session/);
  assert.equal(session.des.hasCookies(), false);
  const r = await tools.des_applications({});
  assert.equal(r.isError, true);
  assert.match(text(r), /des_auth login/);
  assert.equal(calls.length, 0);
});
