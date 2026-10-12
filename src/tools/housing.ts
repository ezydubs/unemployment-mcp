import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { result } from "../format.js";
import type { Session } from "../session.js";
import { call, tolerant } from "./common.js";

type Obj = Record<string, any>;

export function summarizeHousing(status: Obj, emergency: Obj): string[] {
  return [
    status?.unavailable ? `Housing Register: ${status.unavailable}` : `Housing Register: ${status?.alreadyCheckedIn ? "checked in" : "not checked in yet"}`,
    emergency?.unavailable ? `Emergency housing request: ${emergency.unavailable}` : `Emergency housing: ${JSON.stringify(emergency)}`,
  ];
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_housing",
    { description: "Housing: whether this client has checked in to the Housing Register, and whether an emergency-housing request is open to them.", inputSchema: {} },
    () =>
      call(session, async (http) => {
        const [status, emergency] = await Promise.all([tolerant(http.get("/rest/housing-register/status")), tolerant(http.get("/rest/emergency-housing"))]);
        return result(summarizeHousing(status, emergency), { status, emergency });
      }),
  );
}
