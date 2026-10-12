import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
const { summarizeBenefits } = await import("../dist/tools/benefits.js");
const { summarizeLetters, defaultLetterPath } = await import("../dist/tools/letters.js");

const all = {
  benefits: [
    {
      status: "Current", type: "Main benefit", name: "Jobseeker Support", productId: 31, bankPaymentAmount: 318, nextPaymentDate: "2026-10-13", cardPaymentAmount: null, nextPaymentTotal: 318,
      details: { benefitDetails: { paymentFrequency: 7, ongoingPaymentDate: null, lineItems: [{ name: "Jobseeker Support", amount: 400 }] }, debtRepayments: { lineItems: [{ name: "Overpayment", amount: -82 }] }, total: 318 },
    },
  ],
};

test("benefits summary with and without line items", () => {
  assert.deepEqual(summarizeBenefits(all, false), ["Jobseeker Support (Current): next payment $318.00 on Tue 13 Oct 2026 — $318.00 to bank"]);
  const lines = summarizeBenefits(all, true);
  assert.equal(lines[0], "Jobseeker Support (Current): next payment $318.00 on Tue 13 Oct 2026 — $318.00 to bank");
  assert.ok(lines.includes("  Jobseeker Support $400.00"));
  assert.ok(lines.includes("  Overpayment -$82.00 (debt repayment)"));
  assert.ok(lines.includes("  paid every 7 days; total $318.00"));
  assert.deepEqual(summarizeBenefits({ benefits: [] }, false), ["No benefits recorded"]);
});

test("letters summary counts unread and lists the newest first", () => {
  const letters = { letters: [{ id: 2, date: "2026-10-01", type: "Payment advice", size: 1024, hasRead: false }, { id: 1, date: "2026-09-01", type: "Obligations letter", size: 2048, hasRead: true }], hasMore: false };
  const lines = summarizeLetters(letters, { newLetters: 1 });
  assert.equal(lines[0], "2 letters, 1 unread (MyMSD counts 1 new)");
  assert.equal(lines[1], "  #2 Thu 1 Oct 2026 Payment advice (1 KB) — unread");
  assert.equal(lines[2], "  #1 Tue 1 Sep 2026 Obligations letter (2 KB)");
  assert.deepEqual(summarizeLetters({ lettersThrottleReached: true }, { newLetters: 0 }), ["MyMSD is throttling letter downloads right now; try again later"]);
  assert.equal(defaultLetterPath(42), `${homedir()}/Downloads/MyMSD-letter-42.pdf`);
});
