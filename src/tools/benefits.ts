import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call } from "./common.js";

type Obj = Record<string, any>;

export function summarizeBenefits(data: Obj, detail: boolean): string[] {
  const benefits: Obj[] = data?.benefits ?? [];
  if (!benefits.length) return ["No benefits recorded"];
  const lines: string[] = [];
  for (const b of benefits) {
    const parts = [`${nzd(b.bankPaymentAmount)} to bank`];
    if (b.cardPaymentAmount) parts.push(`${nzd(b.cardPaymentAmount)} to payment card`);
    lines.push(`${b.name} (${b.status}): next payment ${nzd(b.nextPaymentTotal)} on ${day(b.nextPaymentDate)} — ${parts.join(", ")}`);
    if (detail && b.details) {
      for (const li of b.details.benefitDetails?.lineItems ?? []) lines.push(`  ${li.name} ${nzd(li.amount)}`);
      for (const li of b.details.debtRepayments?.lineItems ?? []) lines.push(`  ${li.name} ${nzd(li.amount)} (debt repayment)`);
      const freq = b.details.benefitDetails?.paymentFrequency;
      lines.push(`  ${freq ? `paid every ${freq} days; ` : ""}total ${nzd(b.details.total)}`);
    }
  }
  return lines;
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_benefits",
    {
      description:
        "Current benefits and the next payment of each: amount to the bank and to a payment card, date, status. detail: true adds the payment's line items (benefit components and debt repayments) and the payment frequency; productId narrows to one benefit (the dashboard link /benefits/<productId>).",
      inputSchema: { detail: z.boolean().default(false), productId: z.number().int().optional() },
    },
    ({ detail, productId }) =>
      call(session, async (http) => {
        const data = await http.get(detail ? "/rest/benefits/all" : "/rest/benefits/summary");
        const filtered = productId == null ? data : { ...data, benefits: (data?.benefits ?? []).filter((b: Obj) => b.productId === productId) };
        return result(summarizeBenefits(filtered, detail), filtered);
      }),
  );
}
