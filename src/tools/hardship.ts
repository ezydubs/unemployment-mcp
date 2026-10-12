import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call, tolerant } from "./common.js";

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
        const [costs, data] = await Promise.all([http.get("/rest/data/oneOffCosts"), tolerant(http.get("/rest/hardship/data", { types: types.join(",") }))]);
        return result(summarizeOneOffCosts(costs, data), { ...costs, hardship: data });
      }),
  );
}
