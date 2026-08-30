# Agent Loom architecture

## Routing model

One HTTP process exposes one `/mcp` endpoint and one authentication token. Each MCP transport session owns a `WorkspaceManager`, so selected workspace state is isolated per ChatGPT chat. Stable workspace ids are SHA-256-derived from canonical real paths and can be resolved after transport reconnects. A reconnected session never silently falls back to the launcher root: it must reopen a project or pass its workspace id.

Configured allowed roots are the authority boundary. `workspace open/use` never expands it. Direct file and Bash tools resolve every path through the selected workspace and configured policy.

## Runtime scope

Agent Loom currently provides direct MCP workspace, inspection, file-editing, diff, and Bash tools. It does not start persistent Pi/Codex workers, background dispatchers, forums, worktrees, or agent pools.

The former h5i runtime was removed because an always-on fleet could retain many dispatchers and saturate the host. A future agent runtime must be designed separately and remain disabled until it has explicit lifecycle ownership, strict process and CPU budgets, observable idle shutdown, current-worktree synchronization, and deterministic cleanup.

## State

Launcher configuration and private connector state live under `~/.agent-loom/`. Project source remains in its original allowed workspace; Agent Loom does not create execution worktrees or background agent state.
