import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename } from "node:path";
import { z } from "zod";
import { nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun, tolerant } from "./common.js";
import { validateFiles } from "./documents.js";

type Obj = Record<string, any>;
export const HARDSHIP_TYPES = ["food", "dental", "schoolUniforms", "schoolStationery"] as const;
export type HardshipType = (typeof HARDSHIP_TYPES)[number];

export function summarizeOneOffCosts(costs: Obj, data: Obj): string[] {
  const list: Obj[] = costs?.oneOffCosts ?? [];
  const byCat = new Map<string, Obj[]>();
  for (const c of list) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c]);
  const lines = [`${list.length} catalogue entries loaded: ${[...byCat].map(([k, v]) => `${k} (${v.length})`).join(", ")}`];
  for (const c of list) lines.push(`  ${c.category}: ${c.title}${c.outcome ? ` [outcome ${c.outcome.id}, ${c.outcome.type}]` : ""}`);
  if (data && !data.unavailable) {
    for (const t of HARDSHIP_TYPES) {
      const d = data[t];
      if (d) {
        lines.push(
          `Hardship eligibility — ${t}: ${d.eligibility}${d.maxAmount != null ? `, up to ${nzd(d.maxAmount)}` : ""}${d.balance != null ? ` (balance ${nzd(d.balance)})` : ""}; applications so far: ${data.count ?? 0}`,
        );
      }
    }
  }
  return lines;
}

/** The display texts the site substitutes for option codes before posting (ember-intl en translations). */
export const TEXT = {
  whyNotAssets: { bills: "It’s for a household bill", other: "It’s for something else", saving: "Saving for an essential item" },
  stepsTaken: {
    askedRelatives: "Asked family and friends for help",
    budgetingPlanning: "Budgeting and planning",
    lookingForWork: "Looking for part-time work",
    none: "I haven’t taken any steps to meet my costs",
    other: "Something else",
    reducingCosts: "Reducing costs",
  },
} as const;
export const WHAT_HAS_HAPPENED = ["familyEmergency", "urgentBill", "schoolCosts", "medicalCosts", "vehicleCosts", "workCosts", "movingCosts", "other"] as const;
export const STEPS_TO_TAKE = [
  "seekWork",
  "stopServices",
  "reduceCosts",
  "renegotiateDebt",
  "increaseHours",
  "setupPayments",
  "goToMarket",
  "renegotiateCourtFines",
  "talkToPowerCompany",
  "learnToCook",
  "quitSmoking",
  "usePublicTransport",
  "carpool",
  "consolidateDebt",
  "talkToSchool",
  "other",
] as const;
const STEPS_TAKEN = ["askedRelatives", "lookingForWork", "budgetingPlanning", "reducingCosts", "other", "none"] as const;

export interface HardshipInput {
  types: readonly HardshipType[];
  food?: Obj;
  dental?: Obj;
  schoolUniforms?: Obj;
  schoolStationery?: Obj;
  answers: Obj;
  suppliers?: Obj[];
}

/** POST /rest/hardship body, built as resources/serializers/hardship builds it from the hardship model. */
export function serializeHardship(i: HardshipInput, data: Obj, evidenceIds: Record<string, string[]>): Obj {
  const a = i.answers ?? {};
  const stepsTakenCodes: string[] = a.stepsTaken ?? [];
  let steps = stepsTakenCodes.filter((s) => s !== "other");
  const stepsTakenNone = steps.includes("none");
  if (stepsTakenNone) steps = ["none"];
  let stepsTaken: string[] = steps.map((s) => TEXT.stepsTaken[s as keyof typeof TEXT.stepsTaken] ?? s);
  if (a.stepsTakenOther) stepsTaken = stepsTaken.concat(a.stepsTakenOther);
  const types = i.types.map((t) => {
    const given = i[t] ?? {};
    const limits = data?.[t] ?? {};
    const base: Obj = { ...limits, ...given, type: t };
    if (t === "dental" || t === "schoolUniforms" || t === "schoolStationery") base.suppliers = i.suppliers ?? [];
    return base;
  });
  return {
    count: data?.count ?? 0,
    stpCandidate: !!data?.isStpCandidate,
    isPrevStepOther: data?.lastApplication?.stepToTake === "other",
    chosenCard: a.chosenCard ?? null,
    hasIncome: !!a.hasIncome,
    hasIncomeChanged: !!a.hasIncomeChanged,
    hasAssets: a.haveAssetsChanged === false ? true : !!a.hasAssets,
    haveAssetsChanged: a.haveAssetsChanged ?? null,
    whyNotAssets: a.whyNotAssets ? (TEXT.whyNotAssets[a.whyNotAssets as keyof typeof TEXT.whyNotAssets] ?? a.whyNotAssets) : null,
    stepsTaken,
    stepsTakenNone,
    stepToTake: a.stepToTake ?? null,
    stepToTakeOther: a.stepToTakeOther ?? null,
    isStepToTakeOther: a.stepToTake === "other",
    isWhyNotAssetsOther: a.whyNotAssets === "other",
    hasTakenPreviousStep: !!a.hasTakenPreviousStep,
    agreeToRepayments: !!a.agreeToRepayments,
    cantUpload: !!a.cantUpload,
    types,
    evidence: evidenceIds,
  };
}

const schoolSchema = z.object({ whoFor: z.enum(["me", "otherChild"]), childData: z.unknown().optional(), hasAppliedForSYSP: z.boolean().optional(), howMuchNeed: z.number().positive() });

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_one_off_costs",
    {
      description:
        "'Something has changed → one-off cost': MSD's catalogue of one-off costs (each with the outcome MyMSD offers: apply online, book an appointment, contact MSD) and, for the given hardship types, this client's eligibility and limits for a hardship grant (food, dental, school uniforms, school stationery).",
      inputSchema: { types: z.array(z.enum(HARDSHIP_TYPES)).default([...HARDSHIP_TYPES]) },
    },
    ({ types }) =>
      call(session, async (http) => {
        const [costs, data, outcomes] = await Promise.all([
          http.get("/rest/data/oneOffCosts"),
          tolerant(http.get("/rest/hardship/data", { types: types.join(",") })),
          tolerant(http.get("/rest/data/outcomes")),
        ]);
        return result(summarizeOneOffCosts(costs, data), { ...costs, hardship: data, outcomes });
      }),
  );

  server.registerTool(
    "mymsd_hardship_apply",
    {
      description:
        "Apply online for a one-off cost / hardship grant (food, dental, school uniforms, school stationery), the 'Something has changed → one-off cost' flow. Runs MSD's eligibility check first and refuses when a type is notEligible, mustCall or alreadyApplied. " +
        "Dental and school types need evidence files unless answers.cantUpload. This creates a grant or a recoverable advance that MSD deducts from your benefit. Untested end to end on this account. Dry run unless confirm: true.",
      inputSchema: {
        types: z.array(z.enum(HARDSHIP_TYPES)).min(1),
        food: z
          .object({ whatHasHappened: z.enum(WHAT_HAS_HAPPENED), whatHasHappenedOther: z.string().optional(), whyHadToPay: z.string(), howMuchPaid: z.number().min(0), howMuchNeed: z.number().positive() })
          .optional(),
        dental: z
          .object({ whoFor: z.enum(["me", "otherChild"]), typeOfTreatment: z.enum(["immediateAndEssential", "orthodontic", "other"]), isPaidForByOther: z.boolean(), howMuchNeed: z.number().positive() })
          .optional(),
        schoolUniforms: schoolSchema.optional(),
        schoolStationery: schoolSchema.optional(),
        answers: z.object({
          chosenCard: z.string().describe("payment card cardNo the grant is loaded to"),
          hasIncome: z.boolean(),
          hasIncomeChanged: z.boolean().optional(),
          hasAssets: z.boolean(),
          haveAssetsChanged: z.boolean().nullable().optional(),
          whyNotAssets: z.enum(["saving", "bills", "other"]).optional(),
          stepsTaken: z.array(z.enum(STEPS_TAKEN)).min(1),
          stepsTakenOther: z.string().optional(),
          stepToTake: z.enum(STEPS_TO_TAKE),
          stepToTakeOther: z.string().optional(),
          hasTakenPreviousStep: z.boolean().optional(),
          agreeToRepayments: z.boolean(),
          cantUpload: z.boolean().optional(),
        }),
        suppliers: z.array(z.object({ name: z.string(), city: z.string().optional(), suburb: z.string().optional(), gstNumber: z.string().optional(), amount: z.number() })).max(4).optional(),
        evidenceFiles: z.object({ dental: z.array(z.string()).optional(), schoolUniforms: z.array(z.string()).optional(), schoolStationery: z.array(z.string()).optional() }).optional(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const data = await http.get("/rest/hardship/data", { types: args.types.join(",") });
        for (const t of args.types) {
          const e = data?.[t]?.eligibility;
          if (e !== "eligible") throw new Error(`MSD says ${t} is ${e ?? "not available"} for you right now${e === "mustCall" ? ": phone MSD" : ""}`);
          if (!args[t]) throw new Error(`give the ${t} details`);
          if (t !== "food" && !args.answers.cantUpload && !args.evidenceFiles?.[t]?.length) throw new Error(`${t} needs evidenceFiles.${t} (or answers.cantUpload: true)`);
        }
        const evidencePlan = Object.fromEntries(
          Object.entries(args.evidenceFiles ?? {})
            .filter(([, v]) => v?.length)
            .map(([t, v]) => [t, validateFiles(v!).map((f) => basename(f.path))]),
        );
        const preview = serializeHardship(args, data, evidencePlan);
        const request = { method: "POST" as const, path: "/rest/hardship", body: preview };
        const effect = `MSD will receive a hardship application for ${args.types.join(", ")} (${args.types.map((t) => nzd(args[t]?.howMuchNeed)).join(", ")} needed), loaded to card ${args.answers.chosenCard}`;
        if (!args.confirm) return dryRun(request, effect, { eligibility: data, evidenceUploads: evidencePlan });
        const evidenceIds: Record<string, string[]> = {};
        for (const [t, paths] of Object.entries(args.evidenceFiles ?? {})) {
          if (!paths?.length) continue;
          evidenceIds[t] = [];
          for (const f of validateFiles(paths)) {
            const r = await http.upload(`/rest/hardship/evidence/${t}`, [{ path: f.path, type: f.type }], { workType: "hardship" });
            evidenceIds[t].push(r?.id);
          }
        }
        const body = serializeHardship(args, data, evidenceIds);
        const response = await http.post("/rest/hardship", body);
        return result([`Submitted. ${effect}.`], { response, request: { ...request, body } });
      }),
  );
}
