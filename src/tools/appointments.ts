import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun } from "./common.js";

type Obj = Record<string, any>;

/** Appointment reason ids the site knows (resources/constants/appointment-reasons). */
export const REASON_IDS = [
  "changeChildren",
  "changePartner",
  "changeAddress",
  "oneOffCost",
  "houseRepairs",
  "benefitReapp",
  "benefitReappFaceToFace",
  "newBusinessAccommodationSupplement",
  "newBusinessAccommodationSupplement65Plus",
  "obligationFailure",
  "workForYou",
  "workForYouReapp",
  "newBusinessWorkingAge",
  "newBusinessSuper",
  "newBusinessSuperExpress",
  "hardshipNoCard",
  "hardshipApplicationInProgress",
  "temporaryAdditionalSupport",
  "tas",
  "applyUcbOb",
  "cyc",
] as const;
export const CATEGORIES = ["FACETOFACE", "PHONE", "SEMINAR"] as const;

export function plus30Days(from = new Date().toISOString().slice(0, 10)): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

const time = (s: string | null | undefined) => (typeof s === "string" ? s.slice(11, 16) : "");

export function summarizeAppointments(data: Obj, locations?: Obj): string[] {
  const appts: Obj[] = data?.appointments ?? [];
  const lines = appts.length ? [`${appts.length} appointment${appts.length === 1 ? "" : "s"}`] : ["No appointments booked"];
  for (const a of appts) {
    const flags = [a.isCancellable && "cancellable", a.isReschedulable && "reschedulable", a.hasRescheduled && "already rescheduled once"].filter(Boolean).join(", ");
    lines.push(
      `  ${a.id}: ${day(a.date)}${a.endDate ? `–${time(a.endDate)}` : ""} ${a.category ?? ""} ${a.topic ?? a.type ?? ""}${a.personMeeting ? ` with ${a.personMeeting}` : ""}${a.location?.name ? ` at ${a.location.name}` : ""}${flags ? ` (${flags})` : ""}`,
    );
  }
  if (locations?.locations?.length) lines.push(`Locations: ${locations.locations.map((l: Obj) => `${l.id} ${l.name}`).join("; ")}`);
  return lines;
}

export function summarizeAvailability(check: Obj, availability: Obj): string[] {
  if (check?.mustCall) return ["MyMSD says to phone MSD to book this appointment (mustCall)"];
  const kinds = [check?.isPhoneAvailable && "phone", check?.isInPersonAvailable && "in-person", check?.isSeminarAvailable && "seminar"].filter(Boolean);
  const lines = [
    `${check?.limitReached ? "Appointment limit reached" : "Booking allowed"}${check?.existing ? "; an existing appointment covers this" : ""}; ${kinds.length ? `${kinds.join(" and ")} appointments available` : "no appointment types available"}`,
  ];
  for (const c of availability?.categorisedAppointments ?? []) {
    const slots: Obj[] = c.availability ?? [];
    lines.push(
      slots.length
        ? `${c.category}: ${slots.length} slots from ${day(slots[0].date)} to ${day(slots[slots.length - 1].date)}${availability.location?.name ? ` at ${availability.location.name}` : ""}`
        : `${c.category}: no slots`,
    );
  }
  return lines;
}

export interface BookInput {
  reasonIds: string[];
  category: (typeof CATEGORIES)[number];
  date: string;
  locationId: string;
  notes?: string;
  appointmentId?: string;
  clientRequirementTypes?: string[];
}

/** The `appointment/book` record as the site serialises it (flattened into the POST body). */
export function bookPayload(i: BookInput) {
  return {
    category: i.category,
    clientRequirementTypes: i.clientRequirementTypes ?? [],
    date: i.date,
    ...(i.appointmentId ? { appointmentId: i.appointmentId } : {}),
    locationId: i.locationId,
    notes: i.notes ?? "",
    reasonIds: i.reasonIds,
  };
}

/** Why the site itself would refuse to book, from GET /rest/appointments/check; null when booking is allowed. */
export function bookingBlocked(check: Obj, reschedule: boolean): string | null {
  if (check?.mustCall) return "MyMSD says to phone MSD to book this appointment (mustCall)";
  if (check?.limitReached && !(reschedule && check.existing)) return "MyMSD says the appointment limit is reached (limitReached); phone MSD";
  return null;
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_appointments",
    {
      description: "Booked appointments (date, type, topic, who with, where, whether cancellable/reschedulable) and, with includeLocations, MSD's service-centre locations.",
      inputSchema: { includeLocations: z.boolean().default(false) },
    },
    ({ includeLocations }) =>
      call(session, async (http) => {
        const [data, locations] = await Promise.all([http.get("/rest/appointments"), includeLocations ? http.get("/rest/appointments/locations") : Promise.resolve(null)]);
        return result(summarizeAppointments(data, locations ?? undefined), { ...data, locations });
      }),
  );

  server.registerTool(
    "mymsd_appointment_check",
    {
      description:
        "Before booking: whether MSD allows an appointment for the given reasons (mustCall / limitReached / existing) and the available slots per category (FACETOFACE, PHONE, SEMINAR) up to endDate (default 30 days). For rescheduling pass appointmentId instead of reasonIds. Slots feed mymsd_appointment_book.",
      inputSchema: {
        reasonIds: z.array(z.enum(REASON_IDS)).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        appointmentId: z.string().optional(),
      },
    },
    ({ reasonIds, endDate, appointmentId }) =>
      call(session, async (http) => {
        if (!appointmentId && !reasonIds?.length) throw new Error("give reasonIds (to book) or appointmentId (to reschedule)");
        const ids = reasonIds?.join(",");
        const [check, availability] = await Promise.all([
          appointmentId ? Promise.resolve({ reschedule: true }) : http.get("/rest/appointments/check", { reasonIds: ids }),
          http.get("/rest/appointments/availability", appointmentId ? { appointmentId } : { reasonIds: ids, endDate: endDate ?? plus30Days() }),
        ]);
        return result(summarizeAvailability(check, availability), { check, availability });
      }),
  );

  server.registerTool(
    "mymsd_appointment_book",
    {
      description:
        "Book an appointment with MSD (or reschedule one with appointmentId). Take date, category and locationId from mymsd_appointment_check's slots. " +
        "Runs MSD's own check first and refuses when it says to phone. Dry run unless confirm: true.",
      inputSchema: {
        reasonIds: z.array(z.enum(REASON_IDS)).min(1),
        category: z.enum(CATEGORIES),
        date: z.string().describe("slot date-time exactly as returned by mymsd_appointment_check"),
        locationId: z.string().describe("location id from the availability result"),
        notes: z.string().max(140).optional(),
        appointmentId: z.string().optional().describe("existing appointment to reschedule"),
        clientRequirementTypes: z.array(z.string()).optional(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const check = await http.get("/rest/appointments/check", { reasonIds: args.reasonIds.join(",") });
        const blocked = bookingBlocked(check, !!args.appointmentId);
        if (blocked) throw new Error(blocked);
        const payload = bookPayload(args);
        const request = { method: "POST" as const, path: "/rest/appointments/book", body: payload };
        const effect = `MSD will ${args.appointmentId ? `move appointment ${args.appointmentId} to` : "book a"} ${args.category} appointment on ${day(args.date)} at location ${args.locationId} for ${args.reasonIds.join(", ")}`;
        if (!args.confirm) return dryRun(request, effect, { check });
        const response = await http.post(request.path, payload);
        return result([`Booked. ${effect}.`], { response, request });
      }),
  );

  server.registerTool(
    "mymsd_appointment_cancel",
    {
      description: "Cancel a booked appointment (only when mymsd_appointments shows it as cancellable). Dry run unless confirm: true.",
      inputSchema: { appointmentId: z.string(), confirm: z.boolean().default(false) },
    },
    ({ appointmentId, confirm }) =>
      call(session, async (http) => {
        const request = { method: "DELETE" as const, path: `/rest/appointments/${encodeURIComponent(appointmentId)}` };
        const effect = `MSD will cancel appointment ${appointmentId}`;
        if (!confirm) return dryRun(request, effect);
        const response = await http.delete(request.path);
        return result([`Cancelled. ${effect}.`], { response, request });
      }),
  );

  server.registerTool(
    "mymsd_appointment_callback",
    {
      description: "Ask MSD to phone you back instead of booking (the benefit-reapplication call-back). Dry run unless confirm: true.",
      inputSchema: {
        contactNumber: z.string().describe("phone number to call"),
        reasonIds: z.array(z.enum(REASON_IDS)).min(1),
        locationId: z.string().optional(),
        requestAppointmentType: z.string().optional(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const payload = { contactNumber: args.contactNumber, locationId: args.locationId ?? null, reasonIds: args.reasonIds, requestAppointmentType: args.requestAppointmentType ?? null };
        const request = { method: "POST" as const, path: "/rest/appointments/callbacks", body: payload };
        const effect = `MSD will record a call-back request to ${args.contactNumber} for ${args.reasonIds.join(", ")}`;
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(request.path, payload);
        return result([`Requested. ${effect}.`], { response, request });
      }),
  );
}
