import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isoDate, result } from "../format.js";
import type { Session } from "../session.js";
import { call, dryRun } from "./common.js";

type Obj = Record<string, any>;
type Phone = { countryCode: string; areaCode: string; number: string };
const EMPTY_PHONE: Phone = { countryCode: "", areaCode: "", number: "" };
const PHONE_KEYS = ["homePhone", "workPhone", "cellPhone", "fax"] as const;
const EMAIL_KEYS = ["homeEmail", "workEmail"] as const;

/**
 * "+64 21 000 0000" / "09 123 4567" / "0064 3 123 4567" / { areaCode, number } → the site's phone object (country code 64,
 * area codes keep their leading 0). Anything that is not recognisably a New Zealand number is refused rather than guessed.
 */
export function normalizePhone(p: unknown): Phone | null {
  if (p == null || p === "") return null;
  if (typeof p === "object") {
    const o = p as Obj;
    const number = String(o.number ?? "").replace(/\s/g, "");
    const areaCode = String(o.areaCode ?? "").replace(/\s/g, "");
    if (!/^\d{5,8}$/.test(number) || !/^0?\d{1,3}$/.test(areaCode)) throw new Error("a phone object needs areaCode and a number of 5 to 8 digits");
    return { countryCode: String(o.countryCode ?? "64").replace(/^\+/, ""), areaCode, number };
  }
  const raw = String(p).trim();
  if (!/^[\d\s()+-]+$/.test(raw)) throw new Error(`${raw} is not a phone number`);
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0064")) digits = digits.slice(4);
  else if (digits.startsWith("64") && digits.length >= 10) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  else throw new Error(`${raw}: only NZ numbers (starting 0, 64 or +64) are accepted`);
  if (digits.length < 7 || digits.length > 10) throw new Error(`${raw}: expected 7 to 10 digits after the country code`);
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

/** resources/constants/payment-periods */
export const COST_FREQUENCIES = ["weekly", "fortnightly", "fourWeekly", "monthly", "twoMonthly", "quarterly", "fourMonthly", "sixMonthly", "annually"] as const;
/** resources/constants/accommodation-costs, split the way the own-house flow does (own-house-costs excludes rent, board, other and the extra mortgages). */
const RENT_COST_TYPES = ["rent", "rentSh"];
const BOARD_COST_TYPES = ["board"];
const OWN_HOUSE_COST_TYPES = ["mortgage", "mortgage1", "houseInsurance", "rates", "mortgageInsurance", "groundLease", "waterRates", "bodyCorpFees", "regionalCouncilRates", "essentialRepairs"];
/** resources/serializers/accommodation-cost: the keys kept per cost entry in a delta */
const RENT_BOARD_COST_KEYS = ["type", "amount", "frequency", "actualPaying"];
const OWN_HOUSE_COST_KEYS = ["type", "amount", "frequency", "payee", "dateChanged", "dateStopped", "isEdited", "isNew", "hasStopped"];

/** `accommodation-cost.serialize({ delta: true })`: `{ dateStopped }`, or the changed type's record with its costs picked to the keys the site keeps. */
export function accommodationCostsDelta(c: Obj): Obj {
  if (c.dateStopped) return { dateStopped: isoDate(c.dateStopped, "accommodationCosts.dateStopped") };
  const type = c.type;
  if (!["rent", "board", "ownHouse"].includes(type)) throw new Error("accommodationCosts.type must be rent, board or ownHouse (or give dateStopped)");
  const allowedTypes = type === "rent" ? RENT_COST_TYPES : type === "board" ? BOARD_COST_TYPES : OWN_HOUSE_COST_TYPES;
  const keys = type === "ownHouse" ? OWN_HOUSE_COST_KEYS : RENT_BOARD_COST_KEYS;
  const costs: Obj[] = Array.isArray(c.costs) ? c.costs : [];
  const picked = costs.map((k, n) => {
    if (!allowedTypes.includes(k.type)) throw new Error(`accommodationCosts.costs[${n}].type must be one of ${allowedTypes.join(", ")}`);
    if (!(Number(k.amount) > 0)) throw new Error(`accommodationCosts.costs[${n}].amount must be above 0`);
    if (!COST_FREQUENCIES.includes(k.frequency)) throw new Error(`accommodationCosts.costs[${n}].frequency must be one of ${COST_FREQUENCIES.join(", ")}`);
    return Object.fromEntries(keys.filter((key) => k[key] !== undefined).map((key) => [key, k[key]]));
  });
  if (!picked.length) throw new Error("accommodationCosts.costs needs at least one cost with an amount (or give dateStopped)");
  const model: Obj = {};
  if (type !== "ownHouse") {
    if (c.landlordName !== undefined) model.landlordName = c.landlordName;
    if (c.landlordPhone !== undefined) model.landlordPhone = normalizePhone(c.landlordPhone);
    if (type === "rent" && c.isHousingNZ !== undefined) model.isHousingNZ = !!c.isHousingNZ;
  }
  model.dateChanged = c.dateChanged ? isoDate(c.dateChanged, "accommodationCosts.dateChanged") : null;
  model.costs = picked;
  return { [type]: model };
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
  const addr = (a: Obj, label: string) => ({
    id: a.id ?? null,
    line1: a.line1 ?? "",
    line2: a.line2 ?? "",
    suburb: a.suburb ?? "",
    city: a.city ?? "",
    postalCode: a.postalCode ?? "",
    country: a.country ?? "New Zealand",
    dateOfMove: a.dateOfMove ? isoDate(a.dateOfMove, `${label}.dateOfMove`) : null,
    addressText: a.addressText ?? null,
  });
  if (i.residentialAddress) {
    if (!i.livingSituation) throw new Error("a new residentialAddress needs livingSituation (whether other people live there, how many, and who pays board) — MSD records it with the move");
    out.residentialAddress = { ...addr(i.residentialAddress, "residentialAddress"), dateOfMove: i.dateOfMove ? isoDate(i.dateOfMove, "dateOfMove") : (i.residentialAddress.dateOfMove ?? null) };
    const ls = i.livingSituation;
    out.livingSituation = {
      hasOtherPeopleAtAddress: !!ls.hasOtherPeopleAtAddress,
      numOtherPeopleAtAddress: Number(ls.numOtherPeopleAtAddress ?? 0),
      numPeoplePayingBoard: Number(ls.numPeoplePayingBoard ?? 0),
      numPaymentBoard: Number(ls.numPaymentBoard ?? 0),
    };
    if (i.homePhone !== undefined) out.homePhone = normalizePhone(i.homePhone) ?? EMPTY_PHONE;
  }
  if (i.postalAddress) out.postalAddress = addr(i.postalAddress, "postalAddress");
  else if (i.residentialAddress || i.postalSameAsResidential) out.postalAddress = { isSameAsResidential: true };
  if (i.accommodationCosts) out.accommodationCosts = accommodationCostsDelta(i.accommodationCosts);
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
const costSchema = z.object({
  type: z.string().describe("rent | rentSh (social housing) | board | own-house cost: mortgage, mortgage1, houseInsurance, rates, mortgageInsurance, groundLease, waterRates, bodyCorpFees, regionalCouncilRates, essentialRepairs"),
  amount: z.number().positive(),
  frequency: z.enum(COST_FREQUENCIES),
  actualPaying: z.number().min(0).optional().describe("rent/board: the share you actually pay, when it differs"),
  payee: z.string().optional().describe("own-house costs: who is paid"),
  dateChanged: z.string().optional(),
  dateStopped: z.string().optional(),
  isEdited: z.boolean().optional(),
  isNew: z.boolean().optional(),
  hasStopped: z.boolean().optional(),
});
const accommodationCostsSchema = z.object({
  type: z.enum(["rent", "board", "ownHouse"]).optional(),
  dateStopped: z.string().optional().describe("YYYY-MM-DD: the costs stopped on this date (nothing else needed)"),
  dateChanged: z.string().optional().describe("YYYY-MM-DD: when the new costs started"),
  landlordName: z.string().optional(),
  landlordPhone: phoneSchema.optional(),
  isHousingNZ: z.boolean().optional().describe("rent: the landlord is Kāinga Ora"),
  costs: z.array(costSchema).optional(),
});

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_contact_update",
    {
      description:
        "Change contact details MSD holds: emails, phones (NZ numbers as text like '021 000 0000' or {areaCode, number}; null removes), preferred phone (homePhone|workPhone|cellPhone) and preferred email (homeEmail|workEmail). Only what differs from the current record is sent. Dry run unless confirm: true.",
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
        "Tell MSD you have moved (residentialAddress from mymsd_address_search + dateOfMove + livingSituation, all required together), changed postal address, or changed accommodation costs: " +
        "accommodationCosts {type: rent|board|ownHouse, dateChanged, landlordName, landlordPhone, isHousingNZ, costs: [{type, amount, frequency, actualPaying|payee}]} — or {dateStopped} when the costs ended. This can change Accommodation Supplement. Dry run unless confirm: true.",
      inputSchema: {
        residentialAddress: addressSchema.optional(),
        dateOfMove: z.string().optional().describe("YYYY-MM-DD"),
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
        accommodationCosts: accommodationCostsSchema.optional(),
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
