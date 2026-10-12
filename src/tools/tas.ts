import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun, tolerant } from "./common.js";

type Obj = Record<string, any>;

export function summarizeTas(steps: Obj, data: Obj, payments: Obj): string[] {
  const list: Obj[] = steps?.reasonableSteps ?? [];
  return [
    data?.unavailable ? `Temporary Additional Support data: ${data.unavailable}` : `Temporary Additional Support data loaded (due by ${data?.dueBy ?? "n/a"})`,
    `Reasonable steps MSD lists (${list.length}): ${list.map((s) => `${s.id} ${s.title}`).join("; ")}`,
    `Accommodation payments on file: ${(payments?.accommodationPayments ?? []).length}`,
  ];
}

const TAS_KEYS = [
  "dueBy",
  "partner",
  "familyAssistance",
  "assets",
  "partnerAssets",
  "nonCashAssets",
  "healthAndDisabilityCosts",
  "partnerHealthAndDisability",
  "otherHealthAndDisability",
  "otherEssentialCosts",
  "childSupport",
  "businessExpenses",
  "landlordDetails",
  "childrenHealthAndDisability",
  "accommodationCost",
  "partnerIncome",
  "client",
  "income",
  "accommodationPayments",
  "reasonableSteps",
];

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_tas",
    {
      description:
        "Temporary Additional Support: the pre-filled TAS data when this client is eligible (403 otherwise), the 'reasonable steps' list, accommodation payments on file and other-income options. Feeds mymsd_tas_submit.",
      inputSchema: {},
    },
    () =>
      call(session, async (http) => {
        const [steps, data, payments, otherIncome] = await Promise.all([
          http.get("/rest/tas/reasonableSteps"),
          tolerant(http.get("/rest/tas/data")),
          tolerant(http.get("/rest/accommodationPayments")),
          tolerant(http.get("/rest/tas/otherIncomeProps")),
        ]);
        return result(summarizeTas(steps, data, payments), { steps, data, payments, otherIncome });
      }),
  );

  server.registerTool(
    "mymsd_tas_submit",
    {
      description:
        "Submit a Temporary Additional Support application: the payload is the TAS data from mymsd_tas with your changes (same keys: assets, healthAndDisabilityCosts, otherEssentialCosts, childSupport, businessExpenses, landlordDetails, accommodationCost, income, accommodationPayments, reasonableSteps, …). Keys the TAS model does not have are refused. Untested on this account (TAS data is 403 for it). Dry run unless confirm: true.",
      inputSchema: { payload: z.record(z.string(), z.unknown()), confirm: z.boolean().default(false) },
    },
    ({ payload, confirm }) =>
      call(session, async (http) => {
        const unknown = Object.keys(payload).filter((k) => !TAS_KEYS.includes(k));
        if (unknown.length) throw new Error(`unknown TAS keys: ${unknown.join(", ")}`);
        const request = { method: "POST" as const, path: "/rest/tas/data", body: payload };
        const effect = "MSD will receive a Temporary Additional Support application";
        if (!confirm) return dryRun(request, effect);
        const response = await http.post(request.path, payload);
        return result([`Submitted. ${effect}.`], { response, request });
      }),
  );
}
