import { test } from "node:test";
import assert from "node:assert/strict";
const { browserAvailable, harvestCookies, toPlaywrightCookie, fromPlaywrightCookie } = await import("../dist/browser.js");

test("without cloakbrowser installed the browser is reported unavailable and harvesting fails clearly", async () => {
  assert.equal(await browserAvailable(), false);
  await assert.rejects(harvestCookies({ jar: { toJSON: () => [] }, headless: true, waitForAuth: false, timeoutMs: 10 }), /cloakbrowser/);
});

test("cookie conversion to and from Playwright's shape", () => {
  const c = { name: "a", value: "1", domain: ".msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: false };
  assert.deepEqual(toPlaywrightCookie(c), { ...c, sameSite: "Lax" });
  assert.deepEqual(fromPlaywrightCookie({ ...c, sameSite: "None", expires: 1700000000.5 }), { ...c, expires: 1700000000 });
});
