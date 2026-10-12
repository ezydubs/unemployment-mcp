import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun } from "./common.js";

type Obj = Record<string, any>;

export function summarizeMedical(m: Obj): string[] {
  if (!m?.showMedicalCertificate) return ["No medical certificate on file"];
  return [
    `Medical certificate expires ${day(m.expiryDate)}${m.showExpiredBanner ? " (expired)" : m.showExpiringBanner ? " (expiring soon)" : ""}; ${m.isRenewable ? "renewable" : "not renewable"}${m.mustContactUs ? "; MSD asks you to contact them" : ""}; ${m.isReadyToWork ? "declared ready to work" : "not declared ready to work"}`,
  ];
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_medical_certificate",
    { description: "Medical certificate status: expiry, whether it is renewable or expiring, whether MSD wants contact, and whether a ready-to-work declaration has been made.", inputSchema: {} },
    () =>
      call(session, async (http) => {
        const m = await http.get("/rest/medicalCertificate");
        return result(summarizeMedical(m), m);
      }),
  );
  server.registerTool(
    "mymsd_medical_certificate_ready_to_work",
    {
      description:
        "Declare 'I am ready to work' (the medical-certificate → ready-to-work flow). This tells MSD to review your obligations and may move you to Jobseeker Support work obligations. Dry run unless confirm: true.",
      inputSchema: { confirm: z.boolean().default(false) },
    },
    ({ confirm }) =>
      call(session, async (http) => {
        const request = { method: "POST" as const, path: "/rest/medicalCertificate" };
        const effect = "MSD will record that you have declared yourself ready to work and review your obligations";
        if (!confirm) return dryRun(request, effect);
        const r = await http.post(request.path);
        return result([`Declared ready to work. ${effect}.`], { response: r, request });
      }),
  );
}
