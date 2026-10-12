import { test } from "node:test";
import assert from "node:assert/strict";
const { summarizeDashboard, summarizeProfile } = await import("../dist/tools/dashboard.js");

const client = {
  clientNumber: "000000000", firstName: "Test", lastName: "Person", clientType: "GCMC", trafficLightStatus: "GREEN",
  flags: { hasMainBenefit: true, hasAgent: false, needsToConfirmEmail: true, hasCurrentApplication: false, isMoneyManaged: false },
  features: { declareWages: true, showDebt: true },
  contactDetails: { homePhone: null, workPhone: null, cellPhone: { countryCode: "64", areaCode: "021", number: "0000000" }, homeEmail: "t@example.com", workEmail: null, preferred: "cellPhone", preferredEmail: "homeEmail", preferredEmailAddress: "t@example.com" },
  residentialAddress: { line1: "1 Example Street", line2: "", suburb: "Suburb", city: "City", postalCode: "0000", country: "New Zealand", dateOfMove: null },
  postalAddress: null,
  communityServicesCard: { cardNumber: "1234", validFrom: "2026-01-01", expiry: "2027-01-01", isComboCard: false },
  partner: null, children: [], livingSituation: null,
};

test("dashboard summary: who, next payment, to-do, appointments, letters, flags", () => {
  const lines = summarizeDashboard({
    session: { firstName: "Test", clientNumber: "000000000", lastLogin: "2026-10-12 15:58", serverDateTime: "2026-10-12 16:11:17" },
    client,
    benefits: { benefits: [{ name: "Jobseeker Support", nextPaymentDate: "2026-10-13", nextPaymentTotal: 318, status: "Current" }] },
    notifications: { notifications: [{ id: "n1", title: "Confirm your email", dueBy: null }] },
    appointments: { appointments: [{ id: "a1", date: "2026-10-20 10:00", category: "PHONE", topic: "Check in" }] },
    letters: { newLetters: 2 },
    banners: { banners: [{ title: "Winter Energy Payment ending", level: "1" }] },
    tiles: { tiles: [{ id: "employment-tile", featureFlag: "showEmploymentTile" }] },
    cyc: { cycStatus: { isApplicationComplete: true } },
    engagement: { unavailable: "x" },
  });
  assert.equal(lines[0], "Test (client 000000000) — last login Mon 12 Oct 2026 15:58; status GREEN");
  assert.ok(lines.includes("Next payment: Jobseeker Support $318.00 on Tue 13 Oct 2026 (Current)"));
  assert.ok(lines.includes("To do (1): Confirm your email"));
  assert.ok(lines.includes("Appointments (1): Tue 20 Oct 2026 10:00 PHONE — Check in"));
  assert.ok(lines.includes("New letters: 2"));
  assert.ok(lines.includes("Notices: Winter Energy Payment ending"));
  assert.ok(lines.some((l) => l.startsWith("Flags: hasMainBenefit, needsToConfirmEmail")));
});

test("profile summary lists contact details, addresses and the Community Services Card", () => {
  const lines = summarizeProfile(client);
  assert.equal(lines[0], "Test Person, client 000000000, type GCMC");
  assert.ok(lines.includes("Mobile: +64 021 0000000 (preferred); email: t@example.com (preferred)"));
  assert.ok(lines.includes("Residential: 1 Example Street, Suburb, City 0000; postal: same as residential"));
  assert.ok(lines.includes("Community Services Card 1234 valid Thu 1 Jan 2026 – Fri 1 Jan 2027"));
  assert.ok(lines.includes("Partner: none; children: 0"));
});
