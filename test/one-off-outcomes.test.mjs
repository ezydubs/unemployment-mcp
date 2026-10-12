import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYMSD_DIR = mkdtempSync(join(tmpdir(), "mymsd-outcomes-"));
const { Session } = await import("../dist/session.js");
const { register, summarizeOutcome } = await import("../dist/tools/hardship.js");

const FUNERAL = {
  id: "funeralCosts",
  type: "dropOff",
  description: "Funeral costs",
  clientRequirementGroups: [
    {
      id: null,
      description: "You’ll need to drop by your local service centre with the following",
      subtext: null,
      dueBy: null,
      clientRequirements: [
        { url: "https://www.workandincome.govt.nz/documents/forms/funeral-grant-application.pdf", urlTitle: "download it from our website", description: "a completed 'Funeral Grant' form ({{url}} or get the paper form from a service centre)" },
        { url: null, urlTitle: null, description: "if you want a form posted to you call us on {{callCentreNum}}" },
      ],
    },
  ],
  appointmentReasons: null,
};
const INQUIRY = { header: { action: "INQUIRECLIENT" }, data: { participants: [{ person: { dateOfBirth: "2000-01-01" } }] } };

test("summarizeOutcome: drop-off requirement groups as lines with placeholders filled; a non-outcome answer is named; unavailable passes through", () => {
  assert.deepEqual(summarizeOutcome(FUNERAL), [
    "Outcome funeralCosts (dropOff): Funeral costs",
    "  You’ll need to drop by your local service centre with the following",
    "    - a completed 'Funeral Grant' form (download it from our website: https://www.workandincome.govt.nz/documents/forms/funeral-grant-application.pdf or get the paper form from a service centre)",
    "    - if you want a form posted to you call us on 0800 559 009",
  ]);
  assert.deepEqual(summarizeOutcome(INQUIRY, "foodCosts"), ["Outcome foodCosts: MSD has no drop-off details for this id (it answered with a client-inquiry record instead); the catalogue's outcome type says what the site offers for it"]);
  assert.deepEqual(summarizeOutcome({ unavailable: "err.invalid_data: There was a problem with the data." }, "x"), ["Outcome x: err.invalid_data: There was a problem with the data."]);
  assert.deepEqual(summarizeOutcome(undefined), []);
});

const calls = [];
const routes = {};
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  calls.push(u.pathname + u.search);
  const h = routes[u.pathname + u.search] ?? routes[u.pathname];
  if (!h) throw new Error(`unexpected fetch ${u}`);
  return h(u, init);
};
const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
routes["/rest/session"] = json({ isAuthenticated: true, csrfToken: "c", firstName: "Test", clientNumber: "000000000", timeout: 900 });
routes["/rest/data/oneOffCosts"] = json({ oneOffCosts: [{ category: "Funerals and Tangi", isMore: false, title: "Funeral costs", outcome: { id: "funeralCosts", type: "dropOff" } }] });
routes["/rest/hardship/data?types=food"] = json({ isStpCandidate: true, count: 2, food: { eligibility: "eligible", maxAmount: 2.81, balance: 2.81 } });
routes["/rest/data/outcomes?id=funeralCosts"] = json(FUNERAL);
routes["/rest/data/outcomes?id=foodCosts"] = json(INQUIRY);

const tools = {};
const session = new Session();
session.forget();
session.addCookies([{ name: "JSESSIONID", value: "s", domain: "my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: true }]);
register({ registerTool: (name, _meta, handler) => (tools[name] = handler) }, session);
const text = (r) => r.content[0].text;
const data = (r) => JSON.parse(text(r).split("\n\n").slice(1).join("\n\n"));

test("mymsd_one_off_costs asks for an outcome only when given its id, with ?id=, and keeps the client-inquiry record out of the data", async () => {
  calls.length = 0;
  const r = await tools.mymsd_one_off_costs({ types: ["food"] });
  assert.equal(r.isError, undefined);
  assert.ok(!calls.some((c) => c.startsWith("/rest/data/outcomes")), `no outcomes request without an id: ${calls.join(",")}`);
  assert.match(text(r), /Hardship eligibility — food: eligible, up to \$2\.81/);
  assert.equal("outcome" in data(r), false);
  calls.length = 0;
  const o = await tools.mymsd_one_off_costs({ types: ["food"], outcomeId: "funeralCosts" });
  assert.equal(o.isError, undefined);
  assert.ok(calls.includes("/rest/data/outcomes?id=funeralCosts"), calls.join(","));
  assert.match(text(o), /Outcome funeralCosts \(dropOff\): Funeral costs/);
  assert.match(text(o), /drop by your local service centre/);
  assert.equal(data(o).outcome.id, "funeralCosts");
  const f = await tools.mymsd_one_off_costs({ types: ["food"], outcomeId: "foodCosts" });
  assert.match(text(f), /Outcome foodCosts: MSD has no drop-off details/);
  assert.equal(JSON.stringify(data(f).outcome).includes("dateOfBirth"), false, "the inquiry record is not echoed");
});
