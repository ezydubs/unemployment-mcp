import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, isoDate, nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun, tolerant } from "./common.js";

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

export function summarizeCourse(c: Obj): string[] {
  return [`${c.courseId}: ${c.title}${c.shortDescription ? ` — ${c.shortDescription}` : ""}`, `Provider: ${c.providerName ?? "unknown"}${c.providerEmailId ? ` (${c.providerEmailId})` : ""}`];
}

export function jobSearchPayload(i: Obj): { path: string; body: Obj } {
  if (i.action === "set_status") {
    if (!i.id || !i.status) throw new Error("set_status needs id and status");
    return { path: "/rest/employment-plan/job-search-activity/status", body: { id: i.id, status: i.status } };
  }
  for (const k of ["activityDate", "employerName", "role", "applicationMethod", "status"]) if (!i[k]) throw new Error(`add needs ${k}`);
  isoDate(i.activityDate, "activityDate");
  return {
    path: "/rest/employment-plan/job-search-activity",
    body: { activityDate: i.activityDate, employerName: i.employerName, role: i.role, applicationMethod: i.applicationMethod, applicationMethodDesc: i.applicationMethodDesc ?? null, status: i.status },
  };
}
export const rjsPayload = (i: Obj) => ({ id: i.id ?? null, weekCode: i.weekCode, comment: i.comment ?? "" });
export const upskillingPayload = (i: Obj) => ({ weekCode: i.weekCode, startDate: i.startDate ?? null, endDate: i.endDate ?? null, courses: i.courses ?? [] });

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

  server.registerTool(
    "mymsd_course",
    { description: "Detail of a training course MSD refers to (courseId from an upskilling activity or employment-plan activity): title, description, provider.", inputSchema: { courseId: z.string() } },
    ({ courseId }) =>
      call(session, async (http) => {
        const raw = await http.get(`/rest/course/${encodeURIComponent(courseId)}`);
        const c = raw?.courseDetail ?? raw?.course ?? raw;
        return result(summarizeCourse(c ?? { courseId }), raw);
      }),
  );

  server.registerTool(
    "mymsd_job_search_activity",
    {
      description:
        "Record job-search activity in the employment plan (add: date, employer, role, how you applied — use mymsd_job_title_search for the role — and status) or update one's status (set_status with id). Dry run unless confirm: true.",
      inputSchema: {
        action: z.enum(["add", "set_status"]),
        id: z.string().optional(),
        activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        employerName: z.string().optional(),
        role: z.string().optional(),
        applicationMethod: z.string().optional(),
        applicationMethodDesc: z.string().optional(),
        status: z.string().optional(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const { path, body } = jobSearchPayload(args);
        const request = { method: "POST" as const, path, body };
        const effect =
          args.action === "add" ? `MSD will add job-search activity: ${args.employerName} — ${args.role} on ${day(args.activityDate)}` : `MSD will set job-search activity ${args.id} to ${args.status}`;
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(path, body);
        return result([`Recorded. ${effect}.`], { response, request });
      }),
  );
  server.registerTool(
    "mymsd_rjs_report",
    {
      description: "Report job-search activity for a week in the 'report job search' obligation (weekCode from mymsd_employment_plan). Dry run unless confirm: true.",
      inputSchema: { weekCode: z.string(), comment: z.string().max(30).describe("MSD allows 30 characters"), id: z.string().optional(), confirm: z.boolean().default(false) },
    },
    (args) =>
      call(session, async (http) => {
        // the site posts back the id it was given by GET /rest/traffic-light/rjs-activities
        const id = args.id ?? (await http.get("/rest/traffic-light/rjs-activities"))?.id ?? null;
        const body = rjsPayload({ ...args, id });
        const request = { method: "POST" as const, path: "/rest/traffic-light/rjs-activities", body };
        const effect = `MSD will record your job-search report for week ${args.weekCode}`;
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(request.path, body);
        return result([`Reported. ${effect}.`], { response, request });
      }),
  );
  server.registerTool(
    "mymsd_upskilling_report",
    {
      description: "Report upskilling activity for a week (courses as MSD lists them). Untested on this account. Dry run unless confirm: true.",
      inputSchema: {
        weekCode: z.string(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        courses: z.array(z.record(z.string(), z.unknown())).default([]),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const body = upskillingPayload(args);
        const request = { method: "POST" as const, path: "/rest/traffic-light/upskilling-activities", body };
        const effect = `MSD will record upskilling for week ${args.weekCode}`;
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(request.path, body);
        return result([`Reported. ${effect}.`], { response, request });
      }),
  );
}
