#!/usr/bin/env node

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Agent Loom

One MCP endpoint for multiple workspaces and persistent Pi/Codex agents.

Usage:
  agent-loom start --root /default/repo --allow-root /another/repo
  agent-loom start --root /default/repo --allow-home
  agent-loom --root /default/repo --tunnel cloudflare

Primary MCP tools:
  workspace   list/open/use/current project routing per chat session
  pi          start/send/wait/status/messages/checkpoint/stop
  codex       start/send/wait/status/messages/checkpoint/stop

Existing connector options are accepted by the compatibility launcher.`);
  process.exit(0);
}

await import("./codexpro.mjs");
