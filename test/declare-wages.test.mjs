import { test } from "node:test";
import assert from "node:assert/strict";
const { buildDeclaration, describeDeclaration, hourlyWage } = await import("../dist/tools/income.js");

test("hourly and weekly wages become the SPA's wage objects; times in minutes", () => {
  const p = buildDeclaration({
    weekStarting: "2026-10-05",
    wages: [
      { employer: "Example Cafe Ltd", type: "hourly", hours: 12.5, hourlyRate: 24 },
      { employer: "Example Farm", type: "weekly", weeklyTotal: 300, weeklyHours: 10 },
    ],
    childcareCosts: 20,
  });
  assert.deepEqual(p, {
    date: "2026-10-05",
    isEdit: false,
    childcareCosts: 20,
    isAcceptedUnderMinWage: false,
    wages: [
      { employer: "Example Cafe Ltd", totalTime: 750, totalIncome: 300, type: "hourly", isDaily: false, hourlyRate: 24, weeklyTotal: 0, weeklyTime: 0 },
      { employer: "Example Farm", totalTime: 600, totalIncome: 300, type: "weekly", isDaily: false, hourlyRate: 0, weeklyTotal: 300, weeklyTime: 600 },
    ],
  });
  assert.equal(hourlyWage(p.wages[0]), 24);
  assert.equal(hourlyWage(p.wages[1]), 30);
  assert.equal(
    describeDeclaration(p),
    "MSD will record a wage declaration for the week starting Mon 5 Oct 2026: Example Cafe Ltd $300.00 for 12.5 h, Example Farm $300.00 for 10.0 h (total $600.00, childcare $20.00)",
  );
});

test("did not work is one empty wage", () => {
  const p = buildDeclaration({ weekStarting: "2026-10-05", didNotWork: true });
  assert.deepEqual(p.wages, [{ employer: "", totalTime: 0, totalIncome: 0, type: "empty", isDaily: false, hourlyRate: 0, weeklyTotal: 0, weeklyTime: 0 }]);
  assert.equal(describeDeclaration(p), "MSD will record that you did not work in the week starting Mon 5 Oct 2026");
});

test("validation refuses before anything is sent", () => {
  const w = { employer: "X", type: "hourly", hours: 1, hourlyRate: 25 };
  assert.throws(() => buildDeclaration({ weekStarting: "2026-10-06", wages: [w] }), /Monday.*Tuesday/);
  assert.throws(() => buildDeclaration({ weekStarting: "2026-02-30", didNotWork: true }), /date/, "a date that only exists after JavaScript rolls it over is refused");
  assert.throws(() => buildDeclaration({ weekStarting: "2026-10-05", wages: Array(11).fill(w) }), /10 wages/);
  assert.throws(() => buildDeclaration({ weekStarting: "2026-10-05", wages: [{ employer: "X", type: "weekly", weeklyTotal: 6000, weeklyHours: 40 }] }), /\$5,000/);
  assert.throws(() => buildDeclaration({ weekStarting: "2026-10-05", wages: [{ employer: "X", type: "hourly", hours: 130, hourlyRate: 1 }] }), /120 hours/);
  assert.throws(() => buildDeclaration({ weekStarting: "2026-10-05", wages: [{ employer: "X", type: "hourly", hours: 10, hourlyRate: 10 }] }), /acceptBelowMinimumWage/);
  assert.throws(() => buildDeclaration({ weekStarting: "2026-10-05", didNotWork: true, wages: [w] }), /didNotWork/);
  assert.throws(() => buildDeclaration({ weekStarting: "2026-10-05", wages: [] }), /wages/);
  assert.throws(() => buildDeclaration({ weekStarting: "2026-10-05", wages: [{ employer: " ", type: "hourly", hours: 1, hourlyRate: 25 }] }), /employer/);
  assert.equal(buildDeclaration({ weekStarting: "2026-10-05", wages: [{ employer: "X", type: "hourly", hours: 10, hourlyRate: 10 }], acceptBelowMinimumWage: true }).isAcceptedUnderMinWage, true);
});
