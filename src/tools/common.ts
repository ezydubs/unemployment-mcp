import { BotDefenceError, Http, MsdError, NotLoggedInError, NotPermittedError } from "../http.js";
import { result, type ToolResult } from "../format.js";
import type { Session } from "../session.js";

export function fail(e: unknown): ToolResult {
  let text: string;
  if (e instanceof MsdError) text = `Error: ${e.code}: ${e.message}${e.data != null ? `\n\n${JSON.stringify(e.data, null, 2)}` : ""}`;
  else if (e instanceof NotPermittedError) text = `Error: not available on this account — ${e.message}`;
  else if (e instanceof BotDefenceError) text = `Error: MyMSD bot defence — ${e.message}`;
  else text = `Error: ${e instanceof Error ? e.message : String(e)}`;
  return { isError: true, content: [{ type: "text", text }] };
}

/** Every tool body: run against a live session, map failures to tool errors. */
export const call = (session: Session, fn: (http: Http) => Promise<ToolResult>): Promise<ToolResult> => session.run(fn).catch(fail);

export interface DryRequest {
  method: "GET" | "POST" | "DELETE" | "UPLOAD";
  path: string;
  body?: unknown;
}

/** What a write tool returns without `confirm: true`. */
export function dryRun(request: DryRequest, effect: string, extra: Record<string, unknown> = {}): ToolResult {
  return result(`Dry run — nothing sent. With confirm: true, ${effect}`, { dryRun: true, request, effect, ...extra });
}

/** For read tools that aggregate several endpoints: a part this client cannot see becomes `{ unavailable }` instead of failing the whole call. */
export async function tolerant<T>(p: Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof NotPermittedError) return { unavailable: e.message };
    if (e instanceof MsdError) return { unavailable: `${e.code}: ${e.message}` };
    throw e;
  }
}
