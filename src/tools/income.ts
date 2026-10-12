import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, isoDate, nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun } from "./common.js";

type Obj = Record<string, any>;

export function summarizeIncome(income: Obj, employers: Obj): string[] {
  const names = (employers?.employers ?? []).map((e: Obj) => e.name).join(", ");
  return [
    `Income declared from ${day(income?.fromDate)}: ${nzd(income?.total)} (${income?.frequency ?? "?"}); last declaration ${nzd(income?.lastDeclarationAmount)}`,
    `Next week to declare starts ${day(income?.declareWagesStartDate)}; known employers: ${names || "none"}`,
    ...(income?.incomeDetails?.length ? [`Income details: ${income.incomeDetails.map((d: Obj) => JSON.stringify(d)).join("; ")}`] : []),
  ];
}

export interface WageInput {
  employer: string;
  type: "hourly" | "weekly";
  hours?: number;
  hourlyRate?: number;
  weeklyTotal?: number;
  weeklyHours?: number;
}
export interface DeclarationInput {
  weekStarting: string;
  didNotWork?: boolean;
  wages?: WageInput[];
  childcareCosts?: number;
  acceptBelowMinimumWage?: boolean;
}
interface Wage {
  employer: string;
  totalTime: number;
  totalIncome: number;
  type: "hourly" | "weekly" | "empty";
  isDaily: boolean;
  hourlyRate: number;
  weeklyTotal: number;
  weeklyTime: number;
}

/** The SPA's own limits (config/environment): 10 wages, $5,000 a week, 120 h a week, $9,999.99 childcare, training wage $19.16. */
export const LIMITS = { maxWages: 10, maxTotalIncome: 5000, maxWeeklyMinutes: 7200, maxChildcare: 9999.99, trainingWage: 19.16 };
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What the SPA shows as the hourly rate: the rate itself, or weekly total over weekly hours. */
export const hourlyWage = (w: Wage): number => (w.type === "hourly" ? w.hourlyRate : w.type === "weekly" && w.weeklyTime > 0 ? w.weeklyTotal / (w.weeklyTime / 60) : 0);

/** Builds `income/declaration.toJSON()` exactly as the site's wage model would, refusing anything the site's own validation would. */
export function buildDeclaration(i: DeclarationInput) {
  isoDate(i.weekStarting, "weekStarting");
  const dow = new Date(`${i.weekStarting}T00:00:00Z`).getUTCDay();
  if (dow !== 1) throw new Error(`weekStarting must be the Monday of the week being declared (${i.weekStarting} is a ${DAY_NAMES[dow]})`);
  let wages: Wage[];
  if (i.didNotWork) {
    if (i.wages?.length) throw new Error("didNotWork cannot be combined with wages");
    wages = [{ employer: "", totalTime: 0, totalIncome: 0, type: "empty", isDaily: false, hourlyRate: 0, weeklyTotal: 0, weeklyTime: 0 }];
  } else {
    if (!i.wages?.length) throw new Error("give wages, or didNotWork: true");
    if (i.wages.length > LIMITS.maxWages) throw new Error(`MyMSD accepts at most ${LIMITS.maxWages} wages in one declaration`);
    wages = i.wages.map((w, n) => {
      const employer = (w.employer ?? "").trim();
      if (!employer) throw new Error(`wage ${n + 1}: employer is required`);
      if (w.type === "hourly") {
        if (!(w.hours! > 0) || !(w.hourlyRate! > 0)) throw new Error(`wage ${n + 1} (${employer}): hourly wages need hours and hourlyRate above 0`);
        const totalTime = Math.round(w.hours! * 60);
        return { employer, totalTime, totalIncome: round2((w.hourlyRate! * totalTime) / 60), type: "hourly" as const, isDaily: false, hourlyRate: w.hourlyRate!, weeklyTotal: 0, weeklyTime: 0 };
      }
      if (!(w.weeklyTotal! >= 0) || !(w.weeklyHours! > 0)) throw new Error(`wage ${n + 1} (${employer}): weekly wages need weeklyTotal (0 or more) and weeklyHours above 0`);
      const weeklyTime = Math.round(w.weeklyHours! * 60);
      return { employer, totalTime: weeklyTime, totalIncome: round2(w.weeklyTotal!), type: "weekly" as const, isDaily: false, hourlyRate: 0, weeklyTotal: round2(w.weeklyTotal!), weeklyTime };
    });
    for (const w of wages) if (w.totalTime > LIMITS.maxWeeklyMinutes) throw new Error(`${w.employer}: more than 120 hours in one week`);
    const total = wages.reduce((s, w) => s + w.totalIncome, 0);
    if (total > LIMITS.maxTotalIncome) throw new Error(`total income ${nzd(total)} is above MyMSD's $5,000 weekly limit`);
    const low = wages.filter((w) => hourlyWage(w) < LIMITS.trainingWage);
    if (low.length && !i.acceptBelowMinimumWage) {
      throw new Error(`${low.map((w) => w.employer).join(", ")}: below the training wage of $${LIMITS.trainingWage}/h; set acceptBelowMinimumWage: true to declare it anyway`);
    }
  }
  const childcareCosts = round2(i.childcareCosts ?? 0);
  if (childcareCosts < 0 || childcareCosts > LIMITS.maxChildcare) throw new Error("childcareCosts must be between 0 and 9999.99");
  return { date: i.weekStarting, isEdit: false, childcareCosts, wages, isAcceptedUnderMinWage: !!i.acceptBelowMinimumWage };
}

export function describeDeclaration(p: ReturnType<typeof buildDeclaration>): string {
  const week = day(p.date);
  if (p.wages[0]?.type === "empty") return `MSD will record that you did not work in the week starting ${week}`;
  const parts = p.wages.map((w) => `${w.employer} ${nzd(w.totalIncome)} for ${(w.totalTime / 60).toFixed(1)} h`);
  const total = p.wages.reduce((s, w) => s + w.totalIncome, 0);
  return `MSD will record a wage declaration for the week starting ${week}: ${parts.join(", ")} (total ${nzd(total)}${p.childcareCosts ? `, childcare ${nzd(p.childcareCosts)}` : ""})`;
}

const wageSchema = z.object({
  employer: z.string().describe("employer name, as MSD knows it (mymsd_income lists known employers)"),
  type: z.enum(["hourly", "weekly"]),
  hours: z.number().positive().optional().describe("hourly: hours worked in the week"),
  hourlyRate: z.number().positive().optional().describe("hourly: gross rate before tax"),
  weeklyTotal: z.number().min(0).optional().describe("weekly: gross income for the week before tax"),
  weeklyHours: z.number().positive().optional().describe("weekly: hours worked in the week"),
});

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_income",
    {
      description:
        "Declared income: the current week's total and frequency, the last declaration, the week MyMSD expects next, and the employers it already knows (they pre-fill a declaration).",
      inputSchema: {},
    },
    () =>
      call(session, async (http) => {
        const [income, employers] = await Promise.all([http.get("/rest/income"), http.get("/rest/income/employers")]);
        return result(summarizeIncome(income, employers), { income, employers });
      }),
  );

  server.registerTool(
    "mymsd_declare_wages",
    {
      description:
        "Declare wages for one week (the 'Declare wages' flow). This is a legal declaration to MSD that changes your payment. weekStarting is the Monday of the week; " +
        "give wages (hourly: hours + hourlyRate, or weekly: weeklyTotal + weeklyHours, gross before tax) or didNotWork: true. Dry run unless confirm: true.",
      inputSchema: {
        weekStarting: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Monday of the week, YYYY-MM-DD"),
        didNotWork: z.boolean().default(false),
        wages: z.array(wageSchema).optional(),
        childcareCosts: z.number().min(0).optional(),
        acceptBelowMinimumWage: z.boolean().default(false).describe("confirm a wage below the training wage ($19.16/h) is right"),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const payload = buildDeclaration(args);
        const request = { method: "POST" as const, path: "/rest/income/submitDeclaration", body: payload };
        const effect = describeDeclaration(payload);
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(request.path, payload);
        return result([`Submitted. ${effect}.`], { response, request });
      }),
  );
}
