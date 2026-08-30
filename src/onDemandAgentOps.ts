import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { minimatch } from "minimatch";
import { discoverAgentDefinitions, resolveAgentDefinition, type AgentDefinition } from "./agentDefinitions.js";
import { DEFAULT_BLOCKED_GLOBS as CONFIG_DEFAULT_BLOCKED_GLOBS } from "./config.js";
import { CodexProError, type Workspace } from "./guard.js";

export type OnDemandRuntime = "omp" | "pi" | "codex";
export type AgentBackend = "auto" | OnDemandRuntime;
export type TaskState = "queued" | "running" | "completed" | "failed" | "stopped" | "timed_out" | "stopping";

const AGENT_LOOM_HOME = process.env.AGENT_LOOM_HOME
  ? path.resolve(process.env.AGENT_LOOM_HOME)
  : path.join(os.homedir(), ".agent-loom");
const STATE_ROOT = path.join(AGENT_LOOM_HOME, "on-demand");
const TASKS_ROOT = path.join(STATE_ROOT, "tasks");
const ACTIVE_PATH = path.join(STATE_ROOT, "active.json");
const QUEUE_PATH = path.join(STATE_ROOT, "queue.json");
const LAUNCH_LOCK = path.join(STATE_ROOT, "launch.lock");
const MAX_CONCURRENCY = 1;
const MAX_QUEUE_DEPTH = 8;
const MAX_TAIL_BYTES = 24_000;
const MAX_TASK_BYTES = 100_000;
const LEASE_GRACE_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const TASK_ID_PATTERN = /^\d{14}-[a-f0-9]{8}$/;
const MAX_SANDBOX_BYTES = 256 * 1024 * 1024;
const MAX_SANDBOX_FILES = 100_000;

type ResolvedBackend = Exclude<AgentBackend, "auto">;

export interface StartOnDemandAgentOptions {
  runtime?: OnDemandRuntime;
  backend?: AgentBackend;
  agent?: string;
  mode?: "review" | "write";
  task?: string;
  model?: string;
  thinking?: "low" | "medium" | "high";
  timeout_seconds?: number;
  bash_mode?: "off" | "safe" | "full";
  blocked_globs?: string[];
  queue?: boolean;
}

export interface TaskMetadata {
  task_id: string;
  task: string;
  pid?: number;
  pid_start_time?: string;
  heartbeat_path?: string;
  runtime: OnDemandRuntime;
  backend: ResolvedBackend;
  backend_requested: AgentBackend;
  agent: string;
  mode: "review" | "write";
  workspace_id: string;
  workspace_root: string;
  model: string | null;
  thinking: "low" | "medium" | "high";
  timeout_seconds: number;
  blocked_globs: string[];
  bash_mode: "off" | "safe" | "full";
  max_concurrency: 1;
  state: TaskState;
  created_at: string;
  queued_at: string;
  started_at?: string;
  task_dir: string;
  artifact_path: string;
}

export type OnDemandStatus = Record<string, unknown>;

const RawTaskMetadataSchema = z.object({
  task_id: z.string().regex(TASK_ID_PATTERN),
  task: z.string().max(MAX_TASK_BYTES).optional(),
  pid: z.number().int().min(2).optional(),
  pid_start_time: z.string().optional(),
  heartbeat_path: z.string().optional(),
  runtime: z.enum(["omp", "pi", "codex"]).optional(),
  backend: z.enum(["omp", "pi", "codex"]).optional(),
  backend_requested: z.enum(["auto", "omp", "pi", "codex"]).optional(),
  agent: z.string().optional(),
  mode: z.enum(["review", "write"]).optional(),
  workspace_id: z.string(),
  workspace_root: z.string(),
  model: z.string().nullable().optional(),
  thinking: z.enum(["low", "medium", "high"]).optional(),
  blocked_globs: z.array(z.string().max(500)).max(200).optional(),
  timeout_seconds: z.number(),
  bash_mode: z.enum(["off", "safe", "full"]).optional(),
  max_concurrency: z.literal(1).optional(),
  state: z.enum(["queued", "running", "completed", "failed", "stopped", "timed_out", "stopping"]).optional(),
  created_at: z.string().optional(),
  queued_at: z.string().optional(),
  started_at: z.string().optional(),
  task_dir: z.string(),
  artifact_path: z.string().optional()
}).passthrough();
const ResultSchema = z.object({
  task_id: z.string().regex(TASK_ID_PATTERN),
  state: z.enum(["completed", "failed", "stopped", "timed_out"])
}).passthrough();
const QueueSchema = z.array(z.string());
const LockOwnerSchema = z.object({ pid: z.number().int().min(2), pid_start_time: z.string().optional(), created_at: z.string() });
const ChildProcessSchema = z.object({ pid: z.number().int().min(2), start_time: z.string().optional() });

type RawTaskMetadata = z.infer<typeof RawTaskMetadataSchema>;

function normalizeMetadata(raw: RawTaskMetadata): TaskMetadata {
  const backend = raw.backend ?? raw.runtime ?? "omp";
  const now = raw.created_at ?? new Date().toISOString();
  const safeTaskDir = taskDirectory(raw.task_id);
  return {
    task_id: raw.task_id,
    task: raw.task ?? "",
    ...(raw.pid === undefined ? {} : { pid: raw.pid }),
    ...(raw.pid_start_time === undefined ? {} : { pid_start_time: raw.pid_start_time }),
    ...(raw.heartbeat_path === undefined ? {} : { heartbeat_path: path.join(safeTaskDir, "heartbeat") }),
    runtime: raw.runtime ?? backend,
    backend,
    backend_requested: raw.backend_requested ?? "auto",
    mode: raw.mode ?? "review",
    agent: raw.agent ?? "task",
    workspace_id: raw.workspace_id,
    workspace_root: raw.workspace_root,
    model: raw.model ?? null,
    thinking: raw.thinking ?? "high",
    timeout_seconds: raw.timeout_seconds,
    bash_mode: raw.bash_mode ?? "safe",
    max_concurrency: 1,
    state: raw.state ?? "running",
    created_at: now,
    queued_at: raw.queued_at ?? now,
    blocked_globs: raw.blocked_globs ?? CONFIG_DEFAULT_BLOCKED_GLOBS,
    task_dir: safeTaskDir,
    artifact_path: path.join(safeTaskDir, "result.md")
  };
}


function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) < 2) return false;
  try {
    const numericPid = Number(pid);
    process.kill(numericPid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${numericPid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      return commandEnd >= 0 && stat.slice(commandEnd + 2).trim().split(/\s+/)[0] !== "Z";
    }
    return true;
  } catch {
    return false;
  }
}

function processStartToken(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      return stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks }`
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, windowsHide: true });
    const token = result.stdout?.trim();
    return result.status === 0 && token ? token : undefined;
  }
  return undefined;
}

function processIdentityMatches(pid: number, startToken?: string): boolean {
  if (!pidAlive(pid)) return false;
  if (!startToken) return true;
  return processStartToken(pid) === startToken;
}


function heartbeatIsFresh(task: TaskMetadata): boolean {
  if (!task.heartbeat_path) return false;
  try {
    return Date.now() - statSync(task.heartbeat_path).mtimeMs <= HEARTBEAT_TIMEOUT_MS;
  } catch {
    return false;
  }
}

function workerCanBeControlled(task: TaskMetadata): boolean {
  return task.pid !== undefined
    && processIdentityMatches(task.pid, task.pid_start_time)
    && (task.pid_start_time !== undefined || heartbeatIsFresh(task));
}

async function assertStableWorkspaceRoot(root: string): Promise<void> {
  if (!path.isAbsolute(root)) throw new CodexProError("Persisted workspace root must be absolute.");
  const resolved = path.resolve(root);
  const real = await fsp.realpath(resolved).catch(() => null);
  if (!real || (process.platform === "win32" ? real.toLowerCase() : real) !== (process.platform === "win32" ? resolved.toLowerCase() : resolved)) {
    throw new CodexProError("Workspace root changed or is unavailable; refusing to launch the queued agent.");
  }
  const stat = await fsp.stat(real);
  if (!stat.isDirectory()) throw new CodexProError("Persisted workspace root is not a directory.");
}

function workerIdentityMatches(task: TaskMetadata): boolean {
  return workerCanBeControlled(task) && (task.pid_start_time !== undefined || heartbeatIsFresh(task));
}
function workerTerminationIdentity(task: TaskMetadata): boolean {
  return task.pid !== undefined && task.pid_start_time !== undefined && processIdentityMatches(task.pid, task.pid_start_time);
}

function taskDirectory(taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new CodexProError(`Invalid on-demand task id: ${taskId}`);
  return path.join(TASKS_ROOT, taskId);
}

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try { return schema.parse(JSON.parse(await fsp.readFile(file, "utf8"))); } catch { return null; }
}

async function readMetadata(taskId: string): Promise<TaskMetadata | null> {
  const raw = await readJson(path.join(taskDirectory(taskId), "task.json"), RawTaskMetadataSchema);
  return raw && raw.task_id === taskId ? normalizeMetadata(raw) : null;
}


async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await fsp.rename(temporary, file);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
    if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(code)) throw error;
    await fsp.rm(file, { force: true });
    await fsp.rename(temporary, file);
  }
}

async function withLaunchLock<T>(operation: () => Promise<T>): Promise<T> {
  await fsp.mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await fsp.mkdir(LAUNCH_LOCK, { mode: 0o700 });
      await writeJsonAtomic(path.join(LAUNCH_LOCK, "owner.json"), {
        pid: process.pid,
        pid_start_time: processStartToken(process.pid),
        created_at: new Date().toISOString()
      });
      try { return await operation(); } finally { await fsp.rm(LAUNCH_LOCK, { recursive: true, force: true }); }
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
      if (code !== "EEXIST") throw error;
      const owner = await readJson(path.join(LAUNCH_LOCK, "owner.json"), LockOwnerSchema);
      const lockAge = await fsp.stat(LAUNCH_LOCK).then((stat) => Date.now() - stat.mtimeMs).catch(() => 0);
      if (owner && owner.pid_start_time !== undefined && !processIdentityMatches(owner.pid, owner.pid_start_time)) {
        await fsp.rm(LAUNCH_LOCK, { recursive: true, force: true });
        continue;
      }
      if ((!owner || owner.pid_start_time === undefined) && lockAge > LEASE_GRACE_MS) {
        await fsp.rm(LAUNCH_LOCK, { recursive: true, force: true });
        continue;
      }
      await sleep(50);
    }
  }
  throw new CodexProError("Could not acquire the on-demand task launch lock.");
}

async function readQueue(): Promise<string[]> {
  const queue = await readJson(QUEUE_PATH, QueueSchema);
  return queue?.filter((taskId) => TASK_ID_PATTERN.test(taskId)) ?? [];
}

async function writeQueue(queue: string[]): Promise<void> {
  await writeJsonAtomic(QUEUE_PATH, queue.slice(0, MAX_QUEUE_DEPTH));
}

async function taskResult(taskId: string): Promise<Record<string, unknown> | null> {
  const result = await readJson(path.join(taskDirectory(taskId), "result.json"), ResultSchema);
  return result?.task_id === taskId ? result : null;
}

function activeTaskAlive(task: TaskMetadata): boolean {
  if (task.state !== "running" || !workerIdentityMatches(task)) return false;
  if (!task.started_at) return true;
  const startedAt = Date.parse(task.started_at);
  return Number.isFinite(startedAt) && Date.now() <= startedAt + task.timeout_seconds * 1000 + LEASE_GRACE_MS;
}

function commandForBackend(backend: ResolvedBackend): string {
  if (backend === "omp") return process.env.AGENT_LOOM_OMP_COMMAND ?? "omp";
  if (backend === "pi") return process.env.AGENT_LOOM_PI_COMMAND ?? "pi";
  return process.env.AGENT_LOOM_CODEX_COMMAND ?? "codex";
}

function commandUsesShell(command: string): boolean {
  return process.platform === "win32" && (!path.isAbsolute(command) || /\.(cmd|bat)$/i.test(command));
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { shell: commandUsesShell(command), stdio: "ignore", timeout: 5_000, windowsHide: true });
  return result.status === 0;
}
function nativeSandboxAvailable(): boolean {
  if (process.platform !== "linux") return false;
  return spawnSync("bwrap", ["--version"], { stdio: "ignore", timeout: 2_000 }).status === 0;
}

function resolveBackend(options: StartOnDemandAgentOptions): ResolvedBackend {
  if (!nativeSandboxAvailable()) throw new CodexProError("Native agent workers require Linux bubblewrap sandbox support.");
  const requested = options.backend ?? (options.runtime && options.runtime !== "omp" ? options.runtime : "auto");
  if (requested !== "auto") {
    if (!commandAvailable(commandForBackend(requested))) throw new CodexProError(`Requested agent backend is unavailable: ${requested}.`);
    return requested;
  }
  for (const backend of ["omp", "pi", "codex"] as const) {
    if (commandAvailable(commandForBackend(backend))) return backend;
  }
  throw new CodexProError("No supported agent backend found. Install omp, pi, or codex, or set AGENT_LOOM_*_COMMAND.");
}

function configuredModel(role: string): string {
  if (role === "fast") return process.env.AGENT_LOOM_FAST_MODEL ?? process.env.AGENT_LOOM_MODEL_FAST ?? "zai/glm-5.3-flash";
  if (role === "review") return process.env.AGENT_LOOM_REVIEW_MODEL ?? process.env.AGENT_LOOM_MODEL_REVIEW ?? "openai-codex/gpt-5.6-luna";
  return process.env.AGENT_LOOM_TASK_MODEL ?? process.env.AGENT_LOOM_MODEL_TASK ?? "openai-codex/gpt-5.6-luna";
}
function validateModelSelector(value: string | undefined, source: string): string | undefined {
  const selected = value?.trim() || undefined;
  if (selected && !/^[A-Za-z0-9._:/@?*+-]{1,500}$/.test(selected)) throw new CodexProError(`${source} contains unsupported shell characters.`);
  return selected;
}

function resolveModel(definition: AgentDefinition, backend: ResolvedBackend, override: string | undefined): string | undefined {
  const selected = validateModelSelector(override, "model");
  if (selected) return selected;
  const configured = validateModelSelector(definition.model, "agent model");
  if (configured && !configured.startsWith("@")) return configured;
  const role = configured?.slice(1) || (definition.name === "scout" ? "fast" : definition.name === "reviewer" || definition.name === "security-reviewer" || definition.name === "designer" ? "review" : "task");
  if (configured?.startsWith("@") && !["fast", "cheap", "review", "task"].includes(role)) throw new CodexProError(`Unknown model role: ${role}`);
  if (backend === "codex") return undefined;
  return validateModelSelector(configuredModel(role === "cheap" ? "fast" : role), "configured model");
}

function selectedTools(definition: AgentDefinition, mode: "review" | "write", bashMode: "off" | "safe" | "full"): string[] {
  const available = new Set(mode === "review" ? ["read", "grep", "glob"] : ["read", "write", "edit", "grep", "glob"]);
  if (mode === "write" && bashMode !== "off") available.add("bash");
  const requested = definition.tools.length ? definition.tools.map((tool) => tool === "find" || tool === "ls" ? "glob" : tool) : [...available];
  return [...new Set(requested)].filter((tool) => available.has(tool));
}

function taskContract(definition: AgentDefinition, backend: ResolvedBackend, mode: "review" | "write", task: string): string {
  return [
    `You are the Agent Loom ${definition.name} worker running through the ${backend} backend.`,
    "This is one bounded task. Finish it and exit; do not create persistent workers, pools, forums, h5i state, commits, pushes, resets, cleans, stashes, or remote changes.",
    "Work read-only inside Agent Loom's sanitized workspace mirror; do not modify files, access paths outside the mirror, or attempt persistent processes.",
    "Inspect before acting, follow the nearest AGENTS.md/CLAUDE.md/project rules, verify the result, and report concrete files and checks.",
    `Agent role instructions: ${definition.systemPrompt}`,
    "End with RESULT=PASS, RESULT=CHANGES, or RESULT=BLOCKED.",
    "",
    "Task:",
    task
  ].join("\n");
}

function runtimeCommand(
  backend: ResolvedBackend,
  definition: AgentDefinition,
  mode: "review" | "write",
  model: string | undefined,
  thinking: "low" | "medium" | "high",
  bashMode: "off" | "safe" | "full",
  task: string
): { command: string; args: string[]; input: string } {
  const tools = selectedTools(definition, mode, bashMode);
  const prompt = taskContract(definition, backend, mode, task);
  if (backend === "omp") {
    const args = ["--no-extensions", "--mode", "json", "--print", "--no-session", "--thinking", thinking];
    if (tools.length) args.push("--tools", tools.join(","));
    if (mode === "write") args.push("--approval-mode", "yolo");
    if (model) args.push("--model", model);
    return { command: commandForBackend(backend), args, input: prompt };
  }
  if (backend === "pi") {
    const piTools = tools.map((tool) => tool === "glob" ? "find" : tool);
    const args = ["--no-extensions", "--mode", "json", "--print", "--no-session", "--tools", piTools.join(","), "--thinking", thinking];
    if (model) args.push("--model", model);
    return { command: commandForBackend(backend), args, input: prompt };
  }
  const args = ["exec", "--ephemeral", "--json", "--color", "never", "--sandbox", mode === "review" ? "read-only" : "workspace-write"];
  if (mode === "write") args.push("--approve-for-me");
  if (model) args.push("--model", model);
  args.push("-");
  return { command: commandForBackend(backend), args, input: prompt };
}

export function availableOnDemandModels(runtime: OnDemandRuntime): string[] {
  if (runtime === "codex") return [];
  if (runtime === "omp") {
    const command = commandForBackend("omp");
    const listed = spawnSync(command, ["models", "--json"], { encoding: "utf8", shell: commandUsesShell(command), timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (listed.status !== 0) throw new CodexProError(`omp models failed: ${(listed.stderr || listed.stdout || "no output").trim()}`);
    try {
      const parsed = JSON.parse(listed.stdout) as { models?: Array<{ selector?: unknown }> };
      return (parsed.models ?? []).map((model) => model.selector).filter((selector): selector is string => typeof selector === "string");
    } catch (error) {
      throw new CodexProError(`omp models returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const command = commandForBackend("pi");
  const listed = spawnSync(command, ["--list-models"], { encoding: "utf8", shell: commandUsesShell(command), timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (listed.status !== 0) throw new CodexProError(`pi --list-models failed: ${(listed.stderr || listed.stdout || "no output").trim()}`);
  return listed.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter((value) => value.includes("/")).filter((value, index, all) => all.indexOf(value) === index);
}

export function availableAgentBackends(): ResolvedBackend[] {
  if (!nativeSandboxAvailable()) return [];
  return (["omp", "pi", "codex"] as const).filter((backend) => commandAvailable(commandForBackend(backend)));
}

export function agentModelRoles(): Record<string, string> {
  return {
    fast: configuredModel("fast"),
    task: configuredModel("task"),
    review: configuredModel("review")
  };
}

export async function availableAgentDefinitions(workspaceRoot: string): Promise<{ agents: AgentDefinition[]; warnings: string[] }> {
  return discoverAgentDefinitions(workspaceRoot);
}

function createTaskMetadata(
  workspace: Workspace,
  task: string,
  definition: AgentDefinition,
  backend: ResolvedBackend,
  backendRequested: AgentBackend,
  mode: "review" | "write",
  model: string | undefined,
  thinking: "low" | "medium" | "high",
  timeoutSeconds: number,
  bashMode: "off" | "safe" | "full",
  blockedGlobs: string[]
): TaskMetadata {
  const taskId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
  const taskDir = taskDirectory(taskId);
  const now = new Date().toISOString();
  return {
    task_id: taskId,
    task,
    runtime: backend,
    backend,
    backend_requested: backendRequested,
    agent: definition.name,
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    mode,
    model: model ?? null,
    blocked_globs: blockedGlobs,
    thinking,
    timeout_seconds: timeoutSeconds,
    bash_mode: bashMode,
    max_concurrency: MAX_CONCURRENCY,
    state: "queued",
    created_at: now,
    queued_at: now,
    task_dir: taskDir,
    artifact_path: path.join(taskDir, "result.md"),
    heartbeat_path: path.join(taskDir, "heartbeat")
  };
}

function terminateProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    if (result.status !== 0) {
      try { process.kill(pid, signal); } catch {}
    }
    return;
  }
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

async function markFailed(task: TaskMetadata, error: string): Promise<void> {
  const resultPath = path.join(task.task_dir, "result.json");
  if (!(await taskResult(task.task_id))) {
    await writeJsonAtomic(resultPath, { task_id: task.task_id, state: "failed", error, finished_at: new Date().toISOString() });
  }
}
async function prepareActiveSlot(): Promise<void> {
  const active = await readJson(ACTIVE_PATH, RawTaskMetadataSchema);
  if (!active) {
    if (await fsp.access(ACTIVE_PATH).then(() => true).catch(() => false)) await fsp.rm(ACTIVE_PATH, { force: true });
    return;
  }
  const metadata = normalizeMetadata(active);
  if (activeTaskAlive(metadata)) return;
  const workerAlive = metadata.pid !== undefined && pidAlive(metadata.pid);
  const workerMatches = workerTerminationIdentity(metadata);
  if (workerAlive && !workerMatches) return;
  if (workerMatches) terminateProcessTree(metadata.pid!, "SIGKILL");
  const child = await readJson(path.join(metadata.task_dir, "child.json"), ChildProcessSchema);
  const childAlive = Boolean(child && pidAlive(child.pid));
  if (childAlive && child!.start_time === undefined) return;
  const childMatches = child && child.start_time !== undefined && processIdentityMatches(child.pid, child.start_time);
  if (childMatches) terminateProcessTree(child!.pid, "SIGKILL");
  await markFailed(metadata, "Supervisor lease expired or worker exited unexpectedly.");
  await fsp.rm(ACTIVE_PATH, { force: true });
}

async function waitForResult(file: string, seconds: number): Promise<void> {
  if (await fsp.access(file).then(() => true).catch(() => false)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let resolveWatcher: () => void = () => {};
    const promise = new Promise<void>((watcherResolve) => { resolveWatcher = watcherResolve; });
    const watcher = watch(path.dirname(file), (_event, name) => {
      if (!name || String(name) === path.basename(file)) fsp.access(file).then(() => resolveWatcher()).catch(() => {});
    });
    const timer = setTimeout(() => resolveWatcher(), seconds * 1000);
    const finish = () => {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(timer);
      resolve();
    };
    watcher.on("error", finish);
    promise.then(finish).catch(finish);
  });
}
function isWithinDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface SandboxBudget {
  bytes: number;
  files: number;
}

function blockedSandboxPath(relativePath: string, blockedGlobs: string[]): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return blockedGlobs.some((glob) => {
    try {
      return minimatch(normalized, glob, { dot: true, nocase: false, matchBase: false })
        || minimatch(path.basename(normalized), glob, { dot: true, nocase: false, matchBase: true });
    } catch {
      return true;
    }
  });
}

async function copySandboxDirectory(source: string, destination: string, relative: string, blockedGlobs: string[], budget: SandboxBudget): Promise<void> {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const sourcePath = path.join(source, entry.name);
    if (isWithinDirectory(STATE_ROOT, sourcePath) || blockedSandboxPath(childRelative, blockedGlobs) || entry.isSymbolicLink()) continue;
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copySandboxDirectory(sourcePath, destinationPath, childRelative, blockedGlobs, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fsp.stat(sourcePath);
    budget.files += 1;
    budget.bytes += stat.size;
    if (budget.files > MAX_SANDBOX_FILES || budget.bytes > MAX_SANDBOX_BYTES) {
      throw new CodexProError(`Workspace exceeds the native-agent sandbox limit (${MAX_SANDBOX_FILES} files or ${MAX_SANDBOX_BYTES} bytes).`);
    }
    await fsp.copyFile(sourcePath, destinationPath);
  }
}

async function stageWorkspace(task: TaskMetadata): Promise<string> {
  const sandboxRoot = path.join(task.task_dir, "workspace");
  await fsp.rm(sandboxRoot, { recursive: true, force: true });
  await copySandboxDirectory(task.workspace_root, sandboxRoot, "", task.blocked_globs, { bytes: 0, files: 0 });
  return sandboxRoot;
}

async function launchTask(task: TaskMetadata, bashMode: "off" | "safe" | "full"): Promise<TaskMetadata> {
  await assertStableWorkspaceRoot(task.workspace_root);
  if (!commandAvailable(commandForBackend(task.backend))) throw new CodexProError(`Agent backend became unavailable before launch: ${task.backend}.`);
  const definition = await resolveAgentDefinition(task.workspace_root, task.agent);
  const invocation = runtimeCommand(task.backend, definition, task.mode, task.model ?? undefined, task.thinking, bashMode, task.task);
  let sandboxRoot: string;
  try {
    sandboxRoot = await stageWorkspace(task);
  } catch (error) {
    await markFailed(task, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const taskDir = task.task_dir;
  const configPath = path.join(taskDir, "worker.json");
  const readyPath = path.join(taskDir, "ready.json");
  const childPath = path.join(taskDir, "child.json");
  const startPath = path.join(taskDir, "start.json");
  const resultPath = path.join(taskDir, "result.json");
  const resultMarkdownPath = task.artifact_path;
  const workerPath = fileURLToPath(new URL("./onDemandWorker.js", import.meta.url));
  const supervisorPath = fileURLToPath(new URL("./onDemandSupervisor.js", import.meta.url));
  const config = {
    taskId: task.task_id,
    command: invocation.command,
    args: invocation.args,
    shell: commandUsesShell(invocation.command),
    input: invocation.input,
    cwd: sandboxRoot,
    sandboxRoot,
    workspaceRoot: task.workspace_root,
    timeoutMs: task.timeout_seconds * 1000,
    stdoutPath: path.join(taskDir, "stdout.log"),
    stderrPath: path.join(taskDir, "stderr.log"),
    readyPath,
    startPath,
    childPath,
    resultPath,
    resultMarkdownPath,
    activePath: ACTIVE_PATH,
    supervisorPath,
    heartbeatPath: task.heartbeat_path,
    bashMode,
    taskMetadata: task
  };
  await writeJsonAtomic(configPath, config);
  if (task.heartbeat_path) await fsp.writeFile(task.heartbeat_path, "starting\n", { mode: 0o600 });
  const worker = spawn(process.execPath, [workerPath, configPath], { detached: process.platform !== "win32", stdio: "ignore", cwd: taskDir, windowsHide: true });
  const spawnError = await new Promise<Error | null>((resolve) => {
    worker.once("error", resolve);
    worker.once("spawn", () => resolve(null));
  });
  if (spawnError || !worker.pid) {
    const message = spawnError?.message ?? "Failed to start on-demand worker.";
    await markFailed(task, message);
    throw new CodexProError(message);
  }
  const pidStartTime = processStartToken(worker.pid);
  const running: TaskMetadata = {
    ...task,
    pid: worker.pid,
    ...(pidStartTime === undefined ? {} : { pid_start_time: pidStartTime }),
    state: "running",
    started_at: new Date().toISOString()
  };
  try {
    await writeJsonAtomic(path.join(taskDir, "task.json"), running);
    await writeJsonAtomic(ACTIVE_PATH, running);
    await waitForResult(readyPath, 5);
    const ready = await fsp.access(readyPath).then(() => true).catch(() => false);
    if (!ready) throw new CodexProError("On-demand worker did not become ready.");
    await writeJsonAtomic(startPath, { task_id: task.task_id, started_at: new Date().toISOString() });
    worker.unref();
    return running;
  } catch (error) {
    if (processIdentityMatches(worker.pid, running.pid_start_time)) terminateProcessTree(worker.pid, "SIGKILL");
    await markFailed(running, error instanceof Error ? error.message : String(error));
    const current = await readJson(ACTIVE_PATH, RawTaskMetadataSchema);
    if (!current || current.task_id === task.task_id) await fsp.rm(ACTIVE_PATH, { force: true });
    throw error;
  }
}
export async function startOnDemandAgent(workspace: Workspace, options: StartOnDemandAgentOptions): Promise<TaskMetadata> {
  const task = String(options.task ?? "").trim();
  if (!task) throw new CodexProError("task is required for action=run.");
  if (options.mode === "write") {
    throw new CodexProError("mode=write requires a guarded native worker; Agent Loom native workers are read-only to preserve PathGuard and Bash session guarantees.");
  }
  if (task.length > MAX_TASK_BYTES) throw new CodexProError(`task exceeds the ${MAX_TASK_BYTES}-character limit.`);
  const definition = await resolveAgentDefinition(workspace.root, options.agent ?? "task");
  const backend = resolveBackend(options);
  const mode = options.mode ?? "review";
  const thinking = options.thinking ?? definition.thinking ?? "high";
  const timeoutSeconds = Math.max(30, Math.min(1200, Number(options.timeout_seconds ?? 1200) || 1200));
  const bashMode = options.bash_mode ?? "safe";
  const blockedGlobs = [...new Set((options.blocked_globs ?? CONFIG_DEFAULT_BLOCKED_GLOBS).filter((glob): glob is string => typeof glob === "string" && glob.length <= 500))].slice(0, 200);
  const model = options.model?.trim() ? resolveModel(definition, backend, options.model) : options.runtime ? undefined : resolveModel(definition, backend, undefined);
  const backendRequested = options.backend ?? (options.runtime && options.runtime !== "omp" ? options.runtime : "auto");
  const metadata = createTaskMetadata(workspace, task, definition, backend, backendRequested, mode, model, thinking, timeoutSeconds, bashMode, blockedGlobs);
  return withLaunchLock(async () => {
    await prepareActiveSlot();
    if (!(await readJson(ACTIVE_PATH, RawTaskMetadataSchema))) await dispatchNextLocked(bashMode);
    const active = await readJson(ACTIVE_PATH, RawTaskMetadataSchema);
    if (active) {
      const activeMetadata = normalizeMetadata(active);
      if (activeTaskAlive(activeMetadata)) {
        if (options.queue === false) throw new CodexProError("Agent task slot is busy; global max_concurrency is 1.");
        const queue = await readQueue();
        if (queue.length >= MAX_QUEUE_DEPTH) throw new CodexProError(`Agent task queue is full (max ${MAX_QUEUE_DEPTH}).`);
        await fsp.mkdir(metadata.task_dir, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(path.join(metadata.task_dir, "task.json"), metadata);
        queue.push(metadata.task_id);
        await writeQueue(queue);
        return { ...metadata, queue_position: queue.length } as TaskMetadata & { queue_position: number };
      }
    }
    await fsp.mkdir(metadata.task_dir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path.join(metadata.task_dir, "task.json"), metadata);
    return launchTask(metadata, bashMode);
  });
}

async function dispatchNextLocked(bashMode: "off" | "safe" | "full"): Promise<TaskMetadata | null> {
  await prepareActiveSlot();
  if (await readJson(ACTIVE_PATH, RawTaskMetadataSchema)) return null;
  const queue = await readQueue();
  while (queue.length) {
    const taskId = queue.shift()!;
    const task = await readMetadata(taskId);
    if (!task || await taskResult(taskId)) continue;
    await writeQueue(queue);
    try {
      return await launchTask(task, task.bash_mode ?? bashMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (task.backend_requested === "auto") {
        let fallback: ResolvedBackend | undefined;
        try { fallback = resolveBackend({ backend: "auto" }); } catch {}
        if (fallback && fallback !== task.backend) {
          await fsp.rm(path.join(task.task_dir, "result.json"), { force: true });
          await fsp.rm(task.artifact_path, { force: true });
          const { pid: _pid, pid_start_time: _pidStartTime, started_at: _startedAt, ...queuedTask } = task;
          const retry = { ...queuedTask, runtime: fallback, backend: fallback, state: "queued" as const };
          await writeJsonAtomic(path.join(task.task_dir, "task.json"), retry);
          try {
            return await launchTask(retry, retry.bash_mode ?? bashMode);
          } catch (retryError) {
            await markFailed(retry, retryError instanceof Error ? retryError.message : String(retryError));
            continue;
          }
        }
      }
      await markFailed(task, message);
    }
  }
  await writeQueue(queue);
  return null;
}

export async function dispatchNextOnDemandAgent(bashMode: "off" | "safe" | "full" = "safe"): Promise<TaskMetadata | null> {
  return withLaunchLock(() => dispatchNextLocked(bashMode));
}
async function statusForMetadata(metadata: TaskMetadata): Promise<OnDemandStatus> {
  const result = await taskResult(metadata.task_id);
  if (result) return { ...metadata, ...result, stdout_tail: await tail(path.join(metadata.task_dir, "stdout.log")), stderr_tail: await tail(path.join(metadata.task_dir, "stderr.log")) };
  const state = metadata.state === "queued" ? "queued" : metadata.state === "stopping" ? "stopping" : activeTaskAlive(metadata) ? "running" : "failed";
  return { ...metadata, state, stdout_tail: await tail(path.join(metadata.task_dir, "stdout.log")), stderr_tail: await tail(path.join(metadata.task_dir, "stderr.log")) };
}

async function tail(file: string): Promise<string> {
  try {
    const handle = await fsp.open(file, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, MAX_TAIL_BYTES);
      const bytes = Buffer.allocUnsafe(length);
      await handle.read(bytes, 0, length, stat.size - length);
      return bytes.toString("utf8");
    } finally { await handle.close(); }
  } catch { return ""; }
}

export async function onDemandAgentStatus(taskId?: string): Promise<OnDemandStatus> {
  const existingActive = await readJson(ACTIVE_PATH, RawTaskMetadataSchema);
  if (!existingActive || !activeTaskAlive(normalizeMetadata(existingActive))) await dispatchNextOnDemandAgent().catch(() => null);
  const active = await readJson(ACTIVE_PATH, RawTaskMetadataSchema);
  if (taskId) {
    const metadata = await readMetadata(taskId);
    if (!metadata) throw new CodexProError(`Unknown on-demand task: ${taskId}`);
    const queue = await readQueue();
    return { ...(await statusForMetadata(metadata)), ...(metadata.state === "queued" ? { queue_position: queue.indexOf(taskId) + 1 } : {}) };
  }
  const queue = await readQueue();
  if (active) return { ...(await statusForMetadata(normalizeMetadata(active))), queued: queue, max_concurrency: MAX_CONCURRENCY };
  return { state: queue.length ? "queued" : "idle", active: null, queued: queue, max_concurrency: MAX_CONCURRENCY };
}

export async function waitOnDemandAgent(taskId: string, seconds: number): Promise<OnDemandStatus> {
  const taskDir = taskDirectory(taskId);
  if (!(await readMetadata(taskId))) throw new CodexProError(`Unknown on-demand task: ${taskId}`);
  await waitForResult(path.join(taskDir, "result.json"), Math.max(0, Math.min(60, seconds)));
  return onDemandAgentStatus(taskId);
}

async function waitForPids(pids: number[], milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline && pids.some((pid) => pidAlive(pid))) await sleep(50);
}

export async function stopOnDemandAgent(taskId?: string): Promise<OnDemandStatus> {
  return withLaunchLock(async () => {
  await prepareActiveSlot();
  const activeRaw = await readJson(ACTIVE_PATH, RawTaskMetadataSchema);
  const queue = await readQueue();
  if (!activeRaw) {
    if (!taskId) return { state: queue.length ? "queued" : "idle", stopped: false, queued: queue };
    if (!queue.includes(taskId)) throw new CodexProError(`Task ${taskId} is not active or queued.`);
    const remaining = queue.filter((queuedTaskId) => queuedTaskId !== taskId);
    await writeQueue(remaining);
    const task = await readMetadata(taskId);
    if (task) await writeJsonAtomic(path.join(task.task_dir, "result.json"), { task_id: taskId, state: "stopped", stopped_at: new Date().toISOString() });
    return { task_id: taskId, state: "stopped", stopped: true };
  }
  const active = normalizeMetadata(activeRaw);
  if (taskId && active.task_id !== taskId) {
    if (queue.includes(taskId)) {
      await writeQueue(queue.filter((queuedTaskId) => queuedTaskId !== taskId));
      const task = await readMetadata(taskId);
      if (task) await writeJsonAtomic(path.join(task.task_dir, "result.json"), { task_id: taskId, state: "stopped", stopped_at: new Date().toISOString() });
      return { task_id: taskId, state: "stopped", stopped: true };
    }
    throw new CodexProError(`Task ${taskId} is not the active task.`);
  }
  const child = await readJson(path.join(active.task_dir, "child.json"), ChildProcessSchema);
  const workerIdentity = workerTerminationIdentity(active);
  const childIdentity = child && child.start_time !== undefined && processIdentityMatches(child.pid, child.start_time);
  if (childIdentity) terminateProcessTree(child!.pid, "SIGTERM");
  if (workerIdentity) terminateProcessTree(active.pid!, "SIGTERM");
  const taskProcesses = [
    ...(workerIdentity ? [{ pid: active.pid!, startToken: active.pid_start_time }] : []),
    ...(childIdentity ? [{ pid: child!.pid, startToken: child!.start_time }] : [])
  ];
  await waitForPids(taskProcesses.map(({ pid }) => pid), 5_000);
  for (const { pid, startToken } of taskProcesses) {
    if (processIdentityMatches(pid, startToken)) terminateProcessTree(pid, "SIGKILL");
  }
  await waitForPids(taskProcesses.map(({ pid }) => pid), 1_000);
  const stopped = active.pid === undefined || !processIdentityMatches(active.pid, active.pid_start_time);
  if (stopped && !(await taskResult(active.task_id))) {
    await writeJsonAtomic(path.join(active.task_dir, "result.json"), { task_id: active.task_id, state: "stopped", stopped_at: new Date().toISOString() });
  }
  if (stopped) {
    const current = await readJson(ACTIVE_PATH, RawTaskMetadataSchema);
    if (!current || current.task_id === active.task_id) await fsp.rm(ACTIVE_PATH, { force: true });
    await dispatchNextLocked(active.bash_mode);
  } else {
    const stopping = { ...active, state: "stopping" as const };
    await writeJsonAtomic(path.join(active.task_dir, "task.json"), stopping);
    await writeJsonAtomic(ACTIVE_PATH, stopping);
  }
  return { task_id: active.task_id, state: stopped ? "stopped" : "stopping", stopped };
  });
}
