#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "./session.js";
import * as auth from "./tools/auth.js";

const server = new McpServer({ name: "mymsd", version: "0.1.0" });
const session = Session.load();

for (const mod of [auth]) mod.register(server, session);

async function main() {
  await server.connect(new StdioServerTransport());
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
