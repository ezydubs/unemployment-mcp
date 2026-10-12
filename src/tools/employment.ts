import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call, tolerant } from "./common.js";

type Obj = Record<string, any>;
const unavailable = (o: Obj | undefined): string | null => (o && typeof o.unavailable === "string" ? o.unavailable : null);

export function summarizeEmploymentPlan(activities: Obj, rjs: Obj, upskilling: Obj): string[] {
  const lines: string[] = [];
  const u1 = unavailable(activities);
  if (u1) lines.push(`Employment plan: ${u1}`);
  else {
    const acts: Obj[] = activities?.activities ?? [];
    lines.push(`Employment plan: ${acts.length} activit${acts.length === 1 ? "y" : "ies"}`);
    for (const a of acts) lines.push(`  ${a.id}: ${a.description}${a.dueBy ? ` by ${day(a.dueBy)}` : ""}`);
    const log: Obj[] = activities?.jobSearchActivities ?? [];
    lines.push(`Job-search log: ${activities?.hasRecordJobSearch ? "required" : "not required (hasRecordJobSearch false)"}; ${log.length} recorded`);
    for (const j of log) lines.push(`  ${j.id ?? ""} ${day(j.activityDate)} ${j.employerName} — ${j.role} (${j.applicationMethod}${j.status ? `, ${j.status}` : ""})`.trim());
  }
  const u2 = unavailable(rjs);
  const weeks: Obj[] = rjs?.reportJobSearchActivities ?? [];
  lines.push(
    u2
      ? `Report-job-search weeks: ${u2}`
      : weeks.length
        ? `Report-job-search weeks: ${weeks.map((w) => `${w.weekCode} (${day(w.startDate)}–${day(w.endDate)}: ${w.activityCount})`).join("; ")}`
        : "Report-job-search weeks: none",
  );
  const u3 = unavailable(upskilling);
  const ups: Obj[] = upskilling?.upskillingActivities ?? [];
  lines.push(u3 ? `Upskilling weeks: ${u3}` : ups.length ? `Upskilling weeks: ${ups.map((w) => w.weekCode).join(", ")}` : "Upskilling weeks: none");
  return lines;
}

/** Job detail opens on DES (new.my.msd.govt.nz); desUrl comes from the session. */
export const jobLink = (desUrl: string, id: number | string): string => (desUrl ? `${desUrl}/en/job/link?action=jobDetail&callingapp=myMSD&id=${id}` : "");

export function summarizeJobs(data: Obj, desUrl: string): string[] {
  const jobs: Obj[] = data?.jobs ?? [];
  const lines = [jobs.length ? `${jobs.length} job${jobs.length === 1 ? "" : "s"} matched to you` : "No matched jobs"];
  for (const j of jobs) {
    const pay = j.displayPayonListing === "true" || j.displayPayonListing === true ? `${nzd(j.minRateOfPay)}–${nzd(j.maxRateOfPay)} ${j.rateOfPayFrequency ?? ""}`.trim() : "pay not shown";
    lines.push(
      `  ${j.id}: ${j.jobTitle} — ${[j.jobType, j.employmentConditions].filter(Boolean).join(" ")}, ${pay}, ${[j.jobSuburb, j.jobDistrict].filter(Boolean).join(", ")}${j.workplaceArrangement ? ` (${j.workplaceArrangement})` : ""} ${jobLink(desUrl, j.id)}`.trimEnd(),
    );
  }
  return lines;
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_employment_plan",
    {
      description:
        "Obligations and employment plan: activities with due dates, the job-search log (when required), report-job-search weeks and upskilling weeks. Parts this client does not have are reported as unavailable.",
      inputSchema: {},
    },
    () =>
      call(session, async (http) => {
        const [activities, rjs, upskilling] = await Promise.all([
          tolerant(http.get("/rest/employment-plan/activities")),
          tolerant(http.get("/rest/traffic-light/rjs-activities")),
          tolerant(http.get("/rest/traffic-light/upskilling-activities")),
        ]);
        return result(summarizeEmploymentPlan(activities, rjs, upskilling), { activities, rjs, upskilling });
      }),
  );
  server.registerTool(
    "mymsd_jobs",
    { description: "Jobs MSD has matched to this client (title, type, pay, location) with links to the job detail on DES (new.my.msd.govt.nz).", inputSchema: {} },
    () =>
      call(session, async (http) => {
        const jobs = await http.get("/rest/jobs");
        const desUrl = session.info?.desUrl ?? "";
        return result(summarizeJobs(jobs, desUrl), { ...jobs, links: (jobs?.jobs ?? []).map((j: Obj) => ({ id: j.id, url: jobLink(desUrl, j.id) })) });
      }),
  );
  server.registerTool(
    "mymsd_job_title_search",
    { description: "MSD's job-title lookup (used when recording job-search activity): matching titles for a text.", inputSchema: { query: z.string().min(2) } },
    ({ query }) =>
      call(session, async (http) => {
        const titles: string[] = await http.get("/rest/applications/jobTitles/findMatches", { jobTitle: query });
        return result([`${titles.length} titles: ${titles.slice(0, 20).join(", ")}`], titles);
      }),
  );
}
