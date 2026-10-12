import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { result } from "../format.js";
import { mimeOf } from "../http.js";
import type { Session } from "../session.js";
import { call, dryRun } from "./common.js";

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

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_upload_document",
    {
      description:
        "'Upload a document' to MSD: evidence files (photoId: government-issued photo ID, otherId: other identification, costs: proof of costs) as JPEG/PNG/GIF/PDF/Word/Excel, up to 10 files, 5 MB each (Word/Excel 512 KB). " +
        "Files go up first; MSD runs an OCR quality check and reports unreadable ones; then the document record is submitted. Dry run unless confirm: true.",
      inputSchema: {
        files: z.array(z.string()).min(1).describe("absolute paths"),
        evidenceType: z.enum(EVIDENCE_TYPES),
        businessContext: z.enum(["primary", "secondary"]).optional().describe("only for check-your-circumstances uploads"),
        confirm: z.boolean().default(false),
      },
    },
    ({ files, evidenceType, businessContext, confirm }) =>
      call(session, async (http) => {
        const checked = validateFiles(files);
        const uploadRequest = { method: "UPLOAD" as const, path: "/rest/hardship/evidence", body: { "meta-data": { workType: "GenericUpload" }, files: checked.map((f) => basename(f.path)) } };
        const effect = `MSD will receive ${checked.length} file${checked.length === 1 ? "" : "s"} as ${evidenceType} evidence and record a document submission`;
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
}
