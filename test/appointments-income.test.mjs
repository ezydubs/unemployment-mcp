import { test } from "node:test";
import assert from "node:assert/strict";
const { summarizeAppointments, summarizeAvailability, plus30Days, REASON_IDS } = await import("../dist/tools/appointments.js");
const { summarizeIncome } = await import("../dist/tools/income.js");

test("appointments summary", () => {
  const lines = summarizeAppointments(
    { appointments: [{ id: "a1", date: "2026-10-20 10:00", endDate: "2026-10-20 10:30", category: "FACETOFACE", topic: "Reapplication", personMeeting: "Case manager", isCancellable: true, isReschedulable: true, location: { name: "Auckland Central" }, status: "unknown" }] },
    { locations: [{ id: "ASMR", name: "Auckland Central" }] },
  );
  assert.equal(lines[0], "1 appointment");
  assert.equal(lines[1], "  a1: Tue 20 Oct 2026 10:00–10:30 FACETOFACE Reapplication with Case manager at Auckland Central (cancellable, reschedulable)");
  assert.equal(lines[2], "Locations: ASMR Auckland Central");
  assert.deepEqual(summarizeAppointments({ appointments: [] }), ["No appointments booked"]);
});

test("availability summary and helpers", () => {
  const lines = summarizeAvailability(
    { mustCall: false, limitReached: false, isPhoneAvailable: true, isInPersonAvailable: true, isSeminarAvailable: false, existing: null },
    { categorisedAppointments: [{ category: "PHONE", availability: [{ date: "2026-10-21 09:00" }, { date: "2026-10-21 09:30" }] }], location: { id: "ASMR", name: "Auckland Central" } },
  );
  assert.equal(lines[0], "Booking allowed; phone and in-person appointments available");
  assert.equal(lines[1], "PHONE: 2 slots from Wed 21 Oct 2026 09:00 to Wed 21 Oct 2026 09:30 at Auckland Central");
  assert.equal(summarizeAvailability({ mustCall: true }, {})[0], "MyMSD says to phone MSD to book this appointment (mustCall)");
  assert.match(plus30Days("2026-10-12"), /^2026-11-11$/);
  assert.ok(REASON_IDS.includes("changeAddress"));
});

test("income summary", () => {
  const lines = summarizeIncome(
    { fromDate: "2026-10-05", total: 0, lastDeclarationAmount: 120.5, frequency: "weekly", displaySummary: true, incomeDetails: [], declareWagesStartDate: "2026-10-05" },
    { employers: [{ name: "Example Cafe Ltd" }] },
  );
  assert.equal(lines[0], "Income declared from Mon 5 Oct 2026: $0.00 (weekly); last declaration $120.50");
  assert.equal(lines[1], "Next week to declare starts Mon 5 Oct 2026; known employers: Example Cafe Ltd");
});
