# Agent Loom

Agent Loom is a local MCP server for routing multiple ChatGPT chats to multiple explicitly allowed workspaces through **one endpoint and one token**.

Agent Loom is derived from the MIT-licensed CodexPro connector. It currently focuses on direct, bounded workspace access. The former h5i-based persistent agent runtime was removed because its always-on worker fleet consumed unacceptable host resources; no replacement supervisor is enabled yet.

## Why

ChatGPT Web can inspect and edit explicitly allowed local projects without exposing the rest of the host or relying on a per-chat launcher directory. Workspace selection is isolated per MCP session and remains explicit after reconnects.

## MCP interface

### Direct ChatGPT workspace tools

ChatGPT Web remains a first-class coding client; persistent subagents are optional. In the default `standard` mode it can directly use:

- `read`, `write`, `edit`, and `apply_patch` for files;
- `tree`, `search`, and `view_image` for inspection;
- `bash` for workspace-scoped verification commands;
- `show_changes` for Git status and diff review.

Every file/shell tool accepts an explicit `workspace_id` or uses the workspace selected in the current MCP session. After a ChatGPT reconnect, Agent Loom deliberately refuses to fall back to the launcher root: reopen the requested project or pass its stable `workspace_id`. Default policy is `write=workspace` and `bash=safe`; trusted local deployments can opt into full Bash explicitly.

### `workspace`

Each HTTP MCP connection has its own selected workspace. Different ChatGPT chats can therefore select different projects while sharing the same server URL and token.

```json
{"action":"list"}
```

```json
{"action":"use","workspace_id":"ws_..."}
```

Actions: `list`, `discover`, `open`, `use`, `current`.

`discover` finds bounded nested Git repositories under aggregate directories. `open` also returns repository candidates when the selected directory is not itself a Git root. Direct file tools can use either a repository or an allowed aggregate directory.

## One endpoint, many projects

Add the generated MCP URL to ChatGPT as a new connector named **Agent Loom**. Do not reuse or prompt for an older CodexPro connector: connector names and cached tool schemas belong to the ChatGPT connection, not to the local command. After an upgrade that changes tools or cards, refresh or recreate the Agent Loom connector.

```bash
npm install
npm run build

AGENT_LOOM_HTTP_TOKEN='use-at-least-24-random-bytes' \
node dist/http.js \
  --root /projects/default \
  --allow-root /projects/project-a \
  --allow-root /projects/project-b
```

Connect every ChatGPT chat to:

```text
https://your-host.example/mcp?agent_loom_token=...
```

Each chat calls `workspace({"action":"use", ...})` independently. A workspace path is accepted only when it is under a configured allowed root.

## Local state

Do **not** run `git init` in `$HOME`. Agent Loom keeps launcher configuration under `~/.agent-loom/` and accesses only explicitly allowed workspace roots.

## Requirements

- Node.js 20+
- Git

## Development

```bash
npm ci
npm run build
npm run smoke
```

## Security

- One HTTP token gates the endpoint.
- Workspace roots are allowlisted before routing.
- File and Bash operations remain constrained by the configured write and Bash modes.

See [SECURITY.md](SECURITY.md) and [docs/architecture.md](docs/architecture.md).

## License

MIT. Original CodexPro copyright and license notices are retained.
