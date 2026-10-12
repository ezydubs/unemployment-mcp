import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call } from "./common.js";

type Obj = Record<string, any>;

export function summarizeDebt(debt: Obj, repayments: Obj): string[] {
  const lines = [`Total owing ${nzd(debt?.total)}`];
  for (const d of debt?.debt ?? []) {
    lines.push(
      `  ${d.type}${d.description ? ` (${d.description})` : ""} from ${day(d.dateEstablished)}: ${nzd(d.originalAmount)} originally, ${nzd(d.repaidAmount)} repaid, ${nzd(d.owingAmount)} owing${d.isPreviousDebt ? " (previous debt)" : ""}`,
    );
  }
  const r: Obj[] = repayments?.repayments ?? [];
  if (r.length) {
    const latest = r[0];
    lines.push(
      `Repayments ${day(repayments.historyFromDate)} – ${day(repayments.historyToDate)}: ${nzd(repayments.totalRepayments)} in ${r.length} repayment${r.length === 1 ? "" : "s"}; latest ${day(latest.date)} ${nzd(latest.amount)} ${latest.description}`,
    );
  } else lines.push("No repayments in the history period");
  return lines;
}

const items = (section: Obj | undefined, f: (li: Obj) => string): string => (section?.lineItems ?? []).map(f).join("; ");

export function summarizeFinance(bfc: Obj): string[] {
  const lines = [`Financial information from ${day(bfc?.fromDate)}`];
  const weekly = items(bfc?.weeklyPayments, (li) => `${li.type} ${li.value}`);
  if (weekly) {
    const meta = bfc.weeklyPayments.meta;
    lines.push(`Weekly payments: ${weekly}; total ${meta?.total ?? ""}${meta?.additionalNotes?.length ? ` (${meta.additionalNotes.join("; ")})` : ""}`);
  }
  const fortnightly = items(bfc?.fortnightlyPayments, (li) => `${li.type} ${li.value}`);
  if (fortnightly) lines.push(`Fortnightly payments: ${fortnightly}`);
  const wages = items(bfc?.wages, (li) => `${li.type} ${li.value}`);
  if (wages) lines.push(`Wages: ${wages}`);
  const debts = items(bfc?.debtsWithUs, (li) => `${li.type} owing ${li.balanceOwing} of ${li.originalAmount}, repaying ${li.repaymentRate}`);
  if (debts) lines.push(`Debts with MSD: ${debts}`);
  const accom = items(bfc?.accommodationCosts, (li) => `${li.type} ${li.value}`);
  if (accom) lines.push(`Accommodation costs: ${accom}`);
  const family = items(bfc?.family, (li) => `${li.type} ${li.value}`);
  if (family) lines.push(`Family: ${family}`);
  return lines;
}

export const findCard = (data: Obj, cardNo: string): Obj | null => (data?.cards ?? []).find((c: Obj) => c.cardNo === cardNo || c.pan === cardNo) ?? null;

export function summarizeCards(data: Obj, transactions: boolean): string[] {
  const cards: Obj[] = data?.cards ?? [];
  if (!cards.length) return ["No payment cards"];
  const lines: string[] = [];
  for (const c of cards) {
    lines.push(
      `Card ${c.cardNo} (${c.status}${c.isBlocked ? ", blocked" : ""}): balance ${nzd(c.balance)} at ${day(c.valueDate)}, expires ${day(c.expiryDate)}, PIN ${c.isPinSet ? "set" : "not set"}${c.hasNewPayment ? ", new payment" : ""}`,
    );
    if (transactions) for (const t of c.transactions ?? []) lines.push(`  ${day(t.date)} ${nzd(t.amount)} ${t.description}`);
  }
  return lines;
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_debt",
    { description: "Debt owed to MSD: total, each debt with original, repaid and owing amounts, and the repayment history.", inputSchema: {} },
    () =>
      call(session, async (http) => {
        const [debt, repayments] = await Promise.all([http.get("/rest/debt"), http.get("/rest/debt/repayments")]);
        return result(summarizeDebt(debt, repayments), { debt, repayments });
      }),
  );
  server.registerTool(
    "mymsd_finance",
    {
      description:
        "'My financial information': weekly/fortnightly payments, wages and other income MSD holds, accommodation costs, family, debts, childcare and disability allowances, as MSD states them (amounts come preformatted). pdfPath saves the official PDF too.",
      inputSchema: { pdfPath: z.string().optional().describe("absolute path to save the PDF statement to") },
    },
    ({ pdfPath }) =>
      call(session, async (http) => {
        const bfc = await http.get("/rest/bfc");
        const pdf = pdfPath ? await http.download(`/rest/bfc/pdf?_=${Date.now()}`, pdfPath) : null;
        return result([...summarizeFinance(bfc), ...(pdf ? [`PDF saved to ${pdf.path}`] : [])], { ...bfc, pdf });
      }),
  );
  server.registerTool(
    "mymsd_cards",
    {
      description: "Payment cards: balance, status, expiry, whether a PIN is set; transactions: true lists each card's transactions; cardNo narrows to one card.",
      inputSchema: { transactions: z.boolean().default(false), cardNo: z.string().optional() },
    },
    ({ transactions, cardNo }) =>
      call(session, async (http) => {
        const data = await http.get(transactions ? "/rest/cards/all" : "/rest/cards/summary");
        const shown = cardNo ? { ...data, cards: (data?.cards ?? []).filter((c: Obj) => c.cardNo === cardNo || c.pan === cardNo) } : data;
        return result(summarizeCards(shown, transactions), shown);
      }),
  );
}
