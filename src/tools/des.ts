import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { browserAvailable, harvestCookies, harvestStart, openInChrome } from "../browser.js";
import { readChromeCookies } from "../chrome-cookies.js";
import { DesError, DesHttp } from "../des-http.js";
import { DES_NEXT_STEP, type DesSession } from "../des-session.js";
import { day, nzd, result, type ToolResult } from "../format.js";
import { NotLoggedInError } from "../http.js";
import { CookieJar } from "../jar.js";
import { DES_ORIGIN } from "../paths.js";
import type { Session } from "../session.js";
import { dryRun, fail } from "./common.js";

type Obj = Record<string, any>;

/** The search bar's categories (`jl` in the bundle): code → label. */
export const OCCUPATION_GROUPS: Record<string, string> = {
  BLD: "Building & Trades",
  BAO: "Business, Admin & Office",
  CRE: "Creative & Recreational",
  EDU: "Education & Training",
  HSC: "Health & Social Care",
  MFG: "Manufacturing & Processing",
  RSH: "Retail, Hospitality & Tourism",
  SEA: "Seasonal & Outdoor Work",
  SEC: "Security & Uniformed Services",
  TLW: "Transport, Logistics & Warehousing",
};
/** special-caution tokens that stop the SPA from starting an application (`iO` in the bundle) */
export const BLOCKING_CAUTIONS = ["APB"];
const DES_DOMAINS = ["new.my.msd.govt.nz", "identity.msd.govt.nz", "login.realme.govt.nz"];

export const jobUrl = (id: string | number): string => `${DES_ORIGIN}/en/jobs/vacancy/${id}`;

/** a client with no cookies at all, for the public endpoints: a dead session's cookies must not ride along */
const anonymous = (): DesHttp => new DesHttp(new CookieJar([]));

/** DES errors in tool text; a missing session names the DES sign-in, not MyMSD's. */
export function desFail(e: unknown): ToolResult {
  if (e instanceof NotLoggedInError) return { isError: true, content: [{ type: "text", text: `Error: ${e.message}${/des_auth/.test(e.message) ? "" : ` ${DES_NEXT_STEP}`}` }] };
  if (e instanceof DesError) return { isError: true, content: [{ type: "text", text: `Error: ${e.code}: ${e.message}${e.data != null ? `\n\n${JSON.stringify(e.data, null, 2)}` : ""}` }] };
  return fail(e);
}

/** The SPA's search request and its limits (the search route's loader). */
export function searchBody(i: { query?: string; occupationGroups?: string[]; regions?: string[]; districts?: string[] }): Obj {
  const query = i.query?.trim() || undefined;
  const groups = (i.occupationGroups ?? []).map((g) => g.trim().toUpperCase()).filter(Boolean);
  for (const g of groups) if (!OCCUPATION_GROUPS[g]) throw new Error(`unknown occupation group ${g}; use ${Object.keys(OCCUPATION_GROUPS).join(", ")}`);
  const regions = (i.regions ?? []).map((s) => s.trim()).filter(Boolean);
  const districts = (i.districts ?? []).map((s) => s.trim()).filter(Boolean);
  if (!query && !groups.length && !regions.length && !districts.length) throw new Error("give a query, occupationGroups, regions or districts");
  if (query && query.length > 50) throw new Error("query is limited to 50 characters");
  if (regions.length + districts.length > 10) throw new Error("at most 10 regions and districts together");
  const filters: Obj = {};
  if (groups.length) filters.occupationGroups = groups;
  if (regions.length || districts.length) filters.locations = { ...(regions.length ? { regions } : {}), ...(districts.length ? { districts } : {}) };
  return { ...(query ? { searchTerms: query } : {}), filters };
}

export function payText(v: Obj): string {
  if (!v.displayPayOnListing || v.minimumPay == null) return "pay not shown";
  const unit = v.payType === "Annual salary" ? "a year" : "an hour";
  return `${nzd(v.minimumPay)}${v.maximumPay != null && v.maximumPay !== v.minimumPay ? `–${nzd(v.maximumPay)}` : ""} ${unit}`;
}

/** one place name for a vacancy: search results carry name lists, matches and applications carry {region, district, suburb} objects */
const where = (l: any): string => {
  if (!l) return "";
  if (Array.isArray(l)) return l.length > 1 ? "Multiple locations" : l[0]?.suburb?.value || l[0]?.district?.value || l[0]?.region?.value || "";
  if ((l.locationCount ?? 0) > 1) return "Multiple locations";
  return l.suburbs?.[0] || l.districts?.[0] || l.regions?.[0] || "";
};

export function summarizeVacancy(v: Obj): string {
  const kind = [v.vacancyType, v.fullPartTime, v.workPlaceArrangement ?? v.workplaceArrangement].filter(Boolean).join(", ");
  const place = where(v.locations);
  const label = typeof v.match?.label === "string" ? v.match.label.replace(/\s*match$/i, "").toLowerCase() : "";
  const match = label ? `; ${label} match${v.match.score != null ? ` (${v.match.score})` : ""}` : "";
  const status = v.vacancyStatus && v.vacancyStatus !== "Open" ? ` [${v.vacancyStatus}]` : "";
  const closes = v.vacancyPosting?.endDate ? `; closes ${day(v.vacancyPosting.endDate)}` : "";
  return `  ${v.vacancyId}: ${v.vacancyTitle}${v.company?.name ? ` at ${v.company.name}` : ""} — ${kind}; ${payText(v)}${place ? `; ${place}` : ""}${closes}${match}${status} ${jobUrl(v.vacancyId)}`;
}

export function summarizeSearch(r: Obj, limit = 20): string[] {
  const list: Obj[] = r?.suitableVacancies ?? [];
  const total = Number(r?.totalVacancies ?? list.length);
  if (!list.length) return ["No jobs found"];
  const shown = list.slice(0, limit);
  return [`${total} job${total === 1 ? "" : "s"} found${shown.length < list.length ? ` (first ${shown.length} shown; all are in the data)` : ""}`, ...shown.map(summarizeVacancy)];
}

export function summarizeMatches(r: Obj): string[] {
  const list: Obj[] = r?.matchingVacancies ?? [];
  return [list.length ? `${list.length} job match${list.length === 1 ? "" : "es"}` : "No job matches (MSD matches jobs to a complete, active jobseeker profile)", ...list.map(summarizeVacancy)];
}

/** Enough of HTML to read a job description as text. */
export function htmlToText(html: unknown): string {
  if (typeof html !== "string") return "";
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/ul|\/ol)\b[^>]*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** the calendar day of a timestamp like "2026-10-01T10:00:00+1300" (the time of day is noise here) */
const dateOf = (s: unknown): string => (typeof s === "string" ? day(s.slice(0, 10)) : "");

const values = (a: Obj[] | undefined, pick: (x: Obj) => unknown = (x) => x.value): string[] => (a ?? []).map(pick).filter((x): x is string => typeof x === "string" && x !== "");

/** the SPA's `oO`: any blocking token in the `|`-separated list */
export const isBlocked = (token: unknown): boolean =>
  typeof token === "string" &&
  token
    .split("|")
    .map((t) => t.trim())
    .some((t) => BLOCKING_CAUTIONS.includes(t));

export function summarizeJob(r: Obj): string[] {
  const v: Obj = r?.vacancyDetails ?? {};
  const lines = [`${v.vacancyId}: ${v.vacancyTitle} — ${[v.vacancyType, v.fullPartTime, v.workplaceArrangement].filter(Boolean).join(", ")}; ${payText(v)}; ${v.vacancyStatus ?? "status unknown"}`];
  const places = (v.locations ?? []).map((l: Obj) => [l.suburb?.value, l.district?.value, l.region?.value].filter(Boolean).join(", ")).filter(Boolean);
  if (places.length) lines.push(`Location: ${places.join(" | ")}`);
  if (v.occupation?.name) lines.push(`Occupation: ${v.occupation.name}${v.occupation.occupationGroup?.name ? ` (${v.occupation.occupationGroup.name})` : ""}${v.industry?.value ? `; industry ${v.industry.value}` : ""}`);
  const hours = [v.weeklyHours != null ? `${v.weeklyHours} h/week` : "", v.workSchedule, (v.workDays ?? []).join(", "), (v.workHours ?? []).join(", ")].filter(Boolean);
  lines.push(`Hours: ${hours.join("; ") || "not stated"}`);
  lines.push(`Start: ${v.hireDateType ?? "not stated"}${v.expectedHireDate ? ` ${day(v.expectedHireDate)}` : ""}${v.employmentEndDate ? `, ends ${day(v.employmentEndDate)}` : ""}`);
  if (v.experienceRequired) lines.push(`Experience: ${v.experienceRequired}`);
  if (v.onTheJobTrainingProvided) lines.push(`Training: ${v.onTheJobTrainingProvided}`);
  if (v.preEmploymentChecks?.length) lines.push(`Pre-employment checks: ${v.preEmploymentChecks.join(", ")}`);
  const c = v.competencies ?? {};
  if (values(c.skills).length) lines.push(`Skills: ${values(c.skills).join(", ")}`);
  if (values(c.strengths).length) lines.push(`Strengths: ${values(c.strengths).join(", ")}`);
  if (values(c.knowledge).length) lines.push(`Knowledge: ${values(c.knowledge).join(", ")}`);
  if (c.languageProficiencies?.length) {
    const langs = c.languageProficiencies.map((l: Obj) => {
      const levels = values(l.proficiencies, (p) => p.proficiency?.value);
      return `${l.language?.value ?? "?"}${levels.length ? ` (${levels.join(", ")})` : ""}`;
    });
    lines.push(`Languages: ${langs.join("; ")}`);
  }
  if (values(v.credentials).length) lines.push(`Credentials: ${values(v.credentials).join(", ")}`);
  const sell = [v.sellingPoint1, v.sellingPoint2, v.sellingPoint3].filter(Boolean);
  if (sell.length) lines.push(`Highlights: ${sell.join(" | ")}`);
  if (v.vacancyPosting?.startDate) lines.push(`Posted ${day(v.vacancyPosting.startDate)}${v.vacancyPosting.endDate ? `, closes ${day(v.vacancyPosting.endDate)}` : ""}${v.vacancyPosting.postingType ? ` (${v.vacancyPosting.postingType})` : ""} ${jobUrl(v.vacancyId)}`);
  const a = r?.applicationForm;
  if (a) lines.push(`You applied: ${a.applicationFormName ?? a.applicationFormId} on ${dateOf(a.submittedDateTime)}${a.applicationStage ? ` — ${a.applicationStage}` : ""}`);
  if (r?.client?.specialCautionToken) lines.push(`Special-caution flag on your record: ${r.client.specialCautionToken}${isBlocked(r.client.specialCautionToken) ? " (the site does not let you apply online)" : ""}`);
  const desc = htmlToText(v.vacancyDescription);
  if (desc) lines.push("", desc);
  return lines;
}

export const nzToday = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" });

/** Why the site would not let this application start; empty when it would. */
export function applyChecks(detail: Obj, today = nzToday()): string[] {
  const v: Obj = detail?.vacancyDetails ?? {};
  const problems: string[] = [];
  const a = detail?.applicationForm;
  if (a) problems.push(`you already applied (${a.applicationFormName ?? a.applicationFormId}${a.applicationStage ? `, ${a.applicationStage}` : ""})`);
  if (v.vacancyStatus !== "Open") problems.push(v.vacancyStatus ? `the job is ${v.vacancyStatus}` : "the job's status is unknown");
  if (v.vacancyPosting?.endDate && v.vacancyPosting.endDate < today) problems.push(`applications closed ${day(v.vacancyPosting.endDate)}`);
  if (isBlocked(detail?.client?.specialCautionToken)) problems.push(`your record carries a special-caution flag (${detail.client.specialCautionToken}); the site does not allow online applications — call 0800 779 009`);
  return problems;
}

export function applyRequest(id: string, cv: "existing" | "own", reference: "Yes" | "No", csrf: string) {
  return { method: "POST" as const, path: `/bin/sep/vacancy-apply-submit?csrf=${encodeURIComponent(csrf)}`, body: { vacancyId: id, selectedCV: cv, selectedReference: reference } };
}

export function summarizeApplications(r: Obj): string[] {
  const apps: Obj[] = r?.applications ?? [];
  const total = Number(r?.totalApplications ?? apps.length);
  if (!apps.length) return ["No job applications"];
  const lines = [`${total} job application${total === 1 ? "" : "s"}`];
  for (const a of apps) {
    const v = a.vacancy ?? {};
    const place = where(v.locations);
    lines.push(`  ${a.applicationFormName ?? a.applicationFormId}: ${v.vacancyTitle ?? "?"} (job ${v.vacancyId ?? "?"}) — ${a.applicationStage ?? "?"}${a.applicationStageReason ? ` (${a.applicationStageReason})` : ""}, applied ${dateOf(a.submittedDateTime)}${place ? `, ${place}` : ""}`);
  }
  return lines;
}

const unavailable = (o: Obj | undefined): string | null => (o && typeof o.unavailable === "string" ? o.unavailable : null);

export function summarizeProfile(client: Obj | undefined, jobseeker: Obj | undefined): string[] {
  const lines: string[] = [];
  const u1 = unavailable(client);
  if (u1) lines.push(`Client profile: ${u1}`);
  else {
    const p = client?.person ?? {};
    const j = client?.jobseeker ?? {};
    lines.push(`${[p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown name"} (client ${p.clientNumber || "?"}) — ${p.email || "no email"}, ${p.phone || "no phone"}`);
    const addr = [p.personOtherStreet, p.personOtherCity, p.personOtherPostalCode, p.personOtherCountry].filter(Boolean).join(", ");
    if (addr) lines.push(`Address: ${addr}`);
    lines.push(`Jobseeker: ${j.status ?? "status unknown"}, profile ${j.profileCompleteness ?? "unknown"}; job notifications by ${client?.preference?.employmentCommunicationPreference ?? "unknown"}`);
    if (p.specialCautionToken) lines.push(`Special-caution flag: ${p.specialCautionToken}${isBlocked(p.specialCautionToken) ? " (blocks online applications)" : ""}`);
  }
  const u2 = unavailable(jobseeker);
  if (u2) lines.push(`Jobseeker profile: ${u2}`);
  else if (jobseeker) {
    const s = jobseeker;
    if (s.personal?.summary) lines.push(`Summary: ${s.personal.summary}`);
    const skills = values(s.workSkills, (x) => x.skill?.value);
    if (skills.length) lines.push(`Work skills: ${skills.join(", ")}`);
    const other = values(s.otherSkills, (x) => x.skill?.value);
    if (other.length) lines.push(`Other skills: ${other.join(", ")}`);
    const strengths = values(s.strengths, (x) => x.skill?.value);
    if (strengths.length) lines.push(`Strengths: ${strengths.join(", ")}`);
    if (s.workExperiences?.length) {
      lines.push(`Work experience: ${s.workExperiences.map((w: Obj) => `${w.jobTitle || w.jobType?.value || "?"}${w.employer ? ` at ${w.employer}` : ""}${w.startofworkYear ? ` (${w.startofworkYear}–${w.stillWorking === "Yes" ? "now" : (w.endofworkYear ?? "?")})` : ""}`).join("; ")}`);
    }
    if (s.educations?.length) lines.push(`Education: ${s.educations.map((e: Obj) => `${e.courseName?.value ?? "?"}${e.placeOfLearning ? ` (${e.placeOfLearning})` : ""}`).join("; ")}`);
    const langs = values(s.languageProficiencies, (l) => l.language?.value);
    if (langs.length) lines.push(`Languages: ${langs.join(", ")}`);
    const classes = values(s.driverlicence?.licencesClass, (c) => c.credential?.value);
    lines.push(`Driver licence: ${s.hasAnyNzdriversLicence ?? "unknown"}${classes.length ? ` (${classes.join(", ")})` : ""}; reliable transport: ${s.reliableTransportAvailable ?? "unknown"}`);
    const wants = values(s.jobsInterested, (x) => x.job?.value);
    if (wants.length) lines.push(`Jobs wanted: ${wants.join(", ")}`);
    const places = values(s.locationsInterested, (x) => x.location?.value);
    if (places.length) lines.push(`Locations wanted: ${places.join(", ")}`);
    const w = s.workAvailability;
    if (w?.hoursOfWork || w?.daysAvailable) lines.push(`Availability: ${[w.hoursOfWork, w.daysAvailable, values(w.specificDays).join("/")].filter(Boolean).join("; ")}`);
    lines.push(`Edit the profile on the site: ${DES_ORIGIN}/en/forms/jsp (MSD's profile wizard)`);
  }
  return lines;
}

const LEVELS = ["island", "region", "district", "suburb"];
export function flattenLocations(results: Obj[] | undefined, depth = 0, out: string[] = []): string[] {
  for (const r of results ?? []) {
    out.push(`${"  ".repeat(depth)}${r.description} — ${LEVELS[depth] ?? "area"} (${r.code})`);
    if (r.children?.length) flattenLocations(r.children, depth + 1, out);
  }
  return out;
}

const whoami = (d: DesSession): string =>
  d.info?.authenticated
    ? `Signed in to DES as ${[d.info.firstName, d.info.lastName].filter(Boolean).join(" ")} (client ${d.info.clientNumber}); profile ${d.info.profileCompleteness || "unknown"}, ${d.info.profileStatus || "status unknown"}.`
    : "Not signed in to DES.";

const extFor = (type: string): string => (type.includes("pdf") ? ".pdf" : type.includes("wordprocessingml") ? ".docx" : type.includes("msword") ? ".doc" : type.includes("text/plain") ? ".txt" : "");

type Runner = (fn: (http: DesHttp) => Promise<ToolResult>) => Promise<ToolResult>;

export function register(server: McpServer, session: Session): void {
  const des = session.des;
  /** public endpoints: with the session's cookies when it has any (the detail then knows about applications), without a sign-in otherwise */
  const open: Runner = async (fn) => {
    if (des.hasCookies()) {
      try {
        return await des.run(fn);
      } catch (e) {
        if (!(e instanceof NotLoggedInError)) return desFail(e);
      }
    }
    return fn(anonymous()).catch(desFail);
  };
  const signedIn: Runner = (fn) => des.run(fn).catch(desFail);
  /** for reads that aggregate: a part DES refuses becomes `{ unavailable }` instead of failing the whole call */
  const soft = async <T>(p: Promise<T>): Promise<T | { unavailable: string }> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof DesError) return { unavailable: `${e.code}: ${e.message}` };
      throw e;
    }
  };

  server.registerTool(
    "des_search",
    {
      description:
        "Search jobs on DES (new.my.msd.govt.nz, MSD's jobs site) — public, no sign-in needed. Give words and/or occupation groups and/or locations (region or district names exactly as des_locations lists them). " +
        "Returns the site's matching vacancies: type, pay when the employer shows it, place, closing date, match label when signed in, and the job link.",
      inputSchema: {
        query: z.string().max(50).optional().describe("words to search for (the site allows up to 50 characters)"),
        occupationGroups: z
          .array(z.enum(Object.keys(OCCUPATION_GROUPS) as [string, ...string[]]))
          .optional()
          .describe(
            "BLD Building & Trades; BAO Business, Admin & Office; CRE Creative & Recreational; EDU Education & Training; HSC Health & Social Care; MFG Manufacturing & Processing; RSH Retail, Hospitality & Tourism; SEA Seasonal & Outdoor Work; SEC Security & Uniformed Services; TLW Transport, Logistics & Warehousing",
          ),
        regions: z.array(z.string()).optional().describe('region names, e.g. "Auckland Region"'),
        districts: z.array(z.string()).optional().describe('district names, e.g. "Hamilton City"; regions + districts at most 10'),
        limit: z.number().int().min(1).max(100).default(20).describe("how many to summarise (every result is in the data)"),
      },
    },
    async (args) =>
      open(async (http) => {
        const body = searchBody(args);
        const r = (await http.api("/bin/sep/vacancies/search", body))?.results ?? {};
        return result(summarizeSearch(r, args.limit), r);
      }),
  );

  server.registerTool(
    "des_job",
    {
      description: "One job on DES in full: description, hours, pay, start, checks, skills, credentials, posting dates, link — and, when signed in, whether you applied and the stage. Public, no sign-in needed.",
      inputSchema: { id: z.string().min(1).describe("the job's vacancy id, e.g. 30070041 (from des_search, des_matches or a job link)") },
    },
    async (args) =>
      open(async (http) => {
        const r = (await http.api("/bin/sep/vacancies/details", undefined, { vacancyId: args.id }))?.results ?? {};
        return result(summarizeJob(r), r);
      }),
  );

  server.registerTool(
    "des_locations",
    {
      description: "Look up DES's place names (island → region → district → suburb) by the start of a name; use the region and district names it returns in des_search. Public.",
      inputSchema: { query: z.string().min(1).max(50).describe('the start of a place name, e.g. "auck" or "hamil"') },
    },
    async (args) => {
      try {
        const r = await anonymous().api("/bin/sep/v10/refdata.json", undefined, { category: "userLocations", q: args.query, mode: "startswith" });
        const lines = flattenLocations(r?.results);
        return result([lines.length ? `${r?.total ?? lines.length} match${r?.total === 1 ? "" : "es"} for "${args.query}"` : `No place starts with "${args.query}"`, ...lines], r);
      } catch (e) {
        return desFail(e);
      }
    },
  );

  server.registerTool(
    "des_matches",
    {
      description: "The jobs DES matched to your jobseeker profile (signed in). Needs a complete, active profile on the site; otherwise there are none.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10).describe("how many matches to ask for") },
    },
    async (args) =>
      signedIn(async (http) => {
        let r: Obj;
        try {
          r = (await http.api("/bin/sep/vacancies/match", undefined, { limit: args.limit }))?.results ?? {};
        } catch (e) {
          if (!(e instanceof DesError) || e.status !== 404) throw e;
          r = { matchingVacancies: [] }; // the site's own meaning for 404 here
        }
        return result(summarizeMatches(r), r);
      }),
  );

  server.registerTool(
    "des_profile",
    {
      description:
        "Your DES client profile (name, contact details, jobseeker status, job-notification preference) and jobseeker profile (summary, skills, strengths, experience, education, languages, licence, availability, jobs and places wanted). Signed in. Editing happens on the site's profile wizard.",
      inputSchema: {},
    },
    async () =>
      signedIn(async (http) => {
        const [client, jobseeker] = await Promise.all([soft(http.api("/bin/sep/client-profile").then((r) => r?.results)), soft(http.api("/bin/sep/jobseeker-profile").then((r) => r?.result))]);
        return result(summarizeProfile(client, jobseeker), { client, jobseeker });
      }),
  );

  server.registerTool(
    "des_applications",
    { description: "Your job applications on DES with their stage (Submitted, On-Hold, Shortlisted, Return to MSD, Withdrawn, Cancelled, Unsuccessful, Successful). Signed in.", inputSchema: {} },
    async () =>
      signedIn(async (http) => {
        const r = (await http.api("/bin/sep/job-applications"))?.results ?? {};
        return result(summarizeApplications(r), r);
      }),
  );

  registerAccountTools(server, session, { open, signedIn });
}

/** des_auth, des_apply and des_cv. */
function registerAccountTools(server: McpServer, session: Session, { signedIn }: { open: Runner; signedIn: Runner }): void {
  const des = session.des;

  server.registerTool(
    "des_auth",
    {
      description:
        "Sign-in state and sign-in actions for DES (new.my.msd.govt.nz). status: who is signed in, how long the session has left, which cookies are held. " +
        "import_chrome: take the sign-in from Google Chrome's Default profile (be signed in at new.my.msd.govt.nz there). " +
        "login: open a browser window at the DES sign-in (the optional CloakBrowser when installed; otherwise your own browser, after which you run import_chrome). " +
        "forget: drop the DES cookies and state only. The session repairs itself through MSD's identity provider while its single-sign-on cookie lasts.",
      inputSchema: {
        action: z.enum(["status", "import_chrome", "login", "forget"]).default("status"),
        chromeProfile: z.string().optional().describe('Chrome profile folder, default "Default"'),
      },
    },
    async (args) => {
      try {
        switch (args.action) {
          case "status": {
            if (des.hasCookies() || des.hasSso()) await des.ensure().catch(() => {});
            return result([whoami(des), `Optional browser installed: ${await browserAvailable()}`], des.status());
          }
          case "import_chrome": {
            const cookies = (await readChromeCookies({ profile: args.chromeProfile, domains: DES_DOMAINS })).filter((c) => c.value !== "");
            if (!cookies.some((c) => c.domain === "new.my.msd.govt.nz" && c.name.startsWith("__Host-"))) {
              return desFail(new Error("Chrome holds no DES sign-in (its new.my.msd.govt.nz cookies are missing or empty). Sign in at new.my.msd.govt.nz in Chrome, then run this again."));
            }
            des.addCookies(cookies);
            const info = await des.ensure(true);
            return result([`Imported ${cookies.length} cookies from Chrome. ${whoami(des)}`], { imported: cookies.map((c) => `${c.domain} ${c.name}`), signedIn: info.authenticated });
          }
          case "login": {
            if (await browserAvailable()) {
              des.addCookies(await harvestCookies({ jar: session.jar, headless: false, waitForAuth: true, timeoutMs: 5 * 60_000, site: "des" }));
              await des.ensure(true);
              return result([`Signed in through the browser window. ${whoami(des)}`], des.status());
            }
            await openInChrome(harvestStart("des"));
            return result(["Opened the DES sign-in in your browser. Sign in there, then run des_auth import_chrome."], { browserInstalled: false });
          }
          case "forget": {
            des.forget();
            return result(["Forgot the DES session (the MyMSD and RealMe cookies are kept)."], des.status());
          }
        }
      } catch (e) {
        return desFail(e);
      }
    },
  );

  server.registerTool(
    "des_apply",
    {
      description:
        "Apply for a job on DES — the site's three-step flow in one call: which CV (existing = the CV MSD already holds; own = you email your CV back on the confirmation email), whether you have a referee, then submit. " +
        "Checks first that you have not applied, the job is Open and not closed, and nothing on your record blocks online applications. Dry run unless confirm: true.",
      inputSchema: {
        id: z.string().min(1).describe("the job's vacancy id"),
        cv: z.enum(["existing", "own"]).describe("existing: use the CV MSD already has; own: send your own CV by replying to the confirmation email"),
        reference: z.enum(["Yes", "No"]).describe("do you have someone who can be your reference"),
        confirm: z.boolean().default(false).describe("send it; without this the exact request is shown and nothing is sent"),
      },
    },
    async (args) =>
      signedIn(async (http) => {
        const detail = (await http.api("/bin/sep/vacancies/details", undefined, { vacancyId: args.id }))?.results ?? {};
        const title = detail.vacancyDetails?.vacancyTitle ?? args.id;
        const problems = applyChecks(detail);
        if (problems.length) return desFail(new Error(`cannot apply for ${title}: ${problems.join("; ")}`));
        const csrf = http.csrfToken();
        if (!csrf) return desFail(new NotLoggedInError(`DES has not given this session a __Host-csrf cookie. ${DES_NEXT_STEP}`));
        const request = applyRequest(args.id, args.cv, args.reference, csrf);
        const effect = `an application for "${title}" (job ${args.id}) will be submitted with ${args.cv === "existing" ? "the CV MSD already holds" : "your own CV, which you then email back on the confirmation email"} and reference: ${args.reference}`;
        if (!args.confirm) return dryRun({ method: "POST", path: request.path.replace(/csrf=.*/, "csrf=<__Host-csrf>"), body: request.body }, effect, { job: summarizeJob(detail).slice(0, 3) });
        let r: Obj;
        try {
          r = (await http.api(request.path, request.body))?.results ?? {};
        } catch (e) {
          // never re-send a submission: the session's retry would post a second application
          if (e instanceof NotLoggedInError) return desFail(new Error("DES's session ended while the application was being submitted; it may or may not have been recorded — check des_applications before applying again"));
          throw e;
        }
        return result([`Applied for ${title}: application ${r.applicationFormName ?? "?"} (${r.applicationFormId ?? "?"}).${args.cv === "own" ? " Reply to MSD's confirmation email with your CV attached." : ""}`], r);
      }),
  );

  server.registerTool(
    "des_cv",
    {
      description: "Download the CV MSD holds for you from DES. Signed in.",
      inputSchema: { path: z.string().optional().describe("where to save it; default: the temp dir, named as the site names it") },
    },
    async (args) =>
      signedIn(async (http) => {
        const f = await http.fetchFile("/bin/bff/cv");
        const to = args.path ?? join(tmpdir(), f.filename ?? `mymsd-des-cv${extFor(f.contentType)}`);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, f.bytes);
        return result([`Saved your CV (${f.bytes.length} bytes, ${f.contentType}) to ${to}`], { path: to, bytes: f.bytes.length, contentType: f.contentType, filename: f.filename });
      }),
  );
}
