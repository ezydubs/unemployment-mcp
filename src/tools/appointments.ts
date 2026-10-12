import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { day, result } from "../format.js";
import type { Session } from "../session.js";
import { call } from "./common.js";

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
}
