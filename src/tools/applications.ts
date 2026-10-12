import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, result } from "../format.js";
import type { Session } from "../session.js";
import { call, tolerant } from "./common.js";

type Obj = Record<string, any>;

const appLine = (label: string, a: Obj | null): string | null =>
  a
    ? `${label} application ${a.referenceNumber} from ${day(a.date)}: ${a.isProcessing ? "processing" : a.isExpiring ? "expiring" : "in progress"}${a.hasPartner ? ` (partner ${a.partnerNeedsToTakeAction ? "needs to act" : "ok"})` : ""}`
    : null;

export function summarizeApplications(data: Obj, idv: Obj, upload: Obj): string[] {
  const lines = [appLine("Working-age", data?.workingAgeApplication), appLine("Superannuation", data?.superApplication)].filter((l): l is string => !!l);
  if (!lines.length) lines.push("No application in progress");
  if (data?.workingAgeAppointment || data?.superAppointment) lines.push(`Application appointment: ${JSON.stringify(data.workingAgeAppointment ?? data.superAppointment)}`);
  lines.push(`Online identity verification allowed: ${idv?.isAllowed ?? idv?.unavailable ?? "unknown"}; document upload available: ${upload?.canUpload ?? upload?.unavailable ?? "unknown"}`);
  return lines;
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_applications",
    {
      description:
        "Benefit applications in progress (working-age or superannuation: reference, date, status, next-step flags), whether online identity verification is allowed and whether document upload is available. With referenceNumber and categoryId it also returns that document category's children/file counts and the files already uploaded (partner: true for the partner's side).",
      inputSchema: {
        referenceNumber: z.string().optional(),
        categoryId: z.string().optional().describe('e.g. "0001" identity, "0021" supporting documents'),
        partner: z.boolean().default(false),
      },
    },
    ({ referenceNumber, categoryId, partner }) =>
      call(session, async (http) => {
        const [data, idv, upload] = await Promise.all([
          http.get("/rest/applications/data"),
          tolerant(http.get("/rest/applications/identityVerificationAllowed")),
          tolerant(http.get("/rest/genericUpload/check")),
        ]);
        let documents: Obj | null = null;
        if (referenceNumber && categoryId) {
          const p = partner ? "partner/" : "";
          const [category, uploaded] = await Promise.all([
            tolerant(http.get(`/rest/documentCategory/${p}withFiles/${referenceNumber}/${categoryId}`)),
            tolerant(http.get(`/rest/document/${p}uploaded/${referenceNumber}/${categoryId}`)),
          ]);
          documents = { category, uploaded };
        }
        return result(summarizeApplications(data, idv, upload), { ...data, identityVerification: idv, upload, documents });
      }),
  );
}
