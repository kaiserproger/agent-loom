#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createAgentLoomServer } from "./server.js";

const AGENT_LOOM_VERSION = "0.1.0";

function printHelp(): void {
  console.log(`Agent Loom MCP stdio server

Usage:
  agent-loom-mcp --root /path/to/repo [--allow-root /another/repo]
  agent-loom-mcp --version
  agent-loom-mcp --help

Most users should run: agent-loom start`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(AGENT_LOOM_VERSION);
    return;
  }
  if (argv.includes("--help") || argv[0] === "help") {
    printHelp();
    return;
  }

  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN ??= "1";
  const config = loadConfig();
  const server = createAgentLoomServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
