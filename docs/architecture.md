# Agent Loom architecture

## Routing model

One HTTP process exposes one `/mcp` endpoint and one authentication token. Each MCP transport session owns a `WorkspaceManager`, so selected workspace state is isolated per ChatGPT chat. Stable workspace ids are SHA-256-derived from canonical real paths and can be resolved after transport reconnects. A reconnected session never silently falls back to the launcher root: it must reopen a project or pass its workspace id.

Configured allowed roots are the authority boundary. `workspace open/use` never expands it. Direct file and Bash tools resolve every path through the selected workspace and configured policy.

## Runtime scope

Agent Loom provides direct MCP workspace, inspection, file-editing, diff, and Bash tools. The `omp` tool is a native capability bridge for ChatGPT Web: ChatGPT remains the active model runtime while Agent Loom exposes OMP's local agents, skills, rules, prompts, slash-command definitions, and tool policy in the same conversation. It never launches a second OMP/Pi/Codex model.

After workspace selection, `omp(action=context)` discovers bounded OMP context. User-level sources come from the configured OMP agent directory (`PI_CODING_AGENT_DIR` or `~/.omp/agent`); project sources come from `.omp/`, `.agent/`, and `.agents/` directories inside the selected workspace. Skill and agent bodies are loaded explicitly with `omp(action=skill)` and `omp(action=agent)`. `native_tools` reports only the OMP-native subset of the currently enabled MCP tools; separate model-compatibility, handoff, and session tools remain intentionally excluded. Direct MCP tools remain the execution surface and preserve Agent Loom's workspace, write, Bash, secret, and output guards.

The generic `task` adapter remains a one-shot compatibility workflow. It discovers OMP-style agent definitions from project `.omp/agents`, user OMP configuration, and bundled defaults. `backend=auto` selects OMP first, then Pi, then Codex. Fast roles default to GLM-5.3-Flash and implementation/review roles to GPT-5.6-Luna; environment selectors override both.

The supervisor is persisted under `~/.agent-loom/on-demand/`, enforces one active task globally, and queues at most eight generic tasks. Compatibility `pi`/`codex` calls remain explicit and reject a busy slot rather than queue. Every task has a maximum 20-minute deadline, runs at reduced OS priority, and has bounded 4 MiB stdout/stderr logs. `wait` watches the result file without polling; worker completion dispatches the next queued task. A queued task re-resolves an unavailable `auto` backend before failing.

There are no persistent agent pools, forums, execution worktrees, or h5i processes. Native compatibility tasks are review-only: on Linux they run in a bounded bubblewrap read-only mirror with a sanitized environment; `mode=write` is rejected. Each task exits with fresh context and writes OMP-compatible metadata plus `task.json`, `worker.json`, `stdout.log`, `stderr.log`, `result.json`, and `result.md` artifacts.

## State

Launcher configuration and private connector state live under `~/.agent-loom/`. OMP Web context is read on demand from the selected workspace and configured OMP agent directory; no persistent OMP model session or mirror is created. On-demand queue metadata, task artifacts, and bounded output logs live under `~/.agent-loom/on-demand/tasks/`; `active.json`, `queue.json`, and the launch lock provide cross-process coordination. Project source remains in its original allowed workspace; Agent Loom does not create execution worktrees.
