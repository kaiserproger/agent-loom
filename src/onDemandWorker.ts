import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { type Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const WorkerConfigSchema = z.object({
  taskId: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  shell: z.boolean().default(false),
  cwd: z.string(),
  sandboxRoot: z.string(),
  workspaceRoot: z.string(),
  timeoutMs: z.number().int().positive(),
  stdoutPath: z.string(),
  stderrPath: z.string(),
  readyPath: z.string(),
  startPath: z.string(),
  childPath: z.string(),
  resultPath: z.string(),
  resultMarkdownPath: z.string(),
  activePath: z.string(),
  supervisorPath: z.string(),
  heartbeatPath: z.string().optional(),
  bashMode: z.enum(["off", "safe", "full"]).default("safe"),
  input: z.string(),
  taskMetadata: z.record(z.unknown())
});
const ActiveTaskSchema = z.object({ task_id: z.string() }).passthrough();

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 12_000;
const TRUNCATION_MARKER = Buffer.from("\n...[output truncated by Agent Loom]\n");


function processStartToken(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

async function touchHeartbeat(file: string): Promise<void> {
  try {
    await fsp.utimes(file, new Date(), new Date());
  } catch {
    await fsp.writeFile(file, `${process.pid}\n`, { mode: 0o600 });
  }
}
type JsonObject = Record<string, unknown>;

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    if (result.status !== 0) child.kill(signal);
    return;
  }
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

function commandInsideSandbox(command: string, workspaceRoot: string): string {
  if (!path.isAbsolute(command)) return command;
  const relative = path.relative(workspaceRoot, command);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.posix.join("/workspace", relative.split(path.sep).join("/"));
  }
  return command;
}

function agentEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: "/tmp",
    XDG_CONFIG_HOME: "/tmp"
  };
  const allowedExact = new Set([
    "CI", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "NO_COLOR", "TERM",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
    "GOOGLE_API_KEY", "GEMINI_API_KEY", "ZAI_API_KEY", "MISTRAL_API_KEY",
    "CODEX_API_KEY", "PI_API_KEY", "OMP_API_KEY"
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (allowedExact.has(key) || key.startsWith("LC_"))) environment[key] = value;
  }
  return environment;
}

function sandboxInvocation(config: z.infer<typeof WorkerConfigSchema>): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (process.platform !== "linux") throw new Error("Native agent workers require Linux bubblewrap sandbox support.");
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore", timeout: 2_000 });
  if (probe.status !== 0) throw new Error("Native agent workers require the bwrap executable for filesystem isolation.");
  const command = commandInsideSandbox(config.command, config.workspaceRoot);
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind", config.sandboxRoot, "/workspace",
    "--chdir", "/workspace",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp"
  ];
  const nodeDirectory = path.dirname(process.execPath);
  if (existsSync(nodeDirectory)) args.push("--ro-bind", nodeDirectory, nodeDirectory);
  for (const systemPath of ["/usr", "/usr/local", "/bin", "/lib", "/lib64", "/etc"]) {
    if (existsSync(systemPath)) args.push("--ro-bind", systemPath, systemPath);
  }
  args.push("--", command, ...config.args);
  return { command: "bwrap", args, env: agentEnvironment() };
}

function captureBoundedOutput(source: Readable | null, file: string): Promise<void> {
  const destination = createWriteStream(file, { flags: "a", mode: 0o600 });
  if (!source) {
    destination.end();
    return finished(destination);
  }
  let written = 0;
  let truncated = false;
  source.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_LOG_BYTES - written;
    if (remaining > 0) {
      const captured = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
      written += captured.byteLength;
      if (!destination.write(captured)) {
        source.pause();
        destination.once("drain", () => source.resume());
      }
    }
    if (bytes.byteLength > remaining && !truncated) {
      truncated = true;
      destination.write(TRUNCATION_MARKER);
    }
  });
  source.once("end", () => destination.end());
  source.once("error", (error) => destination.destroy(error));
  return finished(destination);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
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

async function waitForPath(file: string, milliseconds: number, shouldStop: () => boolean): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (shouldStop()) return false;
    if (await fsp.access(file).then(() => true).catch(() => false)) return true;
    await sleep(25);
  }
  return false;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => isObject(item) ? textValue(item.text ?? item.content ?? item.value) : textValue(item)).filter(Boolean).join("\n");
  if (isObject(value)) return textValue(value.text ?? value.content ?? value.output ?? value.message);
  return "";
}

async function outputSummary(file: string): Promise<string> {
  const raw = await fsp.readFile(file, "utf8").catch(() => "");
  const messages: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (!isObject(event)) continue;
      const message = textValue(event.message ?? event.content ?? event.output);
      if (message) messages.push(message);
    } catch {}
  }
  const summary = messages.at(-1) ?? raw;
  return summary.length > MAX_SUMMARY_BYTES ? summary.slice(-MAX_SUMMARY_BYTES) : summary;
}

async function writeResultArtifact(config: z.infer<typeof WorkerConfigSchema>, result: JsonObject): Promise<void> {
  const summary = typeof result.output_summary === "string" ? result.output_summary : "";
  const metadata = config.taskMetadata;
  const markdown = [
    "# Agent Loom task result",
    "",
    `- Task ID: ${config.taskId}`,
    `- Agent: ${String(metadata.agent ?? "task")}`,
    `- Backend: ${String(metadata.backend ?? "unknown")}`,
    `- Mode: ${String(metadata.mode ?? "review")}`,
    `- State: ${String(result.state ?? "unknown")}`,
    "",
    "## Summary",
    "",
    summary || "No assistant summary was emitted. See stdout.log and stderr.log.",
    ""
  ].join("\n");
  await fsp.writeFile(config.resultMarkdownPath, markdown, { mode: 0o600 });
}

async function removeActive(config: z.infer<typeof WorkerConfigSchema>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const active = ActiveTaskSchema.parse(JSON.parse(await fsp.readFile(config.activePath, "utf8")));
      if (active.task_id === config.taskId) await fsp.rm(config.activePath, { force: true });
      return;
    } catch {
      if (attempt === 19) return;
      await sleep(10);
    }
  }
}

function dispatchNext(config: z.infer<typeof WorkerConfigSchema>): void {
  const dispatcher = spawn(process.execPath, [config.supervisorPath, "--dispatch"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    cwd: path.dirname(config.activePath),
    env: { ...process.env, AGENT_LOOM_TASK_BASH_MODE: config.bashMode },
    windowsHide: true
  });
  dispatcher.once("error", () => {});
  dispatcher.unref();
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("worker config path is required");
  const config = WorkerConfigSchema.parse(JSON.parse(await fsp.readFile(configPath, "utf8")));
  try { os.setPriority(0, 10); } catch {}
  let child: ChildProcess | undefined;
  let stdoutDone = Promise.resolve();
  let stderrDone = Promise.resolve();
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let result: JsonObject | undefined;
  let stopping = false;
  const terminate = (signal: NodeJS.Signals) => {
    stopping = true;
    if (child) terminateProcessTree(child, signal);
  };
  process.on("SIGTERM", () => terminate("SIGTERM"));
  process.on("SIGINT", () => terminate("SIGTERM"));
  const startedAt = new Date().toISOString();
  try {
    if (config.heartbeatPath) {
      await touchHeartbeat(config.heartbeatPath);
      heartbeatTimer = setInterval(() => { void touchHeartbeat(config.heartbeatPath!); }, 5_000);
      heartbeatTimer.unref();
    }
    await writeJsonAtomic(config.readyPath, {
      task_id: config.taskId,
      pid: process.pid,
      pid_start_time: processStartToken(process.pid),
      ready_at: new Date().toISOString()
    });
    const started = await waitForPath(config.startPath, 30_000, () => stopping);
    if (!started || stopping) {
      result = { task_id: config.taskId, state: "stopped", started_at: startedAt, finished_at: new Date().toISOString() };
    } else {
      const sandbox = sandboxInvocation(config);
      child = spawn(sandbox.command, sandbox.args, {
        cwd: config.cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...sandbox.env, CARGO_BUILD_JOBS: process.env.AGENT_LOOM_AGENT_BUILD_JOBS ?? "4", RAYON_NUM_THREADS: process.env.AGENT_LOOM_AGENT_THREADS ?? "4" }
      });
      const spawnOutcome = await new Promise<Error | null>((resolve) => {
        let settled = false;
        const settle = (error: Error | null) => {
          if (settled) return;
          settled = true;
          resolve(error);
        };
        child!.once("error", settle);
        child!.once("spawn", () => settle(null));
      });
      if (spawnOutcome || !child.pid) throw spawnOutcome ?? new Error("Failed to start agent backend.");
      await writeJsonAtomic(config.childPath, { pid: child.pid, start_time: processStartToken(child.pid) });
      stdoutDone = captureBoundedOutput(child.stdout, config.stdoutPath);
      stderrDone = captureBoundedOutput(child.stderr, config.stderrPath);
      child.stdin?.on("error", () => {});
      child.stdin?.end(config.input);
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("exit", (code, signal) => resolve({ code, signal }));
      });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
        setTimeout(() => terminate("SIGKILL"), 10_000).unref();
      }, config.timeoutMs);
      timeoutTimer.unref();
      const outcome = await exit;
      result = {
        task_id: config.taskId,
        state: timedOut ? "timed_out" : stopping ? "stopped" : outcome.code === 0 ? "completed" : "failed",
        exit_code: outcome.code,
        signal: outcome.signal,
        started_at: startedAt,
        finished_at: new Date().toISOString()
      };
    }
  } catch (error) {
    result = {
      task_id: config.taskId,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
      started_at: startedAt,
      finished_at: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeoutTimer as NodeJS.Timeout);
    clearInterval(heartbeatTimer as NodeJS.Timeout);
    await Promise.allSettled([stdoutDone, stderrDone]);
    if (result) {
      try {
        result.output_summary = await outputSummary(config.stdoutPath);
        await writeJsonAtomic(config.resultPath, result);
        await writeResultArtifact(config, result);
      } catch (error) {
        const finalResult = {
          ...result,
          state: "failed",
          error: `Failed to persist task artifacts: ${error instanceof Error ? error.message : String(error)}`
        };
        await writeJsonAtomic(config.resultPath, finalResult).catch(() => {});
      }
    }
    await fsp.rm(config.childPath, { force: true }).catch(() => {});
    if (config.heartbeatPath) await fsp.rm(config.heartbeatPath, { force: true }).catch(() => {});
    await removeActive(config).catch(() => {});
    try { dispatchNext(config); } catch {}
  }
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
