import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { result } from "../format.js";
import type { Session } from "../session.js";
import { address } from "./dashboard.js";
import { call } from "./common.js";

type Obj = Record<string, any>;

export function summarizeAddresses(list: Obj[]): string[] {
  if (!list?.length) return ["No matches"];
  return [`${list.length} match${list.length === 1 ? "" : "es"}`, ...list.map((a) => `  id ${a.id}: ${a.addressText || address(a)}`)];
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_address_search",
    {
      description: "MSD's address finder: matching NZ addresses (with the id MyMSD uses) for a street-address text of at least 7 characters. Use before mymsd_accommodation_update.",
      inputSchema: { query: z.string().min(7) },
    },
    ({ query }) =>
      call(session, async (http) => {
        const list = await http.get("/rest/address/findMatches", { line1: query });
        return result(summarizeAddresses(list), list);
      }),
  );
}
