import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { discoverAgentDefinitions, type AgentDefinition } from "./agentDefinitions.js";
import { discoverSkillInventory, loadSkill, type LoadedSkill, type SkillInventoryItem } from "./capabilitiesOps.js";
import { isSubpath, type Workspace } from "./guard.js";

export type OmpWebFileKind = "system" | "rule" | "prompt" | "command";

export interface OmpWebContextFile {
  kind: OmpWebFileKind;
  scope: "project" | "user";
  path: string;
  bytes: number;
}

export interface OmpWebAgent {
  name: string;
  description: string;
  mode: string;
  model: string | null;
  thinking: string | null;
  tools: string[];
  spawns: string[];
  source: string;
  file_path: string | null;
}

export interface OmpWebContext {
  runtime: "chatgpt-web-native";
  model_execution: "chatgpt-web";
  external_omp_process: false;
  workspace_id: string;
  workspace_root: string;
  native_tools: string[];
  native_tool_scope: "omp-native-only";
  agents: OmpWebAgent[];
  skills: SkillInventoryItem[];
  files: OmpWebContextFile[];
  text: string;
}

const MAX_CONTEXT_FILE_BYTES = 20_000;
const MAX_CONTEXT_FILES = 48;
const MAX_CONTEXT_TEXT_BYTES = 80_000;
// This is deliberately an OMP-native subset of Agent Loom's enabled tools.
// Separate model-compatibility tools such as task, pi, codex, and handoff/session tools are not OMP capabilities.
const OMP_NATIVE_MINIMAL_TOOL_NAMES = [
  "workspace",
  "omp",
  "agents",
  "read",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "show_changes"
];
const OMP_NATIVE_STANDARD_TOOL_NAMES = [
  ...OMP_NATIVE_MINIMAL_TOOL_NAMES,
  "tree",
  "search",
  "view_image",
  "import_file"
];
const OMP_NATIVE_FULL_TOOL_NAMES = [
  ...OMP_NATIVE_STANDARD_TOOL_NAMES,
  "load_skill",
  "list_workspaces",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "git_status",
  "git_diff"
];

function ompNativeToolNames(config: CodexProConfig): string[] {
  const names =
    config.toolMode === "full"
      ? OMP_NATIVE_FULL_TOOL_NAMES
      : config.toolMode === "minimal"
        ? OMP_NATIVE_MINIMAL_TOOL_NAMES
        : OMP_NATIVE_STANDARD_TOOL_NAMES;
  return names.filter((name) =>
    (name !== "bash" || config.bashMode !== "off") &&
    (!["write", "edit", "apply_patch", "import_file"].includes(name) || config.writeMode === "workspace") &&
    (name !== "inspect_workspace" || config.analysisEnabled)
  );
}

function ompAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".omp", "agent");
}

function ancestorDirectories(root: string): string[] {
  const out: string[] = [];
  let current = path.resolve(root);
  const home = path.resolve(os.homedir());
  for (let depth = 0; depth < 16; depth += 1) {
    out.push(current);
    if (current === home || current === path.dirname(current)) break;
    current = path.dirname(current);
  }
  return out;
}
function displayPath(filePath: string, workspaceRoot: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(workspaceRoot);
  if (resolved === root) return "$WORKSPACE";
  if (isSubpath(resolved, root)) return `$WORKSPACE/${path.relative(root, resolved).split(path.sep).join("/")}`;
  const home = path.resolve(os.homedir());
  if (resolved === home) return "~";
  if (isSubpath(resolved, home)) return `~/${path.relative(home, resolved).split(path.sep).join("/")}`;
  return resolved;
}

async function readBounded(filePath: string): Promise<{ text: string; bytes: number } | undefined> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return undefined;
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_CONTEXT_FILE_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: stat.size };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function collectDirectory(
  directory: string,
  kind: OmpWebFileKind,
  scope: "project" | "user",
  workspaceRoot: string,
  files: OmpWebContextFile[],
  bodies: Array<{ file: OmpWebContextFile; text: string }>,
  seen: Set<string>,
  onlyName?: string
): Promise<void> {
  if (files.length >= MAX_CONTEXT_FILES) return;
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || (onlyName && entry.name !== onlyName) || !/\.(?:md|mdc)$/i.test(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    const real = await fsp.realpath(candidate).catch(() => undefined);
    if (!real || seen.has(real)) continue;
    if (scope === "project" && !isSubpath(real, workspaceRoot)) continue;
    const loaded = await readBounded(real);
    if (!loaded) continue;
    const file: OmpWebContextFile = {
      kind,
      scope,
      path: displayPath(real, workspaceRoot),
      bytes: loaded.bytes
    };
    seen.add(real);
    files.push(file);
    if (kind === "system" || kind === "rule") bodies.push({ file, text: loaded.text });
  }
}

async function collectOmpFiles(workspace: Workspace): Promise<{
  files: OmpWebContextFile[];
  bodies: Array<{ file: OmpWebContextFile; text: string }>;
}> {
  const workspaceRoot = path.resolve(workspace.root);
  const files: OmpWebContextFile[] = [];
  const bodies: Array<{ file: OmpWebContextFile; text: string }> = [];
  const seen = new Set<string>();
  const agentDir = ompAgentDir();
  await collectDirectory(agentDir, "system", "user", workspaceRoot, files, bodies, seen, "SYSTEM.md");
  for (const kind of ["rule", "prompt", "command"] as const) {
    await collectDirectory(path.join(agentDir, `${kind}s`), kind, "user", workspaceRoot, files, bodies, seen);
  }

  for (const ancestor of ancestorDirectories(workspaceRoot).reverse()) {
    const ompRoot = path.join(ancestor, ".omp");
    const agentRoots = [ompRoot, path.join(ancestor, ".agent"), path.join(ancestor, ".agents")];
    const system = path.join(ompRoot, "SYSTEM.md");
    const loaded = await readBounded(system);
    if (loaded) {
      const real = await fsp.realpath(system).catch(() => undefined);
      if (real && !seen.has(real) && isSubpath(real, workspaceRoot)) {
        const file: OmpWebContextFile = { kind: "system", scope: "project", path: displayPath(real, workspaceRoot), bytes: loaded.bytes };
        seen.add(real);
        files.push(file);
        bodies.push({ file, text: loaded.text });
      }
    }
    for (const root of agentRoots) {
      await collectDirectory(path.join(root, "rules"), "rule", "project", workspaceRoot, files, bodies, seen);
      await collectDirectory(path.join(root, "prompts"), "prompt", "project", workspaceRoot, files, bodies, seen);
      await collectDirectory(path.join(root, "commands"), "command", "project", workspaceRoot, files, bodies, seen);
    }
  }

  return { files, bodies };
}

function publicAgent(agent: AgentDefinition): OmpWebAgent {
  return {
    name: agent.name,
    description: agent.description,
    mode: agent.mode,
    model: agent.model ?? null,
    thinking: agent.thinking ?? null,
    tools: agent.tools,
    spawns: agent.spawns,
    source: agent.source,
    file_path: agent.filePath ?? null
  };
}

function appendBounded(lines: string[], value: string, budget: { bytes: number }): void {
  if (budget.bytes >= MAX_CONTEXT_TEXT_BYTES) return;
  const remaining = MAX_CONTEXT_TEXT_BYTES - budget.bytes;
  const clipped = Buffer.from(value, "utf8").subarray(0, remaining).toString("utf8");
  lines.push(clipped);
  budget.bytes += Buffer.byteLength(clipped, "utf8");
}

export async function buildOmpWebContext(config: CodexProConfig, workspace: Workspace): Promise<OmpWebContext> {
  const [{ agents }, skills, contextFiles] = await Promise.all([
    discoverAgentDefinitions(workspace.root),
    discoverSkillInventory(workspace, { includeGlobal: true, maxSkills: 120 }),
    collectOmpFiles(workspace)
  ]);
  const nativeTools = ompNativeToolNames(config);
  const lines: string[] = [
    "# OMP Web Capability Layer",
    "",
    "Runtime: ChatGPT Web (native)",
    "Model execution: this ChatGPT conversation",
    "External OMP model process: not launched",
    "",
    "Agent Loom exposes OMP's local capability model to ChatGPT Web. Continue in this conversation and use the native MCP tools directly; do not start another model to perform the task.",
    `Workspace: ${workspace.root}`,
    `OMP-native MCP tools (compatibility model tools are excluded): ${nativeTools.join(", ")}`,
    "",
    "## OMP agents",
    agents.length ? agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n") : "- none discovered",
    "",
    "Call omp(action=agent, agent_name=...) when a role's focused system prompt is needed.",
    "",
    "## OMP skills",
    skills.length ? skills.map((skill) => `- ${skill.name} [${skill.source}]${skill.description ? ` — ${skill.description}` : ""}`).join("\n") : "- none discovered",
    "",
    "Call omp(action=skill, skill_name=...) or load_skill to load a skill body.",
    "",
    "## OMP prompts and slash commands",
    contextFiles.files.filter((file) => file.kind === "prompt" || file.kind === "command").map((file) => `- ${file.kind}: ${file.path}`).join("\n") || "- none discovered",
    "",
    "## Active OMP system and rules"
  ];
  const budget = { bytes: Buffer.byteLength(lines.join("\n"), "utf8") };
  if (contextFiles.bodies.length) {
    for (const body of contextFiles.bodies) {
      appendBounded(lines, `\n--- ${body.file.kind} ${body.file.path} ---\n${body.text.trim()}`, budget);
    }
  } else {
    lines.push("- none discovered");
  }

  return {
    runtime: "chatgpt-web-native",
    model_execution: "chatgpt-web",
    external_omp_process: false,
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    native_tools: nativeTools,
    native_tool_scope: "omp-native-only",
    agents: agents.map(publicAgent),
    skills,
    files: contextFiles.files,
    text: lines.join("\n")
  };
}

export async function loadOmpWebSkill(workspace: Workspace, skillName: string, source?: SkillInventoryItem["source"]): Promise<LoadedSkill> {
  return loadSkill(workspace, {
    name: skillName,
    source,
    includeGlobal: true,
    maxSkills: 500,
    maxBytes: 100_000
  });
}

export async function loadOmpWebAgent(workspace: Workspace, agentName: string): Promise<OmpWebAgent & { system_prompt: string }> {
  const inventory = await discoverAgentDefinitions(workspace.root);
  const agent = inventory.agents.find((item) => item.name === agentName.trim());
  if (!agent) throw new Error(`OMP agent not found: ${agentName}. Available: ${inventory.agents.map((item) => item.name).join(", ")}`);
  return { ...publicAgent(agent), system_prompt: agent.systemPrompt };
}

export function ompWebStatus(config: CodexProConfig): Record<string, unknown> {
  return {
    runtime: "chatgpt-web-native",
    model_execution: "chatgpt-web",
    external_omp_process: false,
    native_tool_scope: "omp-native-only",
    capabilities: ["agents", "skills", "rules", "prompts", "slash_commands", "workspace_tools", "mcp_tools"],
    native_tools: ompNativeToolNames(config)
  };
}
