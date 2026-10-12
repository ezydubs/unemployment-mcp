import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun, tolerant } from "./common.js";

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

export const APPLICATION_ACTIONS = [
  "accept_obligations",
  "jsp_pre_benefit",
  "accept_by_partner",
  "identity_verification_start",
  "identity_verification_complete",
  "complete_identity",
  "complete_supporting",
  "agree_identity",
  "agree_supporting",
] as const;

/** The request each application step makes (current-applications engine services and resources/constants/endpoints). */
export function applicationRequest(action: string, i: Obj): { method: "GET" | "POST"; path: string; body?: Obj; params?: Obj } {
  const meta = { applicationReferenceNum: i.referenceNumber, caseReference: i.caseReference };
  switch (action) {
    case "accept_obligations":
      return { method: "POST", path: "/rest/applications/acceptObligations", body: { referenceNumber: i.referenceNumber, ...(i.payload ?? {}) } };
    case "jsp_pre_benefit":
      return { method: "POST", path: "/rest/applications/jspPreBenefit", body: { referenceNumber: i.referenceNumber, ...(i.payload ?? {}) } };
    case "accept_by_partner":
      return { method: "POST", path: "/rest/applications/acceptByPartner", body: { referenceNumber: i.referenceNumber, ...(i.payload ?? {}) } };
    case "identity_verification_start":
      return { method: "GET", path: "/rest/applications/identityVerificationRequest", params: { context: i.context } };
    case "identity_verification_complete":
      return { method: "POST", path: "/rest/applications/identityVerificationResponse", body: { ...(i.payload ?? {}) } };
    case "complete_identity":
      return {
        method: "POST",
        path: "/rest/applicationStep/completeIdentity",
        body: { document: { ...meta, uploadAction: i.uploadAction, applicationIdentity: { isVerified: i.verificationType !== "NO_IDENTITY", verificationType: i.verificationType } } },
      };
    case "complete_supporting":
      return { method: "POST", path: "/rest/applicationStep/completeSupporting", body: { document: { ...meta, uploadAction: i.uploadAction } } };
    case "agree_identity":
      return { method: "POST", path: "/rest/applicationStep/agreeIdentity", body: { ...meta, isOnThePhoneWithMSD: false, ...(i.payload ?? {}) } };
    case "agree_supporting":
      return { method: "POST", path: "/rest/applicationStep/agreeSupporting", body: { ...meta, isOnThePhoneWithMSD: false, ...(i.payload ?? {}) } };
    default:
      throw new Error(`unknown action ${action}; one of ${APPLICATION_ACTIONS.join(", ")}`);
  }
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

  server.registerTool(
    "mymsd_application_action",
    {
      description:
        "Steps of a benefit application in progress: accept_obligations, jsp_pre_benefit (job-seeker profile step), accept_by_partner, identity_verification_start (returns the RealMe/DIA authUri to open; context passport|driverLicence), identity_verification_complete, " +
        "complete_identity / complete_supporting (uploadAction PROVIDED|CANNOTPROVIDE|TOTALUPLOAD|PARTIALUPLOAD|UNABLETOUPLOAD|ACCEPTBRING|CANNOTNODOCS; verificationType PASSPORT|GOVERNMENT|NO_IDENTITY|OTHER_ID), agree_identity / agree_supporting (payload: the document record, e.g. files {categoryId: [ids]}). " +
        "Untested on this account (no application in progress). Dry run unless confirm: true.",
      inputSchema: {
        action: z.enum(APPLICATION_ACTIONS),
        referenceNumber: z.string(),
        caseReference: z.string().optional(),
        context: z.string().optional(),
        uploadAction: z.string().optional(),
        verificationType: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const req = applicationRequest(args.action, args);
        const effect = `MSD will apply the application step ${args.action} to application ${args.referenceNumber}`;
        if (!args.confirm) return dryRun({ method: req.method, path: req.path, body: req.body ?? req.params }, effect);
        const response = req.method === "GET" ? await http.get(req.path, req.params) : await http.post(req.path, req.body);
        return result([`Done. ${effect}.${response?.authUri ? ` Open ${response.authUri} to verify your identity.` : ""}`], { response, request: req });
      }),
  );
}
