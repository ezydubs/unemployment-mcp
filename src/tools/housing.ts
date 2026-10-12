import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun, tolerant } from "./common.js";
import { normalizePhone } from "./profile.js";

type Obj = Record<string, any>;

export function summarizeHousing(status: Obj, emergency: Obj): string[] {
  return [
    status?.unavailable ? `Housing Register: ${status.unavailable}` : `Housing Register: ${status?.alreadyCheckedIn ? "checked in" : "not checked in yet"}`,
    emergency?.unavailable ? `Emergency housing request: ${emergency.unavailable}` : `Emergency housing: ${JSON.stringify(emergency)}`,
  ];
}

export const housingRegisterPayload = (i: Obj) => ({
  hasRelationshipChanged: !!i.hasRelationshipChanged,
  hasChildrenChanged: !!i.hasChildrenChanged,
  hasIncomeChanged: !!i.hasIncomeChanged,
  hasLivingSituationOrLodgingCostsChanged: !!i.hasLivingSituationOrLodgingCostsChanged,
});
export const emergencyHousingPayload = (i: Obj) => ({
  contactNumber: normalizePhone(i.contactNumber),
  dateOfNeed: i.dateOfNeed,
  numberOfDependents: String(i.numberOfDependents ?? 0),
  region: i.region,
  town: i.town,
});

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

  server.registerTool(
    "mymsd_housing_register_checkin",
    {
      description:
        "Housing Register check-in: confirm whether your relationship, children, income or living situation/lodging costs have changed (MyMSD may first ask for the passcode MSD sent). Dry run unless confirm: true.",
      inputSchema: {
        passcode: z.string().optional(),
        hasRelationshipChanged: z.boolean(),
        hasChildrenChanged: z.boolean(),
        hasIncomeChanged: z.boolean(),
        hasLivingSituationOrLodgingCostsChanged: z.boolean(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const body = housingRegisterPayload(args);
        const request = { method: "POST" as const, path: "/rest/housing-register", body };
        const changed = Object.entries(body)
          .filter(([, v]) => v)
          .map(([k]) => k);
        const effect = `MSD will record your Housing Register check-in${changed.length ? ` with changes: ${changed.join(", ")}` : " with no changes"}`;
        if (!args.confirm) return dryRun(request, effect, args.passcode ? { first: { method: "POST", path: "/rest/housing-register/check-passcode", body: { passcode: "<passcode>" } } } : {});
        if (args.passcode) await http.post("/rest/housing-register/check-passcode", { passcode: args.passcode });
        const response = await http.post(request.path, body);
        return result([`Checked in. ${effect}.`], { response, request });
      }),
  );
  server.registerTool(
    "mymsd_emergency_housing_request",
    {
      description: "Request emergency housing (date of need, dependents, region and town, contact number). MSD phones you back. Untested on this account. Dry run unless confirm: true.",
      inputSchema: {
        contactNumber: z.string(),
        dateOfNeed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        numberOfDependents: z.number().int().min(0),
        region: z.string(),
        town: z.string(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const body = emergencyHousingPayload(args);
        const request = { method: "POST" as const, path: "/rest/emergency-housing", body };
        const effect = `MSD will record an emergency-housing request for ${args.town}, ${args.region} from ${day(args.dateOfNeed)} and phone ${args.contactNumber}`;
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(request.path, body);
        return result([`Requested. ${effect}.`], { response, request });
      }),
  );
  server.registerTool(
    "mymsd_boarders_declaration",
    {
      description:
        "Answer a 'confirm boarders or renters' declaration MSD has asked for (declarationId from the dashboard link /confirm-boarders-or-renters/<id>; form fields as the declaration shows them). Untested on this account. Dry run unless confirm: true.",
      inputSchema: { declarationId: z.string(), form: z.record(z.string(), z.unknown()), confirm: z.boolean().default(false) },
    },
    (args) =>
      call(session, async (http) => {
        const body = { declarationId: args.declarationId, ...args.form };
        const request = { method: "POST" as const, path: "/rest/confirm-boarder-or-renter-declaration", body };
        const effect = `MSD will record your boarders/renters declaration ${args.declarationId}`;
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(request.path, body);
        return result([`Declared. ${effect}.`], { response, request });
      }),
  );
}
