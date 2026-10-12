import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const p = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiters = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  }
});
let id = 0;
const call = (method, params) =>
  new Promise((res, rej) => {
    const n = ++id;
    waiters.set(n, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
  });
export const tool = async (name, args = {}) => {
  const t = Date.now();
  const r = await call("tools/call", { name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  console.log(`\n### ${name} ${JSON.stringify(args)} — ${Date.now() - t}ms isError=${!!r.isError}`);
  console.log(text.slice(0, 1500));
  return text;
};

await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
console.log("tools:", (await call("tools/list", {})).tools.map((t) => t.name).join(", "));

// SMOKE_IMPORT=1 takes the sign-in from Chrome first (needed once, or after the RealMe sign-in has lapsed); SMOKE_PIN=1 signs in with the stored PIN; SMOKE_ONLY=des skips the MyMSD part
if (process.env.SMOKE_ONLY !== "des") {
if (process.env.SMOKE_IMPORT) await tool("mymsd_auth", { action: "import_chrome" });
if (process.env.SMOKE_PIN) await tool("mymsd_auth", { action: "login_pin" }); // the stored PIN sign-in (mymsd-logon set)
await tool("mymsd_auth", { action: "status" });
// READ TOOLS (added by later tasks)
await tool("mymsd_dashboard");
await tool("mymsd_profile");
await tool("mymsd_benefits", { detail: true });
const letters = await tool("mymsd_letters", { unreadOnly: false });
// download one letter that is already read, so the smoke changes nothing; saved to the temp dir, never inside the repo
try {
  const list = JSON.parse(letters.split("\n\n").slice(1).join("\n\n"))?.letters ?? [];
  const read = list.find((l) => l.hasRead);
  if (read) await tool("mymsd_letter_download", { id: read.id, path: join(tmpdir(), `mymsd-smoke-letter-${read.id}.pdf`) });
  else console.log("\n### mymsd_letter_download skipped: no already-read letter to fetch");
} catch {
  console.log("\n### mymsd_letter_download skipped: letters not available");
}
await tool("mymsd_debt");
await tool("mymsd_finance");
await tool("mymsd_cards", { transactions: true });
await tool("mymsd_appointments", { includeLocations: true });
await tool("mymsd_appointment_check", { reasonIds: ["changeAddress"] });
await tool("mymsd_income");
await tool("mymsd_employment_plan");
await tool("mymsd_jobs");
await tool("mymsd_course", { courseId: "0" }); // expected: an MSD error for an unknown course (proves the path; no course id is known for this account)
await tool("mymsd_job_title_search", { query: "cook" });
await tool("mymsd_address_search", { query: "1 Queen Street" });
await tool("mymsd_one_off_costs", { types: ["food"] });
await tool("mymsd_medical_certificate");
await tool("mymsd_housing");
await tool("mymsd_applications");
await tool("mymsd_tas");
// WRITE TOOLS AS DRY RUNS (added by later tasks)
await tool("mymsd_medical_certificate_ready_to_work", { confirm: false });
await tool("mymsd_declare_wages", { weekStarting: "2026-10-05", wages: [{ employer: "Example Cafe Ltd", type: "hourly", hours: 10, hourlyRate: 25 }], confirm: false });
await tool("mymsd_declare_wages", { weekStarting: "2026-10-05", didNotWork: true, confirm: false });
await tool("mymsd_appointment_book", { reasonIds: ["changeAddress"], category: "PHONE", date: "2026-11-02 09:00", locationId: "ASMR", confirm: false });
await tool("mymsd_appointment_cancel", { appointmentId: "0", confirm: false });
await tool("mymsd_appointment_callback", { contactNumber: "0210000000", reasonIds: ["benefitReapp"], confirm: false });
await tool("mymsd_contact_update", { workEmail: "example@example.com", confirm: false });
await tool("mymsd_accommodation_update", { accommodationCosts: { type: "rent", dateChanged: "2026-10-01", landlordName: "Example", costs: [{ type: "rent", amount: 1, frequency: "weekly" }] }, confirm: false });
await tool("mymsd_letters_preference", { action: "post", confirm: false });
await tool("mymsd_job_search_activity", { action: "add", activityDate: "2026-10-10", employerName: "Example Ltd", role: "Cook", applicationMethod: "online", status: "applied", confirm: false });
await tool("mymsd_rjs_report", { weekCode: "2026-W41", comment: "Applied to 3 jobs", confirm: false });
await tool("mymsd_upskilling_report", { weekCode: "2026-W41", confirm: false });
await tool("mymsd_card_set_pin", { cardNo: "0", pin: "0000", confirm: false }); // expected: "no card 0" (the lookup runs before anything is sent)
await tool("mymsd_upload_document", { files: [new URL("../README.md", import.meta.url).pathname], evidenceType: "otherId", confirm: false }); // expected: "file type not accepted" (validation runs before anything is sent)
await tool("mymsd_document_delete", { fileId: "0", scope: "generic", confirm: false });
await tool("mymsd_hardship_apply", {
  types: ["food"],
  food: { whatHasHappened: "urgentBill", whyHadToPay: "power bill", howMuchPaid: 100, howMuchNeed: 50 },
  answers: { chosenCard: "0", hasIncome: true, hasAssets: false, haveAssetsChanged: false, whyNotAssets: "bills", stepsTaken: ["budgetingPlanning"], stepToTake: "reduceCosts", agreeToRepayments: true },
  confirm: false,
});
await tool("mymsd_housing_register_checkin", { hasRelationshipChanged: false, hasChildrenChanged: false, hasIncomeChanged: false, hasLivingSituationOrLodgingCostsChanged: false, confirm: false });
await tool("mymsd_emergency_housing_request", { contactNumber: "021 000 0000", dateOfNeed: "2026-10-20", numberOfDependents: 0, region: "Auckland", town: "Auckland", confirm: false });
await tool("mymsd_boarders_declaration", { declarationId: "0", form: {}, confirm: false });
await tool("mymsd_application_action", { action: "accept_obligations", referenceNumber: "0", confirm: false });
await tool("mymsd_tas_submit", { payload: { assets: [] }, confirm: false });
}

// DES (new.my.msd.govt.nz): the public tools need no sign-in; the rest use the DES session (SMOKE_IMPORT=1 imports it from Chrome)
if (process.env.SMOKE_IMPORT) await tool("des_auth", { action: "import_chrome" });
await tool("des_auth", { action: "status" });
await tool("des_locations", { query: "auck" });
const search = await tool("des_search", { query: "cleaner", regions: ["Auckland Region"], limit: 5 });
let firstJob = "30070041";
try {
  firstJob = JSON.parse(search.split("\n\n").slice(1).join("\n\n")).suitableVacancies?.[0]?.vacancyId ?? firstJob;
} catch {}
await tool("des_job", { id: firstJob });
await tool("des_matches", { limit: 3 });
await tool("des_profile");
await tool("des_applications");
await tool("des_apply", { id: firstJob, cv: "existing", reference: "No", confirm: false });
await tool("des_cv", {});

p.kill();
