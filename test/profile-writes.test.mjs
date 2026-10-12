import { test } from "node:test";
import assert from "node:assert/strict";
const { contactDelta, accommodationPayload, postalPreferencePayload, normalizePhone } = await import("../dist/tools/profile.js");

const current = { homePhone: null, workPhone: null, cellPhone: { countryCode: "64", areaCode: "021", number: "0000000" }, fax: null, homeEmail: "old@example.com", workEmail: null, preferred: "cellPhone", preferredEmail: "homeEmail" };

test("contactDelta sends only what changed, phones as objects, removals as empty phones", () => {
  assert.deepEqual(contactDelta(current, { homeEmail: "new@example.com" }), { homeEmail: "new@example.com" });
  assert.deepEqual(contactDelta(current, { cellPhone: { areaCode: "021", number: "0000000" } }), {});
  assert.deepEqual(contactDelta(current, { homePhone: { areaCode: "09", number: "1234567" }, preferred: "homePhone" }), { preferred: "homePhone", homePhone: { countryCode: "64", areaCode: "09", number: "1234567" } });
  assert.deepEqual(contactDelta(current, { cellPhone: null }), { cellPhone: { countryCode: "", areaCode: "", number: "" } });
  assert.deepEqual(normalizePhone("+64 21 000 0000"), { countryCode: "64", areaCode: "021", number: "0000000" });
  assert.deepEqual(normalizePhone("09 123 4567"), { countryCode: "64", areaCode: "09", number: "1234567" });
});

test("accommodationPayload mirrors updater._serializeAccomodationChanges", () => {
  const p = accommodationPayload({
    residentialAddress: { id: "a1", line1: "2 Example Road", suburb: "Suburb", city: "City", postalCode: "0000", country: "New Zealand" },
    dateOfMove: "2026-10-01",
    livingSituation: { hasOtherPeopleAtAddress: true, numOtherPeopleAtAddress: 2, numPeoplePayingBoard: 1, numPaymentBoard: 150 },
    accommodationCosts: { type: "rent", amount: 400, landlordName: "A Landlord", landlordPhone: "021 000 0000", isHousingNZ: false, hasWaterRates: false },
  });
  assert.deepEqual(p.residentialAddress, { id: "a1", line1: "2 Example Road", line2: "", suburb: "Suburb", city: "City", postalCode: "0000", country: "New Zealand", dateOfMove: "2026-10-01", addressText: null });
  assert.deepEqual(p.livingSituation, { hasOtherPeopleAtAddress: true, numOtherPeopleAtAddress: 2, numPeoplePayingBoard: 1, numPaymentBoard: 150 });
  assert.deepEqual(p.postalAddress, { isSameAsResidential: true });
  assert.deepEqual(p.accommodationCosts, { rent: { amount: 400, landlordName: "A Landlord", landlordPhone: { countryCode: "64", areaCode: "021", number: "0000000" }, isHousingNZ: false, hasWaterRates: false } });
  assert.deepEqual(accommodationPayload({ accommodationCosts: { type: "rent", dateStopped: "2026-10-01" } }).accommodationCosts, { dateStopped: "2026-10-01" });
  assert.throws(() => accommodationPayload({}), /nothing to change/i);
});

test("postal preference payloads", () => {
  assert.deepEqual(postalPreferencePayload("post"), { path: "/rest/client/postal-preferences", body: { sendPostalMail: true } });
  assert.deepEqual(postalPreferencePayload("email"), { path: "/rest/client/postal-preferences", body: { sendPostalMail: false } });
  assert.deepEqual(postalPreferencePayload("confirm_email", { emailAddress: "a@b.c", emailType: "homeEmail" }), { path: "/rest/client/contacts/confirm-email", body: { viewedConfirmEmailPrompt: true, emailAddress: "a@b.c", emailType: "homeEmail" } });
  assert.deepEqual(postalPreferencePayload("confirm_email", { noEmailAddress: true }), { path: "/rest/client/contacts/confirm-email", body: { viewedConfirmEmailPrompt: true, noEmailAddress: true } });
});
