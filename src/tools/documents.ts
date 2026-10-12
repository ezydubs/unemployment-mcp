import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { result } from "../format.js";
import { mimeOf } from "../http.js";
import type { Session } from "../session.js";
import { call, dryRun } from "./common.js";

type Obj = Record<string, any>;

/** resources/constants/file-params and resources/services/file-drop */
export const FILE_RULES = {
  mime: [
    "image/jpeg",
    "image/gif",
    "image/png",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  wordExcel: [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  maxBytes: 5 * 1024 * 1024,
  maxWordExcelBytes: 512_000,
  maxFiles: 10,
};
/** The profile engine's "Upload a document" evidence types. */
export const EVIDENCE_TYPES = ["photoId", "otherId", "costs"] as const;

export function validateFiles(paths: string[]): { path: string; type: string; bytes: number }[] {
  if (!paths.length) throw new Error("give at least one file");
  if (paths.length > FILE_RULES.maxFiles) throw new Error(`MyMSD accepts at most ${FILE_RULES.maxFiles} files per upload`);
  return paths.map((path) => {
    let bytes: number;
    try {
      bytes = statSync(path).size;
    } catch {
      throw new Error(`cannot read ${basename(path)} (${path})`);
    }
    const type = mimeOf(path);
    if (!FILE_RULES.mime.includes(type) || path.toLowerCase().endsWith(".rtf")) throw new Error(`${basename(path)}: file type not accepted (JPEG, GIF, PNG, PDF, Word or Excel)`);
    if (bytes > FILE_RULES.maxBytes) throw new Error(`${basename(path)}: larger than 5 MB`);
    if (FILE_RULES.wordExcel.includes(type) && bytes > FILE_RULES.maxWordExcelBytes) throw new Error(`${basename(path)}: Word/Excel files must be under 512 KB`);
    if (type === "application/pdf") {
      const text = readFileSync(path, "latin1");
      const trailer = text.slice(text.lastIndexOf("<<"), text.lastIndexOf(">>"));
      if (trailer.includes("Encrypt")) throw new Error(`${basename(path)}: encrypted PDFs are not accepted`);
    }
    return { path, type, bytes };
  });
}

/** Inside a benefit application, identity and supporting documents go to their own endpoints (resources/constants/endpoints). */
export const uploadEndpoint = (step: "identity" | "supporting"): string => (step === "identity" ? "/rest/document/uploadIdentity" : "/rest/document/uploadSupporting");

/** The `meta-data` the sub-type service attaches to an application upload (sub-type.uploadMetadata). */
export function applicationUploadMeta(category: Obj | null | undefined, applicationReference: string) {
  if (!category?.categoryId) throw new Error("the document category could not be loaded (mymsd_applications with referenceNumber and categoryId shows what MSD knows)");
  return {
    context: category.context,
    category: category.name,
    parentCategory: category.cmsCode,
    subCategory: category.categoryId,
    workType: "GenericUpload",
    applicationReference,
  };
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_upload_document",
    {
      description:
        "Upload documents to MSD as JPEG/PNG/GIF/PDF/Word/Excel, up to 10 files, 5 MB each (Word/Excel 512 KB). Two uses: (a) 'Upload a document' from the profile — give evidenceType (photoId: government-issued photo ID, otherId: other identification, costs: proof of costs); files go up, MSD runs an OCR quality check, then the document record is submitted. " +
        "(b) Inside a benefit application — give applicationReference, categoryId (from mymsd_applications) and step (identity|supporting); files go up into that category, and you then finish the step with mymsd_application_action. Dry run unless confirm: true.",
      inputSchema: {
        files: z.array(z.string()).min(1).describe("absolute paths"),
        evidenceType: z.enum(EVIDENCE_TYPES).optional().describe("profile upload: what the files prove"),
        businessContext: z.enum(["primary", "secondary"]).optional().describe("profile upload: only for check-your-circumstances uploads"),
        applicationReference: z.string().optional().describe("application upload: the application's reference number"),
        categoryId: z.string().optional().describe('application upload: document category id, e.g. "0001" identity, "0021" supporting'),
        step: z.enum(["identity", "supporting"]).optional().describe("application upload: which step the category belongs to"),
        partner: z.boolean().default(false).describe("application upload: the partner's side of the application"),
        confirm: z.boolean().default(false),
      },
    },
    ({ files, evidenceType, businessContext, applicationReference, categoryId, step, partner, confirm }) =>
      call(session, async (http) => {
        const checked = validateFiles(files);
        const names = checked.map((f) => basename(f.path));
        if (applicationReference) {
          if (!categoryId || !step) throw new Error("an application upload needs categoryId and step (identity|supporting)");
          const raw = await http.get(`/rest/documentCategory/${partner ? "partner/" : ""}withFiles/${encodeURIComponent(applicationReference)}/${encodeURIComponent(categoryId)}`);
          const category = raw?.documentCategory ?? raw?.category ?? raw;
          const meta = applicationUploadMeta(category, applicationReference);
          const request = { method: "UPLOAD" as const, path: uploadEndpoint(step), body: { "meta-data": meta, files: names } };
          const effect = `MSD will receive ${names.length} file${names.length === 1 ? "" : "s"} for application ${applicationReference}, category ${categoryId} (${category.name}); finish the ${step} step with mymsd_application_action afterwards`;
          if (!confirm) return dryRun(request, effect, { category });
          const uploaded: { file: string; id: string; isQualityAcceptable: boolean }[] = [];
          for (const f of checked) {
            const r = await http.upload(request.path, [{ path: f.path, type: f.type }], meta);
            uploaded.push({ file: basename(f.path), id: r?.id, isQualityAcceptable: r?.isQualityAcceptable !== false });
          }
          const unreadable = uploaded.filter((u) => !u.isQualityAcceptable);
          return result([`Uploaded ${uploaded.length} file(s) into the application.${unreadable.length ? ` MSD could not read: ${unreadable.map((u) => u.file).join(", ")}` : ""}`], { uploaded, request });
        }
        if (!evidenceType) throw new Error("give evidenceType (photoId|otherId|costs), or applicationReference + categoryId + step for an application upload");
        const uploadRequest = { method: "UPLOAD" as const, path: "/rest/hardship/evidence", body: { "meta-data": { workType: "GenericUpload" }, files: names } };
        const effect = `MSD will receive ${names.length} file${names.length === 1 ? "" : "s"} as ${evidenceType} evidence and record a document submission`;
        if (!confirm) {
          return dryRun(uploadRequest, effect, {
            then: { method: "POST", path: "/rest/genericUpload/data", body: { isOnThePhoneWithMSD: true, files: { [evidenceType]: ["<file ids>"] }, ...(businessContext ? { businessContext } : {}) } },
          });
        }
        const uploaded: { file: string; id: string; isQualityAcceptable: boolean }[] = [];
        for (const f of checked) {
          const r = await http.upload("/rest/hardship/evidence", [{ path: f.path, type: f.type }], { workType: "GenericUpload" });
          uploaded.push({ file: basename(f.path), id: r?.id, isQualityAcceptable: r?.isQualityAcceptable !== false });
        }
        const unreadable = uploaded.filter((u) => !u.isQualityAcceptable);
        const body = { isOnThePhoneWithMSD: true, files: { [evidenceType]: uploaded.map((u) => u.id) }, ...(businessContext ? { businessContext } : {}) };
        const response = await http.post("/rest/genericUpload/data", body);
        return result(
          [`Uploaded ${uploaded.length} file(s) and submitted the document record.${unreadable.length ? ` MSD could not read: ${unreadable.map((u) => u.file).join(", ")}` : ""}`],
          { uploaded, response, request: { method: "POST", path: "/rest/genericUpload/data", body } },
        );
      }),
  );

  server.registerTool(
    "mymsd_document_delete",
    {
      description: "Remove a file you uploaded (its id from the upload result): scope generic for profile/hardship evidence, application for a file inside a benefit application. Dry run unless confirm: true.",
      inputSchema: { fileId: z.string(), scope: z.enum(["generic", "application"]).default("generic"), confirm: z.boolean().default(false) },
    },
    ({ fileId, scope, confirm }) =>
      call(session, async (http) => {
        const request = { method: "DELETE" as const, path: `${scope === "application" ? "/rest/document/evidence" : "/rest/hardship/evidence"}/${encodeURIComponent(fileId)}` };
        const effect = `MSD will delete uploaded file ${fileId}`;
        if (!confirm) return dryRun(request, effect);
        const response = await http.delete(request.path);
        return result([`Deleted. ${effect}.`], { response, request });
      }),
  );
}
