# Agent Loom architecture

## Routing model

One HTTP process exposes one `/mcp` endpoint and one authentication token. Each MCP transport session owns a `WorkspaceManager`, so selected workspace state is isolated per ChatGPT chat. Stable workspace ids are SHA-256-derived from canonical real paths and can be resolved after transport reconnects. A reconnected session never silently falls back to the launcher root: it must reopen a project or pass its workspace id.

Configured allowed roots are the authority boundary. `workspace open/use` never expands it. Persistent pool lookup returns the original root, which is validated against the current server allowlist before use.

## Runtime adapters

The public `pi` and `codex` tools share one canonical pool per canonical Git root. A filesystem start lock makes `start` idempotent across concurrent MCP sessions/processes. Repeated starts reuse the pool; starting the other runtime adds workers to it rather than creating another forum or pool. `refresh` rotates one clean worker onto a fresh current-host snapshot for independent QA while retaining the canonical pool and forum; it refuses pending tasks, stopped pools, dirty content, and committed changes beyond the worker baseline. Both use the same h5i worker lifecycle:

1. create a stable h5i box/worktree;
2. attach a forum identity;
3. seed the parent worktree once;
4. start a host-owned tmux supervisor;
5. accept signed task attachments;
6. execute with the selected runtime;
7. write signed result attachments and preserve the conversation id;
8. exit after one task; idle dispatchers recycle after at most 60 seconds, and the host supervisor starts the next invocation.

Pi resumes through an explicit Pi session UUID. The host inventories `pi --list-models`; a Pi worker keeps up to eight ordered candidates and retries another provider/model after a non-zero invocation failure, while all attempts share one 20-minute task deadline. Codex captures `thread.started.thread_id` from JSONL and uses `codex exec resume` for later tasks.

## State

Private host state:

```text
~/.agent-loom/
├── pools/<workspace-hash>/<pool-id>/
└── worker-state/<pool-id>/<worker-id>/
```

Project-visible review state:

```text
<project>/.agent-loom/pools/<pool-id>/
```

Secrets are excluded from project-visible mirrors.

## Why h5i is per project

An h5i box is a worktree of a source Git repository. A single synthetic repository rooted at `$HOME` would weaken path boundaries and expose unrelated files. Agent Loom centralizes routing and metadata, not source worktrees. Cross-project coordination may use a dedicated control repository/forum remote without changing box ownership.
