import { test } from "node:test";
import assert from "node:assert/strict";
const { housingRegisterPayload, emergencyHousingPayload } = await import("../dist/tools/housing.js");
const { applicationRequest } = await import("../dist/tools/applications.js");

test("housing payloads", () => {
  assert.deepEqual(housingRegisterPayload({ hasRelationshipChanged: false, hasChildrenChanged: true, hasIncomeChanged: false, hasLivingSituationOrLodgingCostsChanged: false }), {
    hasRelationshipChanged: false,
    hasChildrenChanged: true,
    hasIncomeChanged: false,
    hasLivingSituationOrLodgingCostsChanged: false,
  });
  assert.deepEqual(emergencyHousingPayload({ contactNumber: "021 000 0000", dateOfNeed: "2026-10-15", numberOfDependents: 2, region: "Auckland", town: "Manukau" }), {
    contactNumber: { countryCode: "64", areaCode: "021", number: "0000000" },
    dateOfNeed: "2026-10-15",
    numberOfDependents: "2",
    region: "Auckland",
    town: "Manukau",
  });
});

test("application actions map to the site's endpoints", () => {
  assert.deepEqual(applicationRequest("accept_obligations", { referenceNumber: "R1", payload: { accepted: true } }), { method: "POST", path: "/rest/applications/acceptObligations", body: { referenceNumber: "R1", accepted: true } });
  assert.deepEqual(applicationRequest("identity_verification_start", { referenceNumber: "R1", context: "passport" }), { method: "GET", path: "/rest/applications/identityVerificationRequest", params: { context: "passport" } });
  assert.deepEqual(applicationRequest("complete_identity", { referenceNumber: "R1", caseReference: "C1", uploadAction: "CANNOTPROVIDE", verificationType: "NO_IDENTITY" }), {
    method: "POST",
    path: "/rest/applicationStep/completeIdentity",
    body: { document: { applicationReferenceNum: "R1", caseReference: "C1", uploadAction: "CANNOTPROVIDE", applicationIdentity: { isVerified: false, verificationType: "NO_IDENTITY" } } },
  });
  assert.deepEqual(applicationRequest("complete_supporting", { referenceNumber: "R1", caseReference: "C1", uploadAction: "UNABLETOUPLOAD" }), {
    method: "POST",
    path: "/rest/applicationStep/completeSupporting",
    body: { document: { applicationReferenceNum: "R1", caseReference: "C1", uploadAction: "UNABLETOUPLOAD" } },
  });
  assert.deepEqual(applicationRequest("agree_supporting", { referenceNumber: "R1", caseReference: "C1", payload: { files: { "0021": ["f1"] } } }), {
    method: "POST",
    path: "/rest/applicationStep/agreeSupporting",
    body: { applicationReferenceNum: "R1", caseReference: "C1", isOnThePhoneWithMSD: false, files: { "0021": ["f1"] } },
  });
  assert.throws(() => applicationRequest("nope", {}), /action/);
});
