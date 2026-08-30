# Agent Loom

Agent Loom is a local MCP server for routing multiple ChatGPT chats to multiple explicitly allowed workspaces through **one endpoint and one token**.

Agent Loom is derived from the MIT-licensed CodexPro connector. It exposes an OMP-native capability layer to ChatGPT Web, with direct workspace tools, OMP agents/skills/rules, and bounded one-shot Pi/Codex compatibility.

## Why

ChatGPT Web can inspect and edit explicitly allowed local projects without exposing the rest of the host or relying on a per-chat launcher directory. Workspace selection is isolated per MCP session and remains explicit after reconnects.

## MCP interface

### Direct ChatGPT workspace tools

ChatGPT Web is the active coding agent; Agent Loom supplies the OMP capability model instead of starting a second model process. In the default `standard` mode it can directly use:

- `read`, `write`, `edit`, and `apply_patch` for files;
- `tree`, `search`, and `view_image` for inspection;
- `bash` for workspace-scoped verification commands;
- `show_changes` for Git status and diff review;
- `omp` to load OMP-native context, skills, and agent instructions into this ChatGPT conversation;
- `agents` to inspect OMP-compatible roles and model routing;
- `task` for one-shot compatibility workers.

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

### OMP-native ChatGPT Web runtime

`omp` is a capability bridge, not a model launcher. ChatGPT Web remains the active model and continues in the same conversation. No OMP/Pi/Codex model process is started by `omp`.

After selecting a workspace, call `omp(action=status)` to verify the mode, then `omp(action=context)` once. The context includes OMP `SYSTEM.md`, project/user rules, native agents, skills, prompt templates, slash-command definitions, and the OMP-native MCP tools available under the current Agent Loom policy. The `native_tools` field is intentionally an OMP-only subset; separate `task`, `pi`, `codex`, handoff, and session tools are not included.

```json
{"action":"context","workspace_id":"ws_..."}
```

Load focused OMP instructions when needed:

```json
{"action":"skill","workspace_id":"ws_...","skill_name":"debugging"}
```

```json
{"action":"agent","workspace_id":"ws_...","agent_name":"reviewer"}
```

The loaded OMP instructions guide this ChatGPT conversation. File and shell operations still go through Agent Loom's guarded MCP tools; `write`, `edit`, and `apply_patch` follow `AGENT_LOOM_WRITE_MODE`, while `bash` follows `AGENT_LOOM_BASH_MODE`.

### `agents` and generic `task`

`agents(action=list)` discovers project `.omp/agents`, user OMP agents, and bundled roles with first-wins precedence. `agents(action=models)` reports the selected backend's model inventory and configured roles. Built-in routing uses `zai/glm-5.3-flash` for `@fast` work and `openai-codex/gpt-5.6-luna` for `@task`/`@review`; set `AGENT_LOOM_FAST_MODEL`, `AGENT_LOOM_TASK_MODEL`, or `AGENT_LOOM_REVIEW_MODEL` to override selectors.

`task(action=run)` remains the one-shot compatibility workflow for bounded read-only workers. Choose `agent=scout` or `agent=reviewer` with `mode=review` for evidence, `agent=security-reviewer` for security review, or `agent=task` for implementation planning. Native workers run read-only inside a sanitized workspace mirror; apply approved changes through Agent Loom's guarded write/edit tools. `mode=write` is rejected. `backend=auto` selects OMP first, then Pi, then Codex. The persistent supervisor enforces global `max_concurrency=1`, queues up to eight generic tasks, and starts the next queued task after completion.

Native task launch requires Linux and the `bwrap` (bubblewrap) executable; other platforms fail closed rather than run an unguarded backend. Model inventory remains separate from task launch.

```json
{"action":"run","agent":"reviewer","backend":"auto","workspace_id":"ws_...","mode":"review","task":"Review the current diff.","timeout_seconds":1200}
```

`task(action=wait)` and `task(action=status)` return structured metadata, output summary, bounded `stdout_tail`/`stderr_tail`, and the task artifact path. Each task directory contains `task.json`, `worker.json`, `stdout.log`, `stderr.log`, `result.json`, `result.md`, and the sanitized workspace mirror.

### Direct `pi` and `codex` compatibility

The `pi` and `codex` tools remain available for callers that need an explicit backend. Their actions are `run`, `wait`, `status`, and `stop`; `pi` also supports `models`. Explicit compatibility calls do not queue behind another task and return a busy error when the one-task slot is occupied.

Native tasks are read-only. `mode=write` is rejected until a guarded native write adapter exists; use Agent Loom's direct guarded write/edit tools for authorized changes. Each task exits with fresh context; no pools, forums, agent worktrees, idle dispatchers, or h5i processes are created.

```json
{"action":"run","workspace_id":"ws_...","mode":"review","model":"openai-codex/gpt-5.6-luna","task":"Review the current diff.","timeout_seconds":1200}
```

```json
{"action":"wait","task_id":"...","wait_seconds":60}
```

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
- Optional `omp` CLI, Bun, and Linux `bwrap` for the one-shot native OMP compatibility backend used by `task(action=run)`.

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
