import { test } from "node:test";
import assert from "node:assert/strict";
const { nzd, day, result } = await import("../dist/format.js");

test("nzd formats numbers as NZ dollars and passes preformatted strings through", () => {
  assert.equal(nzd(318), "$318.00");
  assert.equal(nzd(1234.5), "$1,234.50");
  assert.equal(nzd(-12), "-$12.00");
  assert.equal(nzd("$1,070.00"), "$1,070.00");
  assert.equal(nzd(null), "");
  assert.equal(nzd(undefined), "");
});

test("day renders ISO dates with the weekday and keeps a time when present", () => {
  assert.equal(day("2026-10-13"), "Tue 13 Oct 2026");
  assert.equal(day("2026-10-12 15:58"), "Mon 12 Oct 2026 15:58");
  assert.equal(day("Tuesday, 13 October"), "Tuesday, 13 October");
  assert.equal(day(null), "");
});

test("result is summary lines, a blank line, then pretty JSON", () => {
  const r = result(["a", "", "b"], { x: 1 });
  assert.equal(r.content[0].type, "text");
  assert.equal(r.content[0].text, 'a\nb\n\n{\n  "x": 1\n}');
  assert.equal(result("one", null).content[0].text, "one\n\nnull");
});
