#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const server = new McpServer({ name: "mymsd", version: "0.1.0" });

async function main() {
  await server.connect(new StdioServerTransport());
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
