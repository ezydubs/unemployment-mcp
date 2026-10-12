import { test } from "node:test";
import assert from "node:assert/strict";
const { contactDelta, accommodationPayload, postalPreferencePayload, normalizePhone } = await import("../dist/tools/profile.js");

const current = { homePhone: null, workPhone: null, cellPhone: { countryCode: "64", areaCode: "021", number: "0000000" }, fax: null, homeEmail: "old@example.com", workEmail: null, preferred: "cellPhone", preferredEmail: "homeEmail" };
const address = { id: "a1", line1: "2 Example Road", suburb: "Suburb", city: "City", postalCode: "0000", country: "New Zealand" };
const living = { hasOtherPeopleAtAddress: true, numOtherPeopleAtAddress: 2, numPeoplePayingBoard: 1, numPaymentBoard: 150 };

test("contactDelta sends only what changed, phones as objects, removals as empty phones", () => {
  assert.deepEqual(contactDelta(current, { homeEmail: "new@example.com" }), { homeEmail: "new@example.com" });
  assert.deepEqual(contactDelta(current, { cellPhone: { areaCode: "021", number: "0000000" } }), {});
  assert.deepEqual(contactDelta(current, { homePhone: { areaCode: "09", number: "1234567" }, preferred: "homePhone" }), { preferred: "homePhone", homePhone: { countryCode: "64", areaCode: "09", number: "1234567" } });
  assert.deepEqual(contactDelta(current, { cellPhone: null }), { cellPhone: { countryCode: "", areaCode: "", number: "" } });
});

test("normalizePhone accepts NZ numbers only and refuses what it cannot classify", () => {
  assert.deepEqual(normalizePhone("+64 21 000 0000"), { countryCode: "64", areaCode: "021", number: "0000000" });
  assert.deepEqual(normalizePhone("09 123 4567"), { countryCode: "64", areaCode: "09", number: "1234567" });
  assert.deepEqual(normalizePhone("0064 3 123 4567"), { countryCode: "64", areaCode: "03", number: "1234567" });
  assert.deepEqual(normalizePhone({ areaCode: "021", number: "0000000" }), { countryCode: "64", areaCode: "021", number: "0000000" });
  assert.equal(normalizePhone(null), null);
  assert.throws(() => normalizePhone("+61 4 1234 5678"), /NZ/);
  assert.throws(() => normalizePhone("abc"), /phone/);
  assert.throws(() => normalizePhone("021 00"), /digits/);
});

test("accommodationPayload mirrors updater._serializeAccomodationChanges and the accommodation-cost delta serializer", () => {
  const p = accommodationPayload({
    residentialAddress: address,
    dateOfMove: "2026-10-01",
    livingSituation: living,
    accommodationCosts: { type: "rent", dateChanged: "2026-10-01", landlordName: "A Landlord", landlordPhone: "021 000 0000", isHousingNZ: false, costs: [{ type: "rent", amount: 400, frequency: "weekly", actualPaying: 200 }] },
  });
  assert.deepEqual(p.residentialAddress, { id: "a1", line1: "2 Example Road", line2: "", suburb: "Suburb", city: "City", postalCode: "0000", country: "New Zealand", dateOfMove: "2026-10-01", addressText: null });
  assert.deepEqual(p.livingSituation, { hasOtherPeopleAtAddress: true, numOtherPeopleAtAddress: 2, numPeoplePayingBoard: 1, numPaymentBoard: 150 });
  assert.deepEqual(p.postalAddress, { isSameAsResidential: true });
  assert.deepEqual(p.accommodationCosts, {
    rent: { landlordName: "A Landlord", landlordPhone: { countryCode: "64", areaCode: "021", number: "0000000" }, isHousingNZ: false, dateChanged: "2026-10-01", costs: [{ type: "rent", amount: 400, frequency: "weekly", actualPaying: 200 }] },
  });
  assert.deepEqual(accommodationPayload({ accommodationCosts: { type: "rent", dateStopped: "2026-10-01" } }).accommodationCosts, { dateStopped: "2026-10-01" });
  const own = accommodationPayload({ accommodationCosts: { type: "ownHouse", dateChanged: "2026-10-01", costs: [{ type: "rates", amount: 100, frequency: "quarterly", payee: "Example Council", isNew: true, extra: 1 }] } });
  assert.deepEqual(own.accommodationCosts, { ownHouse: { dateChanged: "2026-10-01", costs: [{ type: "rates", amount: 100, frequency: "quarterly", payee: "Example Council", isNew: true }] } });
  assert.throws(() => accommodationPayload({ residentialAddress: address, dateOfMove: "2026-10-01" }), /livingSituation/, "an address change must say who lives there");
  assert.throws(() => accommodationPayload({ accommodationCosts: { type: "rent", costs: [] } }), /costs/);
  assert.throws(() => accommodationPayload({ accommodationCosts: { type: "rent", costs: [{ type: "rent", amount: 10, frequency: "daily" }] } }), /frequency/);
  assert.throws(() => accommodationPayload({ accommodationCosts: { type: "rent", costs: [{ type: "mortgage", amount: 10, frequency: "weekly" }] } }), /type/);
  assert.throws(() => accommodationPayload({ residentialAddress: address, livingSituation: living, dateOfMove: "2026-02-30" }), /date/);
  assert.throws(() => accommodationPayload({}), /nothing to change/i);
});

test("postal preference payloads", () => {
  assert.deepEqual(postalPreferencePayload("post"), { path: "/rest/client/postal-preferences", body: { sendPostalMail: true } });
  assert.deepEqual(postalPreferencePayload("email"), { path: "/rest/client/postal-preferences", body: { sendPostalMail: false } });
  assert.deepEqual(postalPreferencePayload("confirm_email", { emailAddress: "a@b.c", emailType: "homeEmail" }), { path: "/rest/client/contacts/confirm-email", body: { viewedConfirmEmailPrompt: true, emailAddress: "a@b.c", emailType: "homeEmail" } });
  assert.deepEqual(postalPreferencePayload("confirm_email", { noEmailAddress: true }), { path: "/rest/client/contacts/confirm-email", body: { viewedConfirmEmailPrompt: true, noEmailAddress: true } });
});
