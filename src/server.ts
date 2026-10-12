#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "./session.js";
import * as appointments from "./tools/appointments.js";
import * as auth from "./tools/auth.js";
import * as benefits from "./tools/benefits.js";
import * as dashboard from "./tools/dashboard.js";
import * as employment from "./tools/employment.js";
import * as income from "./tools/income.js";
import * as letters from "./tools/letters.js";
import * as lookups from "./tools/lookups.js";
import * as money from "./tools/money.js";

const server = new McpServer({ name: "mymsd", version: "0.1.0" });
const session = Session.load();

for (const mod of [auth, dashboard, benefits, letters, money, appointments, income, employment, lookups]) mod.register(server, session);

async function main() {
  await server.connect(new StdioServerTransport());
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
