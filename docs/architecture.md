# Agent Loom architecture

## Routing model

One HTTP process exposes one `/mcp` endpoint and one authentication token. Each MCP transport session owns a `WorkspaceManager`, so selected workspace state is isolated per ChatGPT chat. Stable workspace ids are SHA-256-derived from canonical real paths.

Configured allowed roots are the authority boundary. `workspace open/use` never expands it. Persistent pool lookup returns the original root, which is validated against the current server allowlist before use.

## Runtime adapters

The public `pi` and `codex` tools share the same operation schema. Both use the same h5i pool lifecycle:

1. create a stable h5i box/worktree;
2. attach a forum identity;
3. seed the parent worktree once;
4. start a host-owned tmux supervisor;
5. accept signed task attachments;
6. execute with the selected runtime;
7. write signed result attachments and preserve the conversation id;
8. recycle the dispatcher before the h5i run ceiling.

Pi resumes through an explicit Pi session UUID. Codex captures `thread.started.thread_id` from JSONL and uses `codex exec resume` for later tasks.

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
