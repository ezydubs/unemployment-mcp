import { test } from "node:test";
import assert from "node:assert/strict";
const t = await import("../dist/tools/des.js");
const { NotLoggedInError } = await import("../dist/http.js");
const { DesError } = await import("../dist/des-http.js");

test("searchBody mirrors the SPA: codes upper-cased, names trimmed, limits enforced", () => {
  assert.deepEqual(t.searchBody({ query: " cleaner " }), { searchTerms: "cleaner", filters: {} });
  assert.deepEqual(t.searchBody({ occupationGroups: ["rsh"], regions: ["Auckland Region"], districts: [" Hamilton City "] }), { filters: { occupationGroups: ["RSH"], locations: { regions: ["Auckland Region"], districts: ["Hamilton City"] } } });
  assert.deepEqual(t.searchBody({ districts: ["Hamilton City"] }), { filters: { locations: { districts: ["Hamilton City"] } } });
  assert.throws(() => t.searchBody({}), /query, occupationGroups, regions or districts/);
  assert.throws(() => t.searchBody({ query: "x".repeat(51) }), /50 characters/);
  assert.throws(() => t.searchBody({ regions: Array.from({ length: 11 }, (_, i) => `r${i}`) }), /at most 10/);
  assert.throws(() => t.searchBody({ occupationGroups: ["XYZ"] }), /unknown occupation group XYZ/);
  assert.equal(Object.keys(t.OCCUPATION_GROUPS).join(","), "BLD,BAO,CRE,EDU,HSC,MFG,RSH,SEA,SEC,TLW");
});

const vacancy = {
  vacancyId: "30071088",
  vacancyTitle: "Cleaner",
  vacancyType: "Permanent",
  fullPartTime: "Part-time",
  workPlaceArrangement: "On-site",
  displayPayOnListing: true,
  minimumPay: 25,
  maximumPay: 30,
  payType: "Hourly rate",
  vacancyStatus: "Open",
  locations: { locationCount: 1, regions: ["Auckland Region"], districts: ["Auckland"], suburbs: ["Mount Eden"] },
  vacancyPosting: { postingURL: "https://new.my.msd.govt.nz/en/jobs/vacancy/30071088", startDate: "2026-09-14", endDate: "2026-12-13" },
};

test("search summary: pay shown / hidden, single and multiple locations, status and closing date, link, limit", () => {
  const lines = t.summarizeSearch({
    totalVacancies: 2,
    suitableVacancies: [vacancy, { ...vacancy, vacancyId: "1", vacancyTitle: "Driver", displayPayOnListing: false, vacancyStatus: "Filled", locations: { locationCount: 3, regions: ["A", "B"], districts: [], suburbs: [] }, vacancyPosting: undefined, company: { name: "Acme" } }],
  });
  assert.equal(lines[0], "2 jobs found");
  assert.equal(lines[1], "  30071088: Cleaner — Permanent, Part-time, On-site; $25.00–$30.00 an hour; Mount Eden; closes Sun 13 Dec 2026 https://new.my.msd.govt.nz/en/jobs/vacancy/30071088");
  assert.equal(lines[2], "  1: Driver at Acme — Permanent, Part-time, On-site; pay not shown; Multiple locations [Filled] https://new.my.msd.govt.nz/en/jobs/vacancy/1");
  assert.deepEqual(t.summarizeSearch({ suitableVacancies: [] }), ["No jobs found"]);
  assert.equal(t.summarizeSearch({ totalVacancies: 2, suitableVacancies: [vacancy, vacancy] }, 1)[0], "2 jobs found (first 1 shown; all are in the data)");
  assert.equal(t.payText({ displayPayOnListing: true, minimumPay: 60000, payType: "Annual salary" }), "$60,000.00 a year");
  assert.equal(t.payText({ displayPayOnListing: true, minimumPay: 30, maximumPay: 30, payType: "Hourly rate" }), "$30.00 an hour");
  assert.equal(t.jobUrl(5), "https://new.my.msd.govt.nz/en/jobs/vacancy/5");
});

test("job detail summary: what the page shows, the description as text, application state and the caution flag", () => {
  const detail = {
    vacancyDetails: {
      ...vacancy,
      workplaceArrangement: "On-site",
      vacancyDescription: "<h1>Cleaner wanted</h1><p>Early starts &amp; weekends.</p><ul><li>Mop</li><li>Vacuum</li></ul>",
      isPublic: true,
      hireDateType: "Set date",
      expectedHireDate: "2026-09-28",
      onTheJobTrainingProvided: "Basic workplace orientation and task instruction",
      preEmploymentChecks: ["Drug test"],
      workSchedule: "Set schedule",
      workDays: ["Monday", "Tuesday"],
      workHours: ["Early start"],
      weeklyHours: 30,
      experienceRequired: "0 - 6 months",
      industry: { code: "MSDINDL02", value: "Business, Admin & Office" },
      occupation: { name: "Commercial Cleaner", occupationCode: "811211", occupationGroup: { name: "Retail, Hospitality & Tourism", occupationGroupCode: "RSH" } },
      locations: [{ suburb: { code: "1987", value: "Tokoroa" }, district: { code: "11900", value: "South Waikato District" }, region: { code: "20003", value: "Waikato Region" } }],
      vacancyPosting: { postingType: "External", postingURL: "x", startDate: "2026-09-14", endDate: "2026-12-13" },
      competencies: { skills: [{ code: "a", value: "handle chemical cleaning agents" }], strengths: [{ value: "Being reliable" }], languageProficiencies: [{ language: { value: "English" }, proficiencies: [{ proficiency: { value: "Able to read" } }] }] },
      credentials: [{ code: "23330", value: "Class 1 - Car Licence", category: "Driver Licence" }],
      sellingPoint1: "Great team",
    },
    applicationForm: { applicationFormId: "a0X1", applicationFormName: "AF-000123", submittedDateTime: "2026-10-01T10:00:00+1300", applicationStage: "Submitted" },
    client: { specialCautionToken: "APB" },
  };
  const lines = t.summarizeJob(detail);
  assert.equal(lines[0], "30071088: Cleaner — Permanent, Part-time, On-site; $25.00–$30.00 an hour; Open");
  assert.equal(lines[1], "Location: Tokoroa, South Waikato District, Waikato Region");
  assert.equal(lines[2], "Occupation: Commercial Cleaner (Retail, Hospitality & Tourism); industry Business, Admin & Office");
  assert.equal(lines[3], "Hours: 30 h/week; Set schedule; Monday, Tuesday; Early start");
  assert.equal(lines[4], "Start: Set date Mon 28 Sep 2026");
  assert.ok(lines.includes("Experience: 0 - 6 months"));
  assert.ok(lines.includes("Training: Basic workplace orientation and task instruction"));
  assert.ok(lines.includes("Pre-employment checks: Drug test"));
  assert.ok(lines.includes("Skills: handle chemical cleaning agents"));
  assert.ok(lines.includes("Strengths: Being reliable"));
  assert.ok(lines.includes("Languages: English (Able to read)"));
  assert.ok(lines.includes("Credentials: Class 1 - Car Licence"));
  assert.ok(lines.includes("Highlights: Great team"));
  assert.ok(lines.includes("Posted Mon 14 Sep 2026, closes Sun 13 Dec 2026 (External) https://new.my.msd.govt.nz/en/jobs/vacancy/30071088"));
  assert.ok(lines.includes("You applied: AF-000123 on Thu 1 Oct 2026 — Submitted"));
  assert.ok(lines.includes("Special-caution flag on your record: APB (the site does not let you apply online)"));
  assert.equal(lines.at(-1), "Cleaner wanted\nEarly starts & weekends.\n• Mop\n• Vacuum");
  assert.equal(t.htmlToText(undefined), "");
  assert.equal(t.summarizeJob({ vacancyDetails: { vacancyId: "9", vacancyTitle: "Bare", displayPayOnListing: false } })[0], "9: Bare — ; pay not shown; status unknown");
});

test("apply checks mirror the site's refusals; a clean open job passes; the request encodes the token", () => {
  const open = { vacancyDetails: { vacancyStatus: "Open", vacancyPosting: { endDate: "2026-12-13" } }, client: {} };
  assert.deepEqual(t.applyChecks(open, "2026-10-12"), []);
  assert.deepEqual(t.applyChecks({ ...open, applicationForm: { applicationFormName: "AF-1", applicationStage: "Submitted" } }, "2026-10-12"), ["you already applied (AF-1, Submitted)"]);
  assert.deepEqual(t.applyChecks({ vacancyDetails: { vacancyStatus: "Filled", vacancyPosting: { endDate: "2026-10-01" } }, client: { specialCautionToken: "XX|APB" } }, "2026-10-12"), [
    "the job is Filled",
    "applications closed Thu 1 Oct 2026",
    "your record carries a special-caution flag (XX|APB); the site does not allow online applications — call 0800 779 009",
  ]);
  assert.equal(t.isBlocked("ZZZ"), false);
  assert.equal(t.isBlocked(undefined), false);
  assert.deepEqual(t.applyRequest("30071088", "own", "No", "c/s"), { method: "POST", path: "/bin/sep/vacancy-apply-submit?csrf=c%2Fs", body: { vacancyId: "30071088", selectedCV: "own", selectedReference: "No" } });
  assert.match(t.nzToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test("applications, matches, profile and locations summaries", () => {
  assert.deepEqual(t.summarizeApplications({ totalApplications: 0, applications: [] }), ["No job applications"]);
  const apps = t.summarizeApplications({
    totalApplications: 1,
    applications: [{ applicationFormId: "a0X1", applicationFormName: "AF-000123", submittedDateTime: "2026-10-01T10:00:00+1300", applicationStage: "Shortlisted", applicationStageReason: null, vacancy: { vacancyId: "30071088", vacancyTitle: "Cleaner", locations: [{ suburb: { value: "Mount Eden" }, district: { value: "Auckland" }, region: { value: "Auckland Region" } }] } }],
  });
  assert.deepEqual(apps, ["1 job application", "  AF-000123: Cleaner (job 30071088) — Shortlisted, applied Thu 1 Oct 2026, Mount Eden"]);
  const m = t.summarizeMatches({ matchingVacancies: [{ ...vacancy, locations: [{ region: { value: "Auckland Region" }, district: { value: "Auckland" }, suburb: { value: "Mount Eden" } }], match: { score: 82, label: "Strong match" } }] });
  assert.equal(m[0], "1 job match");
  assert.ok(m[1].includes("; Mount Eden; closes Sun 13 Dec 2026; strong match (82) "), m[1]);
  assert.equal(t.summarizeMatches({})[0], "No job matches (MSD matches jobs to a complete, active jobseeker profile)");
  const p = t.summarizeProfile(
    { person: { firstName: "Test", lastName: "Person", email: "t@example.com", phone: "0210000000", clientNumber: "000000000", personOtherStreet: "1 Example St", personOtherCity: "Auckland", personOtherPostalCode: "1010" }, preference: { employmentCommunicationPreference: "Email" }, jobseeker: { jobseekerId: "j1", status: "Active", profileCompleteness: "Complete" } },
    {
      personal: { summary: "Keen worker" },
      workSkills: [{ skill: { value: "Cleaning" } }],
      strengths: [{ skill: { value: "Being reliable" } }],
      workExperiences: [{ jobTitle: "Cleaner", employer: "Acme", startofworkYear: "2020", stillWorking: "Yes" }],
      educations: [{ courseName: { value: "NCEA Level 2" }, placeOfLearning: "Example High" }],
      languageProficiencies: [{ language: { value: "English" } }],
      hasAnyNzdriversLicence: "Yes",
      driverlicence: { licencesClass: [{ credential: { value: "Class 1" } }], endorsements: [] },
      reliableTransportAvailable: "yes",
      jobsInterested: [{ job: { value: "Cleaner" } }],
      locationsInterested: [{ location: { value: "Auckland" } }],
      workAvailability: { hoursOfWork: "Full-time", daysAvailable: "Any day" },
    },
  );
  assert.deepEqual(p, [
    "Test Person (client 000000000) — t@example.com, 0210000000",
    "Address: 1 Example St, Auckland, 1010",
    "Jobseeker: Active, profile Complete; job notifications by Email",
    "Summary: Keen worker",
    "Work skills: Cleaning",
    "Strengths: Being reliable",
    "Work experience: Cleaner at Acme (2020–now)",
    "Education: NCEA Level 2 (Example High)",
    "Languages: English",
    "Driver licence: Yes (Class 1); reliable transport: yes",
    "Jobs wanted: Cleaner",
    "Locations wanted: Auckland",
    "Availability: Full-time; Any day",
    "Edit the profile on the site: https://new.my.msd.govt.nz/en/forms/jsp (MSD's profile wizard)",
  ]);
  assert.deepEqual(t.summarizeProfile({ unavailable: "401: nope" }, { unavailable: "500: down" }), ["Client profile: 401: nope", "Jobseeker profile: 500: down"]);
  assert.deepEqual(t.flattenLocations([{ code: "north-island", description: "North Island", children: [{ code: "20002", description: "Auckland Region", children: [{ code: "17612", description: "Auckland Central", children: [{ code: "2728", description: "Auckland Central" }] }] }] }]), [
    "North Island — island (north-island)",
    "  Auckland Region — region (20002)",
    "    Auckland Central — district (17612)",
    "      Auckland Central — suburb (2728)",
  ]);
});

test("desFail names the DES sign-in for a missing session and the site's message for a DesError", () => {
  assert.match(t.desFail(new NotLoggedInError("DES session has ended")).content[0].text, /des_auth login/);
  assert.equal(t.desFail(new NotLoggedInError("x. Sign in to DES: des_auth login")).content[0].text, "Error: x. Sign in to DES: des_auth login");
  assert.equal(t.desFail(new DesError("400", "Job search results could not be fetched", 400)).content[0].text, "Error: 400: Job search results could not be fetched");
  assert.equal(t.desFail(new Error("boom")).content[0].text, "Error: boom");
  assert.equal(t.desFail(new Error("boom")).isError, true);
});
