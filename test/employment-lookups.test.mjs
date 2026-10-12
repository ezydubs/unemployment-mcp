import { test } from "node:test";
import assert from "node:assert/strict";
const { summarizeEmploymentPlan, summarizeJobs, jobLink } = await import("../dist/tools/employment.js");
const { summarizeAddresses } = await import("../dist/tools/lookups.js");

test("employment plan summary tolerates unavailable parts", () => {
  const lines = summarizeEmploymentPlan(
    { activities: [{ id: "x1", dueBy: "2026-11-01", description: "Attend a job seminar" }], hasRecordJobSearch: false, jobSearchActivities: [] },
    { unavailable: "not available on this account" },
    { upskillingActivities: [] },
  );
  assert.equal(lines[0], "Employment plan: 1 activity");
  assert.equal(lines[1], "  x1: Attend a job seminar by Sun 1 Nov 2026");
  assert.equal(lines[2], "Job-search log: not required (hasRecordJobSearch false); 0 recorded");
  assert.equal(lines[3], "Report-job-search weeks: not available on this account");
  assert.equal(lines[4], "Upskilling weeks: none");
});

test("jobs summary with DES links", () => {
  const jobs = {
    jobs: [{ id: 123, jobTitle: "Kitchen hand", jobType: "FULLTIME", employmentConditions: "Permanent", minRateOfPay: 23.5, maxRateOfPay: 25, rateOfPayFrequency: "hourly", displayPayonListing: "true", jobSuburb: "Suburb", jobDistrict: "Auckland", workplaceArrangement: "Onsite" }],
  };
  const lines = summarizeJobs(jobs, "https://new.my.msd.govt.nz");
  assert.equal(lines[0], "1 job matched to you");
  assert.equal(lines[1], "  123: Kitchen hand — FULLTIME Permanent, $23.50–$25.00 hourly, Suburb, Auckland (Onsite) https://new.my.msd.govt.nz/en/job/link?action=jobDetail&callingapp=myMSD&id=123");
  assert.equal(jobLink("", 5), "");
});

test("address summary", () => {
  assert.deepEqual(summarizeAddresses([{ id: "1", addressText: "1 Example Street, Suburb, City 0000", line1: "1 Example Street", suburb: "Suburb", city: "City", postalCode: "0000" }]), ["1 match", "  id 1: 1 Example Street, Suburb, City 0000"]);
  assert.deepEqual(summarizeAddresses([]), ["No matches"]);
});
