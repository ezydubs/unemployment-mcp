import { test } from "node:test";
import assert from "node:assert/strict";
const { fail, dryRun, tolerant } = await import("../dist/tools/common.js");
const { MsdError, NotLoggedInError, NotPermittedError, BotDefenceError } = await import("../dist/http.js");

test("fail maps each error class to an isError result with the next step", () => {
  assert.match(fail(new NotLoggedInError("run mymsd_auth import_chrome")).content[0].text, /^Error: run mymsd_auth import_chrome/);
  assert.match(fail(new BotDefenceError("F5")).content[0].text, /bot defence/i);
  assert.match(fail(new NotPermittedError("x")).content[0].text, /not available on this account/);
  const r = fail(new MsdError("invalid_data", "bad", 400, { field: "pin" }));
  assert.ok(r.isError);
  assert.match(r.content[0].text, /invalid_data: bad/);
  assert.match(r.content[0].text, /"field": "pin"/);
  assert.match(fail(new Error("boom")).content[0].text, /^Error: boom/);
  assert.match(fail(new NotLoggedInError("MyMSD redirected to /login: the session has ended")).content[0].text, /mymsd_auth/, "every sign-in failure names the next step");
});

test("dryRun describes the request without sending it", () => {
  const r = dryRun({ method: "POST", path: "/rest/x", body: { a: 1 } }, "MSD will record a thing");
  assert.match(r.content[0].text, /^Dry run — nothing sent\. With confirm: true, MSD will record a thing/);
  const data = JSON.parse(r.content[0].text.split("\n\n").slice(1).join("\n\n"));
  assert.deepEqual(data, { dryRun: true, request: { method: "POST", path: "/rest/x", body: { a: 1 } }, effect: "MSD will record a thing" });
});

test("tolerant turns not-permitted and site errors into an unavailable marker, rethrows the rest", async () => {
  assert.deepEqual(await tolerant(Promise.reject(new NotPermittedError("nope"))), { unavailable: "nope" });
  assert.deepEqual(await tolerant(Promise.reject(new MsdError("server_error", "x", 555))), { unavailable: "server_error: x" });
  await assert.rejects(tolerant(Promise.reject(new NotLoggedInError("gone"))), NotLoggedInError);
  assert.equal(await tolerant(Promise.resolve(5)), 5);
});
