import { test } from "node:test";
import assert from "node:assert/strict";
const { bookPayload, bookingBlocked } = await import("../dist/tools/appointments.js");

test("book payload mirrors appointment/book", () => {
  assert.deepEqual(bookPayload({ reasonIds: ["changeAddress"], category: "PHONE", date: "2026-10-21 09:00", locationId: "ASMR", notes: "please call after 9" }), {
    category: "PHONE",
    clientRequirementTypes: [],
    date: "2026-10-21 09:00",
    locationId: "ASMR",
    notes: "please call after 9",
    reasonIds: ["changeAddress"],
  });
  assert.equal(bookPayload({ reasonIds: ["cyc"], category: "FACETOFACE", date: "d", locationId: "L", appointmentId: "a1" }).appointmentId, "a1");
  assert.equal(bookPayload({ reasonIds: ["cyc"], category: "FACETOFACE", date: "d", locationId: "L" }).notes, "");
});

test("bookingBlocked reads the check result", () => {
  assert.match(bookingBlocked({ mustCall: true }, false), /phone MSD/);
  assert.match(bookingBlocked({ limitReached: true, existing: null }, false), /limit/);
  assert.equal(bookingBlocked({ limitReached: true, existing: { id: "x" } }, true), null);
  assert.equal(bookingBlocked({ mustCall: false, limitReached: false }, false), null);
});
