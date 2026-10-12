import { test } from "node:test";
import assert from "node:assert/strict";
const { summarizeOneOffCosts, HARDSHIP_TYPES } = await import("../dist/tools/hardship.js");
const { summarizeMedical } = await import("../dist/tools/medical.js");
const { summarizeHousing } = await import("../dist/tools/housing.js");
const { summarizeApplications } = await import("../dist/tools/applications.js");
const { summarizeTas } = await import("../dist/tools/tas.js");

test("one-off costs: catalogue grouped by category and hardship eligibility", () => {
  const lines = summarizeOneOffCosts(
    { oneOffCosts: [{ category: "Food", title: "Food", isMore: false, outcome: { id: "food", type: "hardship", hardshipType: "food" } }, { category: "Health", title: "Dental treatment", outcome: { id: "dental", type: "hardship" } }] },
    { count: 1, isStpCandidate: false, totalAssets: 0, food: { eligibility: "eligible", maxAmount: 300, balance: 300, onlineThreshold: 300 }, dental: null },
  );
  assert.equal(lines[0], "2 catalogue entries loaded: Food (1), Health (1)");
  assert.ok(lines.includes("  Food: Food [outcome food, hardship]"));
  assert.ok(lines.includes("Hardship eligibility — food: eligible, up to $300.00 (balance $300.00); applications so far: 1"));
  assert.deepEqual([...HARDSHIP_TYPES], ["food", "dental", "schoolUniforms", "schoolStationery"]);
});

test("medical certificate, housing, applications and TAS summaries", () => {
  assert.deepEqual(summarizeMedical({ showMedicalCertificate: true, expiryDate: "2026-12-01", mustContactUs: false, isReadyToWork: false, isRenewable: true, showExpiringBanner: false }), [
    "Medical certificate expires Tue 1 Dec 2026; renewable; not declared ready to work",
  ]);
  assert.deepEqual(summarizeMedical({ showMedicalCertificate: false }), ["No medical certificate on file"]);
  assert.deepEqual(summarizeHousing({ alreadyCheckedIn: false }, { unavailable: "x" }), ["Housing Register: not checked in yet", "Emergency housing request: x"]);
  assert.deepEqual(summarizeApplications({ isActiveClient: true, hasCurrentApplication: false, workingAgeApplication: null, superApplication: null }, { isAllowed: false }, { canUpload: true }), [
    "No application in progress",
    "Online identity verification allowed: false; document upload available: true",
  ]);
  const lines = summarizeApplications({ workingAgeApplication: { referenceNumber: "REF1", date: "2026-10-01", isProcessing: true, type: "workingAge", categories: [] } }, { isAllowed: true }, { canUpload: false });
  assert.equal(lines[0], "Working-age application REF1 from Thu 1 Oct 2026: processing");
  assert.deepEqual(summarizeTas({ reasonableSteps: [{ id: "s1", title: "Budget advice" }] }, { unavailable: "forbidden" }, { accommodationPayments: [] }), [
    "Temporary Additional Support data: forbidden",
    "Reasonable steps MSD lists (1): s1 Budget advice",
    "Accommodation payments on file: 0",
  ]);
});
