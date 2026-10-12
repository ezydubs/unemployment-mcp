import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { day, nzd, result } from "../format.js";
import type { Session } from "../session.js";
import { call, tolerant } from "./common.js";

type Obj = Record<string, any>;

export const phone = (p: Obj | null | undefined): string =>
  p && (p.number || p.areaCode) ? `+${p.countryCode || "64"} ${p.areaCode ?? ""} ${p.number ?? ""}`.replace(/\s+/g, " ").trim() : "";
export const address = (a: Obj | null | undefined): string =>
  a ? [a.line1, a.line2, a.suburb, [a.city, a.postalCode].filter(Boolean).join(" ")].filter((x) => x && String(x).trim()).join(", ") : "";
const trueFlags = (o: Obj | undefined): string[] =>
  Object.entries(o ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);

export function summarizeDashboard(d: Obj): string[] {
  const s = d.session ?? {};
  const lines = [`${s.firstName} (client ${s.clientNumber}) — last login ${day(s.lastLogin)}; status ${d.client?.trafficLightStatus ?? "unknown"}`];
  for (const b of d.benefits?.benefits ?? []) lines.push(`Next payment: ${b.name} ${nzd(b.nextPaymentTotal)} on ${day(b.nextPaymentDate)}${b.status ? ` (${b.status})` : ""}`);
  const todo = d.notifications?.notifications ?? [];
  lines.push(todo.length ? `To do (${todo.length}): ${todo.map((n: Obj) => n.title + (n.dueBy ? ` by ${day(n.dueBy)}` : "")).join("; ")}` : "To do: nothing");
  const appts = d.appointments?.appointments ?? [];
  lines.push(
    appts.length
      ? `Appointments (${appts.length}): ${appts.map((a: Obj) => `${day(a.date)} ${a.category ?? ""} — ${a.topic ?? a.type ?? ""}`.trim()).join("; ")}`
      : "Appointments: none",
  );
  lines.push(`New letters: ${d.letters?.newLetters ?? 0}`);
  const banners = d.banners?.banners ?? [];
  if (banners.length) lines.push(`Notices: ${banners.map((b: Obj) => b.title).join("; ")}`);
  if (d.cyc?.cycStatus && d.cyc.cycStatus.isApplicationComplete === false) lines.push("Check-your-circumstances application: incomplete");
  const flags = trueFlags(d.client?.flags);
  if (flags.length) lines.push(`Flags: ${flags.join(", ")}`);
  return lines;
}

export function summarizeProfile(c: Obj): string[] {
  const cd = c.contactDetails ?? {};
  const pref = (k: string) => (cd.preferred === k ? " (preferred)" : "");
  const phones = [
    ["Mobile", "cellPhone"],
    ["Home", "homePhone"],
    ["Work", "workPhone"],
  ]
    .filter(([, k]) => phone(cd[k]))
    .map(([label, k]) => `${label}: ${phone(cd[k])}${pref(k)}`);
  const emails = [
    ["homeEmail", cd.homeEmail],
    ["workEmail", cd.workEmail],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${v}${cd.preferredEmail === k ? " (preferred)" : ""}`);
  const csc = c.communityServicesCard;
  return [
    `${c.firstName} ${c.lastName}, client ${c.clientNumber}, type ${c.clientType}`,
    `${phones.join(", ") || "No phone"}; email: ${emails.join(", ") || "none"}`,
    `Residential: ${address(c.residentialAddress) || "none"}; postal: ${c.postalAddress ? address(c.postalAddress) : "same as residential"}`,
    csc ? `Community Services Card ${csc.cardNumber} valid ${day(csc.validFrom)} – ${day(csc.expiry)}${csc.isComboCard ? " (combo card)" : ""}` : "No Community Services Card",
    `Partner: ${c.partner ? `${c.partner.firstName ?? "yes"}` : "none"}; children: ${(c.children ?? []).length}`,
    `Flags: ${trueFlags(c.flags).join(", ") || "none"}`,
  ];
}

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_dashboard",
    {
      description:
        "The MyMSD dashboard in one call: who is signed in, next payment per benefit, the to-do list (notifications), upcoming appointments, new-letter count, notices, dashboard tiles, check-your-circumstances and engagement status, and the client's flags.",
      inputSchema: {},
    },
    () =>
      call(session, async (http) => {
        const [client, benefits, notifications, appointments, letters, banners, tiles, cyc, engagement] = await Promise.all([
          http.get("/rest/client"),
          http.get("/rest/benefits/summary"),
          http.get("/rest/notifications"),
          http.get("/rest/appointments"),
          http.get("/rest/letters/notification"),
          http.get("/rest/banners"),
          http.get("/rest/tiles"),
          tolerant(http.get("/rest/cyc-status")),
          tolerant(http.get("/rest/engagement-status")),
        ]);
        const data = {
          session: session.info,
          client: { flags: client?.flags, trafficLightStatus: client?.trafficLightStatus, features: client?.features },
          benefits,
          notifications,
          appointments,
          letters,
          banners,
          tiles,
          cyc,
          engagement,
        };
        return result(summarizeDashboard({ ...data, client }), data);
      }),
  );

  server.registerTool(
    "mymsd_profile",
    {
      description:
        "The signed-in client's record: name and client number, contact details with preferences, residential and postal addresses, Community Services Card, partner and children, living situation, the account's flags and enabled features.",
      inputSchema: {},
    },
    () =>
      call(session, async (http) => {
        const client = await http.get("/rest/client");
        return result(summarizeProfile(client), client);
      }),
  );
}
