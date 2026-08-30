# Agent Loom

Agent Loom is a local MCP server for routing multiple ChatGPT chats to multiple explicitly allowed Git workspaces through **one endpoint and one token**. It also manages persistent Pi and Codex agent pools in h5i boxes.

Agent Loom is derived from the MIT-licensed CodexPro connector. The public orchestration interface and persistent agent runtime are maintained here independently.

## Why

A normal “spawn an agent” tool couples an agent's lifetime to one request. Agent Loom keeps these stable across tasks:

- h5i box and worktree;
- Pi or Codex conversation/session;
- forum identity and coordination thread;
- review checkpoint baseline.

A host-owned supervisor recycles each dispatcher every 25 minutes, below h5i's run ceiling. Individual turns are bounded to 20 minutes, and interrupted claimed tasks are blocked rather than replayed.

## MCP interface

### Direct ChatGPT workspace tools

ChatGPT Web remains a first-class coding client; persistent subagents are optional. In the default `standard` mode it can directly use:

- `read`, `write`, `edit`, and `apply_patch` for files;
- `tree`, `search`, and `view_image` for inspection;
- `bash` for workspace-scoped verification commands;
- `show_changes` for Git status and diff review.

Every tool accepts an explicit `workspace_id` or uses the workspace selected by this chat's MCP session. Default policy is `write=workspace` and `bash=safe`; trusted local deployments can opt into full Bash explicitly.

### `workspace`

Each HTTP MCP connection has its own selected workspace. Different ChatGPT chats can therefore select different projects while sharing the same server URL and token.

```json
{"action":"list"}
```

```json
{"action":"use","workspace_id":"ws_..."}
```

Actions: `list`, `discover`, `open`, `use`, `current`.

`discover` finds bounded nested Git repositories under aggregate directories. `open` also returns repository candidates when the selected directory is not itself a Git root. Direct file tools can still use that directory, but persistent Pi/Codex pools require a selected Git root because h5i forum and worktree state bind to that repository.

### `pi` and `codex`

Both tools use the same contract:

```json
{
  "action": "start",
  "root": "/absolute/path/to/project-git-root",
  "name": "feature-team",
  "agents": [
    {"id":"coder","model":"zai/glm-5.3-flash","role":"dev"},
    {"id":"reviewer","model":"openai-codex/gpt-5.6-luna","role":"reviewer"}
  ]
}
```

```json
{
  "action":"send",
  "pool":"feature-team-...",
  "agent":"coder",
  "message":"Implement the bounded task and run focused tests.",
  "wait_seconds":60
}
```

Actions: `start`, `send`, `wait`, `status`, `messages`, `checkpoint`, `stop`.

`start` requires an explicit absolute Git repository `root`; it intentionally does not trust implicit session selection because ChatGPT may reconnect its MCP transport between tool calls. `send` waits in the same MCP call by default. `messages` without a message reads the shared forum; with a message it posts to one agent or the whole pool. Pools are globally indexed by pool id and route back to their bound allowed workspace after MCP reconnects.

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

## h5i and Git layout

Do **not** run `git init` in `$HOME`.

A home-directory repository would make credentials, caches, configuration, downloads, and unrelated projects candidates for Git/h5i discovery. It also makes accidental staging or oversized h5i snapshots much more likely.

Agent Loom uses:

- the actual project repository for each h5i worktree and box;
- `~/.agent-loom/` for private runtime metadata, keys, logs, and task state;
- `<project>/.agent-loom/pools/` for reviewable non-secret pool metadata/checkpoints.

If a Git-backed global control plane is needed later, initialize a dedicated repository such as `~/.local/share/agent-loom/control`, never `$HOME` itself. h5i worktrees still belong to their source project repositories.

## Requirements

- Node.js 20+
- Git
- h5i
- tmux
- Pi and/or Codex CLI with configured authentication

## Development

```bash
npm ci
npm run build
npm run smoke
```

## Security

- One HTTP token gates the endpoint.
- Workspace roots are allowlisted before routing.
- Every agent receives a separate confined envelope key.
- Forum posts coordinate work but do not grant sandbox capabilities.
- h5i remains the execution boundary.

See [SECURITY.md](SECURITY.md) and [docs/architecture.md](docs/architecture.md).

## License

MIT. Original CodexPro copyright and license notices are retained.
