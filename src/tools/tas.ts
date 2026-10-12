import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { result } from "../format.js";
import type { Session } from "../session.js";
import { call, tolerant } from "./common.js";

type Obj = Record<string, any>;

export function summarizeTas(steps: Obj, data: Obj, payments: Obj): string[] {
  const list: Obj[] = steps?.reasonableSteps ?? [];
  return [
    data?.unavailable ? `Temporary Additional Support data: ${data.unavailable}` : `Temporary Additional Support data loaded (due by ${data?.dueBy ?? "n/a"})`,
    `Reasonable steps MSD lists (${list.length}): ${list.map((s) => `${s.id} ${s.title}`).join("; ")}`,
    `Accommodation payments on file: ${(payments?.accommodationPayments ?? []).length}`,
  ];
}

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
}
