import { test } from "node:test";
import assert from "node:assert/strict";
const { jobSearchPayload, rjsPayload, upskillingPayload } = await import("../dist/tools/employment.js");

test("payloads mirror the site's serialisers", () => {
  assert.deepEqual(jobSearchPayload({ action: "add", activityDate: "2026-10-10", employerName: "Example Ltd", role: "Cook", applicationMethod: "online", status: "applied" }), {
    path: "/rest/employment-plan/job-search-activity",
    body: { activityDate: "2026-10-10", employerName: "Example Ltd", role: "Cook", applicationMethod: "online", applicationMethodDesc: null, status: "applied" },
  });
  assert.deepEqual(jobSearchPayload({ action: "set_status", id: "j1", status: "interview" }), { path: "/rest/employment-plan/job-search-activity/status", body: { id: "j1", status: "interview" } });
  assert.throws(() => jobSearchPayload({ action: "add", employerName: "x" }), /activityDate/);
  assert.deepEqual(rjsPayload({ weekCode: "2026-W41", comment: "Applied to 3 jobs" }), { id: null, weekCode: "2026-W41", comment: "Applied to 3 jobs" });
  assert.deepEqual(upskillingPayload({ weekCode: "2026-W41", courses: [{ name: "Forklift" }] }), { weekCode: "2026-W41", startDate: null, endDate: null, courses: [{ name: "Forklift" }] });
});
