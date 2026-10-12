import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { day, result } from "../format.js";
import type { Session } from "../session.js";
import { call } from "./common.js";

type Obj = Record<string, any>;

export const defaultLetterPath = (id: number | string): string => join(homedir(), "Downloads", `MyMSD-letter-${id}.pdf`);
const kb = (bytes: number) => `${Math.max(1, Math.round((bytes ?? 0) / 1024))} KB`;

export function summarizeLetters(data: Obj, notification: Obj): string[] {
  if (data && "lettersThrottleReached" in data) return ["MyMSD is throttling letter downloads right now; try again later"];
  const letters: Obj[] = data?.letters ?? [];
  const unread = letters.filter((l) => !l.hasRead).length;
  const lines = [
    `${letters.length} letters, ${unread} unread (MyMSD counts ${notification?.newLetters ?? 0} new)${data?.hasMore ? "; more exist than MyMSD shows (limit 200)" : ""}`,
  ];
  for (const l of letters) lines.push(`  #${l.id} ${day(l.date)} ${l.type} (${kb(l.size)})${l.hasRead ? "" : " — unread"}`);
  return lines;
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_letters",
    {
      description: "Letters MSD has sent (id, date, type, size, read/unread), newest first, plus the new-letter count. Use mymsd_letter_download with an id to get the PDF.",
      inputSchema: { unreadOnly: z.boolean().default(false) },
    },
    ({ unreadOnly }) =>
      call(session, async (http) => {
        const [data, notification] = await Promise.all([http.get("/rest/letters"), http.get("/rest/letters/notification")]);
        const shown = unreadOnly && data?.letters ? { ...data, letters: data.letters.filter((l: Obj) => !l.hasRead) } : data;
        return result(summarizeLetters(shown, notification), { ...shown, notification });
      }),
  );

  server.registerTool(
    "mymsd_letter_download",
    {
      description: "Download one letter as a PDF to a local path (default ~/Downloads/MyMSD-letter-<id>.pdf). Opening a letter is how MyMSD marks it read.",
      inputSchema: { id: z.number().int().describe("letter id from mymsd_letters"), path: z.string().optional().describe("absolute path to save to") },
    },
    ({ id, path }) =>
      call(session, async (http) => {
        const saved = await http.download(`/rest/letters/${id}`, path ?? defaultLetterPath(id));
        return result([`Saved letter #${id} to ${saved.path} (${kb(saved.bytes)}, ${saved.contentType})`], saved);
      }),
  );
}
