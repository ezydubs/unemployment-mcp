import { spawn } from "node:child_process";
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

// SMOKE_IMPORT=1 takes the sign-in from Chrome first (needed once, or after the RealMe sign-in has lapsed)
if (process.env.SMOKE_IMPORT) await tool("mymsd_auth", { action: "import_chrome" });
await tool("mymsd_auth", { action: "status" });
// READ TOOLS (added by later tasks)
await tool("mymsd_dashboard");
await tool("mymsd_profile");
await tool("mymsd_benefits", { detail: true });
await tool("mymsd_letters", { unreadOnly: false });
await tool("mymsd_debt");
await tool("mymsd_finance");
await tool("mymsd_cards", { transactions: true });
await tool("mymsd_appointments", { includeLocations: true });
await tool("mymsd_appointment_check", { reasonIds: ["changeAddress"] });
await tool("mymsd_income");
await tool("mymsd_employment_plan");
await tool("mymsd_jobs");
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
await tool("mymsd_accommodation_update", { accommodationCosts: { type: "rent", amount: 1, landlordName: "Example" }, confirm: false });
await tool("mymsd_letters_preference", { action: "post", confirm: false });
await tool("mymsd_job_search_activity", { action: "add", activityDate: "2026-10-10", employerName: "Example Ltd", role: "Cook", applicationMethod: "online", status: "applied", confirm: false });
await tool("mymsd_rjs_report", { weekCode: "2026-W41", comment: "Applied to 3 jobs", confirm: false });
await tool("mymsd_upskilling_report", { weekCode: "2026-W41", confirm: false });
await tool("mymsd_card_set_pin", { cardNo: "0", pin: "0000", confirm: false }); // expected: "no card 0" (the lookup runs before anything is sent)
await tool("mymsd_upload_document", { files: [new URL("../README.md", import.meta.url).pathname], evidenceType: "otherId", confirm: false }); // expected: "file type not accepted" (validation runs before anything is sent)
await tool("mymsd_hardship_apply", {
  types: ["food"],
  food: { whatHasHappened: "urgentBill", whyHadToPay: "power bill", howMuchPaid: 100, howMuchNeed: 50 },
  answers: { chosenCard: "0", hasIncome: true, hasAssets: false, haveAssetsChanged: false, whyNotAssets: "bills", stepsTaken: ["budgetingPlanning"], stepToTake: "reduceCosts", agreeToRepayments: true },
  confirm: false,
});

p.kill();
