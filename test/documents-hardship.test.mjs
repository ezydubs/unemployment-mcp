import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { validateFiles, FILE_RULES, EVIDENCE_TYPES } = await import("../dist/tools/documents.js");
const { serializeHardship, TEXT } = await import("../dist/tools/hardship.js");

test("validateFiles enforces the site's upload rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "mymsd-files-"));
  const pdf = join(dir, "a.pdf");
  writeFileSync(pdf, "%PDF-1.4 trailer << /Root 1 0 R >>");
  const enc = join(dir, "enc.pdf");
  writeFileSync(enc, "%PDF-1.4 trailer << /Encrypt 5 0 R /Root 1 0 R >>");
  const big = join(dir, "big.docx");
  writeFileSync(big, Buffer.alloc(FILE_RULES.maxWordExcelBytes + 1));
  const rtf = join(dir, "x.rtf");
  writeFileSync(rtf, "rtf");
  assert.deepEqual(validateFiles([pdf]), [{ path: pdf, type: "application/pdf", bytes: 34 }]);
  assert.throws(() => validateFiles([enc]), /encrypted/);
  assert.throws(() => validateFiles([big]), /512 KB/);
  assert.throws(() => validateFiles([rtf]), /type/);
  assert.throws(() => validateFiles(Array(11).fill(pdf)), /10 files/);
  assert.throws(() => validateFiles([join(dir, "missing.pdf")]), /missing\.pdf/);
  assert.deepEqual([...EVIDENCE_TYPES], ["photoId", "otherId", "costs"]);
});

test("serializeHardship mirrors resources/serializers/hardship", () => {
  const out = serializeHardship(
    {
      types: ["food", "dental"],
      food: { whatHasHappened: "urgentBill", whyHadToPay: "power bill", howMuchPaid: 120, howMuchNeed: 80 },
      dental: { whoFor: "me", typeOfTreatment: "immediateAndEssential", isPaidForByOther: false, howMuchNeed: 300 },
      answers: { chosenCard: "12345678", hasIncome: true, hasIncomeChanged: false, hasAssets: false, haveAssetsChanged: false, whyNotAssets: "bills", stepsTaken: ["budgetingPlanning", "other"], stepsTakenOther: "Sold the car", stepToTake: "reduceCosts", hasTakenPreviousStep: false, agreeToRepayments: true },
    },
    { count: 1, isStpCandidate: false, lastApplication: { stepToTake: "other" }, food: { eligibility: "eligible", maxAmount: 300, balance: 300, sixMonthFoodAllowance: 600, sngAmount: 0 }, dental: { eligibility: "eligible", maxAmount: 1000, sngAmount: 0 } },
    { dental: ["f1"] },
  );
  assert.equal(out.count, 1);
  assert.equal(out.stpCandidate, false);
  assert.equal(out.isPrevStepOther, true);
  assert.equal(out.hasAssets, true, "haveAssetsChanged false forces hasAssets true");
  assert.equal(out.whyNotAssets, TEXT.whyNotAssets.bills);
  assert.deepEqual(out.stepsTaken, [TEXT.stepsTaken.budgetingPlanning, "Sold the car"]);
  assert.equal(out.stepsTakenNone, false);
  assert.equal(out.isStepToTakeOther, false);
  assert.equal(out.isWhyNotAssetsOther, false);
  assert.equal(out.stepToTake, "reduceCosts");
  assert.equal("stepsTakenOther" in out, false);
  assert.equal("food" in out, false);
  assert.deepEqual(out.types.map((t) => t.type), ["food", "dental"]);
  assert.equal(out.types[0].whatHasHappened, "urgentBill");
  assert.equal(out.types[0].maxAmount, 300);
  assert.equal(out.types[1].typeOfTreatment, "immediateAndEssential");
  assert.deepEqual(out.evidence, { dental: ["f1"] });
  const none = serializeHardship(
    { types: ["schoolUniforms"], schoolUniforms: { whoFor: "otherChild", howMuchNeed: 50 }, answers: { chosenCard: "1", hasIncome: false, hasAssets: false, haveAssetsChanged: null, whyNotAssets: "other", stepsTaken: ["none", "other"], stepsTakenOther: "x", stepToTake: "other", agreeToRepayments: true } },
    { count: 0, schoolUniforms: { eligibility: "eligible" } },
    {},
  );
  assert.deepEqual(none.stepsTaken, [TEXT.stepsTaken.none, "x"]);
  assert.equal(none.stepsTakenNone, true);
  assert.equal(none.isStepToTakeOther, true);
  assert.equal(none.isWhyNotAssetsOther, true);
  assert.equal(none.types[0].type, "schoolUniforms");
});
