import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun } from "./common.js";

type Obj = Record<string, any>;
type Phone = { countryCode: string; areaCode: string; number: string };
const EMPTY_PHONE: Phone = { countryCode: "", areaCode: "", number: "" };
const PHONE_KEYS = ["homePhone", "workPhone", "cellPhone", "fax"] as const;
const EMAIL_KEYS = ["homeEmail", "workEmail"] as const;

/** "+64 21 000 0000" / "09 123 4567" / { areaCode, number } → the site's phone object (country code defaults to 64, area codes keep their leading 0). */
export function normalizePhone(p: unknown): Phone | null {
  if (p == null || p === "") return null;
  if (typeof p === "object") {
    const o = p as Obj;
    return { countryCode: String(o.countryCode ?? "64").replace(/^\+/, ""), areaCode: String(o.areaCode ?? ""), number: String(o.number ?? "").replace(/\s/g, "") };
  }
  let digits = String(p).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("64") && digits.length > 9) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  const areaLen = digits.startsWith("2") ? 2 : 1; // mobiles 02x, landlines one digit (03, 04, 06, 07, 09)
  return { countryCode: "64", areaCode: `0${digits.slice(0, areaLen)}`, number: digits.slice(areaLen) };
}
const samePhone = (a: Phone | null, b: Obj | null | undefined) =>
  (a?.number ?? "") === (b?.number ?? "") && (a?.areaCode ?? "") === (b?.areaCode ?? "") && (a?.countryCode ?? "") === (b?.countryCode ?? "");

/** contact-info.delta(): only the keys that differ from the current contact details. */
export function contactDelta(current: Obj, changes: Obj): Obj {
  const delta: Obj = {};
  for (const k of ["preferred", "preferredEmail"] as const) if (changes[k] !== undefined && changes[k] !== current?.[k]) delta[k] = changes[k];
  for (const k of EMAIL_KEYS) if (changes[k] !== undefined && (changes[k] ?? null) !== (current?.[k] ?? null)) delta[k] = changes[k];
  for (const k of PHONE_KEYS) {
    if (changes[k] === undefined) continue;
    const next = normalizePhone(changes[k]);
    if (!samePhone(next, current?.[k])) delta[k] = next ?? EMPTY_PHONE;
  }
  return delta;
}

export interface AccommodationInput {
  residentialAddress?: Obj;
  dateOfMove?: string;
  livingSituation?: Obj;
  postalAddress?: Obj;
  postalSameAsResidential?: boolean;
  accommodationCosts?: Obj;
  homePhone?: unknown;
}

/** updater._serializeAccomodationChanges(): only the parts given; postal defaults to "same as residential". */
export function accommodationPayload(i: AccommodationInput): Obj {
  const out: Obj = {};
  const addr = (a: Obj) => ({
    id: a.id ?? null,
    line1: a.line1 ?? "",
    line2: a.line2 ?? "",
    suburb: a.suburb ?? "",
    city: a.city ?? "",
    postalCode: a.postalCode ?? "",
    country: a.country ?? "New Zealand",
    dateOfMove: a.dateOfMove ?? null,
    addressText: a.addressText ?? null,
  });
  if (i.residentialAddress) {
    out.residentialAddress = { ...addr(i.residentialAddress), dateOfMove: i.dateOfMove ?? i.residentialAddress.dateOfMove ?? null };
    const ls = i.livingSituation ?? {};
    out.livingSituation = {
      hasOtherPeopleAtAddress: !!ls.hasOtherPeopleAtAddress,
      numOtherPeopleAtAddress: Number(ls.numOtherPeopleAtAddress ?? 0),
      numPeoplePayingBoard: Number(ls.numPeoplePayingBoard ?? 0),
      numPaymentBoard: Number(ls.numPaymentBoard ?? 0),
    };
    if (i.homePhone !== undefined) out.homePhone = normalizePhone(i.homePhone) ?? EMPTY_PHONE;
  }
  if (i.postalAddress) out.postalAddress = addr(i.postalAddress);
  else if (i.residentialAddress || i.postalSameAsResidential) out.postalAddress = { isSameAsResidential: true };
  if (i.accommodationCosts) {
    const c = i.accommodationCosts;
    if (c.dateStopped) out.accommodationCosts = { dateStopped: c.dateStopped };
    else {
      if (!["rent", "board", "ownHouse"].includes(c.type)) throw new Error("accommodationCosts.type must be rent, board or ownHouse (or give dateStopped)");
      const { type, ...rest } = c;
      if (rest.landlordPhone !== undefined) rest.landlordPhone = normalizePhone(rest.landlordPhone);
      out.accommodationCosts = { [type]: rest };
    }
  }
  if (!Object.keys(out).length) throw new Error("nothing to change: give residentialAddress, postalAddress or accommodationCosts");
  return out;
}

export function postalPreferencePayload(action: "post" | "email" | "confirm_email", opts: Obj = {}): { path: string; body: Obj } {
  if (action === "confirm_email") {
    const body: Obj = { viewedConfirmEmailPrompt: true };
    if (opts.noEmailAddress) body.noEmailAddress = true;
    else if (opts.emailAddress) body.emailAddress = opts.emailAddress;
    if (opts.emailType) body.emailType = opts.emailType;
    return { path: "/rest/client/contacts/confirm-email", body };
  }
  return { path: "/rest/client/postal-preferences", body: { sendPostalMail: action === "post" } };
}

const phoneSchema = z.union([z.string(), z.object({ countryCode: z.string().optional(), areaCode: z.string(), number: z.string() }), z.null()]);
const addressSchema = z.object({
  id: z.string().optional().describe("id from mymsd_address_search"),
  line1: z.string(),
  line2: z.string().optional(),
  suburb: z.string().optional(),
  city: z.string(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  addressText: z.string().optional(),
});

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_contact_update",
    {
      description:
        "Change contact details MSD holds: emails, phones (string like '021 000 0000' or {areaCode, number}; null removes), preferred phone (homePhone|workPhone|cellPhone) and preferred email (homeEmail|workEmail). Only what differs from the current record is sent. Dry run unless confirm: true.",
      inputSchema: {
        homeEmail: z.string().email().nullable().optional(),
        workEmail: z.string().email().nullable().optional(),
        preferredEmail: z.enum(["homeEmail", "workEmail"]).optional(),
        preferred: z.enum(["homePhone", "workPhone", "cellPhone"]).optional(),
        homePhone: phoneSchema.optional(),
        workPhone: phoneSchema.optional(),
        cellPhone: phoneSchema.optional(),
        fax: phoneSchema.optional(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const client = await http.get("/rest/client");
        const delta = contactDelta(client?.contactDetails ?? {}, args);
        if (!Object.keys(delta).length) throw new Error("nothing differs from the contact details MSD already holds");
        const request = { method: "POST" as const, path: "/rest/client/contacts", body: delta };
        const effect = `MSD will update your contact details: ${Object.keys(delta).join(", ")}`;
        if (!args.confirm) return dryRun(request, effect, { current: client?.contactDetails });
        const response = await http.post(request.path, delta);
        return result([`Updated. ${effect}.`], { response, request });
      }),
  );

  server.registerTool(
    "mymsd_accommodation_update",
    {
      description:
        "Tell MSD you have moved (residentialAddress from mymsd_address_search + dateOfMove + livingSituation), changed postal address, or changed accommodation costs ({type: rent|board|ownHouse, amount, landlordName, landlordPhone, isHousingNZ, hasWaterRates, costs} or {dateStopped}). This can change Accommodation Supplement. Dry run unless confirm: true.",
      inputSchema: {
        residentialAddress: addressSchema.optional(),
        dateOfMove: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        livingSituation: z
          .object({
            hasOtherPeopleAtAddress: z.boolean(),
            numOtherPeopleAtAddress: z.number().int().min(0).default(0),
            numPeoplePayingBoard: z.number().int().min(0).default(0),
            numPaymentBoard: z.number().min(0).default(0),
          })
          .optional(),
        postalAddress: addressSchema.optional(),
        postalSameAsResidential: z.boolean().optional(),
        accommodationCosts: z.record(z.string(), z.unknown()).optional(),
        homePhone: phoneSchema.optional(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const payload = accommodationPayload(args);
        const request = { method: "POST" as const, path: "/rest/accommodation", body: payload };
        const effect = `MSD will record ${Object.keys(payload).join(", ")} changes${payload.residentialAddress ? ` (new address: ${payload.residentialAddress.line1}, ${payload.residentialAddress.city})` : ""}`;
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(request.path, payload);
        return result([`Submitted. ${effect}.`], { response, request });
      }),
  );

  server.registerTool(
    "mymsd_letters_preference",
    {
      description:
        "Letters by post or by email: action post (start posting letters), email (stop post, use the preferred email), or confirm_email (answer the 'confirm your email' prompt with emailAddress + emailType, or noEmailAddress: true). Dry run unless confirm: true.",
      inputSchema: {
        action: z.enum(["post", "email", "confirm_email"]),
        emailAddress: z.string().email().optional(),
        emailType: z.enum(["homeEmail", "workEmail"]).optional(),
        noEmailAddress: z.boolean().optional(),
        confirm: z.boolean().default(false),
      },
    },
    (args) =>
      call(session, async (http) => {
        const { path, body } = postalPreferencePayload(args.action, args);
        const request = { method: "POST" as const, path, body };
        const effect =
          args.action === "post"
            ? "MSD will start sending your letters by post"
            : args.action === "email"
              ? "MSD will stop posting letters and notify you by email"
              : "MSD will record your email confirmation for letters";
        if (!args.confirm) return dryRun(request, effect);
        const response = await http.post(path, body);
        return result([`Done. ${effect}.`], { response, request });
      }),
  );
}
