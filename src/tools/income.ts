import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { day, nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call } from "./common.js";

type Obj = Record<string, any>;

export function summarizeIncome(income: Obj, employers: Obj): string[] {
  const names = (employers?.employers ?? []).map((e: Obj) => e.name).join(", ");
  return [
    `Income declared from ${day(income?.fromDate)}: ${nzd(income?.total)} (${income?.frequency ?? "?"}); last declaration ${nzd(income?.lastDeclarationAmount)}`,
    `Next week to declare starts ${day(income?.declareWagesStartDate)}; known employers: ${names || "none"}`,
    ...(income?.incomeDetails?.length ? [`Income details: ${income.incomeDetails.map((d: Obj) => JSON.stringify(d)).join("; ")}`] : []),
  ];
}

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
}
