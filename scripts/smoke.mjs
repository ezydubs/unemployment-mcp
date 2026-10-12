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
// WRITE TOOLS AS DRY RUNS (added by later tasks)

p.kill();
