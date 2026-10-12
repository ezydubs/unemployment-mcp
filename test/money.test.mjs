import { test } from "node:test";
import assert from "node:assert/strict";
const { summarizeDebt, summarizeFinance, summarizeCards, findCard } = await import("../dist/tools/money.js");

test("debt summary: total, each debt, repayment history", () => {
  const lines = summarizeDebt(
    { total: 500, debt: [{ isPreviousDebt: false, type: "Overpayment", description: null, dateEstablished: "2025-03-01", originalAmount: 900, repaidAmount: 400, owingAmount: 500 }] },
    { totalRepayments: 400, historyFromDate: "2025-10-01", historyToDate: "2026-10-01", repayments: [{ description: "Benefit deduction", date: "2026-09-29", amount: 10 }] },
  );
  assert.equal(lines[0], "Total owing $500.00");
  assert.equal(lines[1], "  Overpayment from Sat 1 Mar 2025: $900.00 originally, $400.00 repaid, $500.00 owing");
  assert.equal(lines[2], "Repayments Wed 1 Oct 2025 – Thu 1 Oct 2026: $400.00 in 1 repayment; latest Tue 29 Sep 2026 $10.00 Benefit deduction");
});

test("finance summary reads the preformatted sections", () => {
  const lines = summarizeFinance({
    fromDate: "2026-10-05",
    weeklyPayments: { lineItems: [{ type: "Jobseeker Support", value: "$318.00" }], meta: { total: "$318.00", additionalNotes: ["Paid weekly"] } },
    debtsWithUs: { lineItems: [{ type: "Overpayment", originalAmount: "$900.00", balanceOwing: "$500.00", repaymentRate: "$10.00" }] },
    wages: { lineItems: [] },
  });
  assert.equal(lines[0], "Financial information from Mon 5 Oct 2026");
  assert.ok(lines.includes("Weekly payments: Jobseeker Support $318.00; total $318.00 (Paid weekly)"));
  assert.ok(lines.includes("Debts with MSD: Overpayment owing $500.00 of $900.00, repaying $10.00"));
});

test("cards summary and lookup", () => {
  const data = {
    hasCards: true,
    cards: [{ cardNo: "12345678", pan: "1234567890123456", status: "ACTIVE", isBlocked: false, balance: 42.5, valueDate: "2026-10-12", expiryDate: "2028-01-31", isPinSet: true, hasNewPayment: false, transactions: [{ description: "Countdown", amount: -20, date: "2026-10-10" }] }],
  };
  const lines = summarizeCards(data, true);
  assert.equal(lines[0], "Card 12345678 (ACTIVE): balance $42.50 at Mon 12 Oct 2026, expires Mon 31 Jan 2028, PIN set");
  assert.equal(lines[1], "  Sat 10 Oct 2026 -$20.00 Countdown");
  assert.deepEqual(summarizeCards({ hasCards: false, cards: [] }, false), ["No payment cards"]);
  assert.equal(findCard(data, "12345678").pan, "1234567890123456");
  assert.equal(findCard(data, "0"), null);
});
