import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AgentSource = "project" | "user" | "custom" | "bundled";
export type AgentMode = "review" | "write";
export type AgentThinking = "low" | "medium" | "high";

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  spawns: string[];
  model?: string;
  thinking?: AgentThinking;
  mode: AgentMode;
  source: AgentSource;
  filePath?: string;
}

export interface AgentDiscoveryResult {
  agents: AgentDefinition[];
  warnings: string[];
}

const BUNDLED_AGENTS: AgentDefinition[] = [
  {
    name: "task",
    description: "Analyze one bounded implementation task and return an actionable plan.",
    systemPrompt: "Work read-only. Inspect the selected workspace mirror, identify the exact files and guarded edits needed, verify assumptions, and report a concrete implementation plan. Do not modify files.",
    tools: ["read", "grep", "glob"],
    spawns: [],
    model: "@task",
    thinking: "high",
    mode: "review",
    source: "bundled"
  },
  {
    name: "scout",
    description: "Explore a workspace and return concise evidence without editing.",
    systemPrompt: "Work read-only. Map the relevant files, symbols, call paths, conventions, risks, and exact evidence needed for implementation.",
    tools: ["read", "grep", "glob"],
    spawns: [],
    model: "@fast",
    thinking: "low",
    mode: "review",
    source: "bundled"
  },
  {
    name: "reviewer",
    description: "Review a change for correctness, regressions, and missing coverage.",
    systemPrompt: "Work read-only. Review the actual workspace and diff. Report blocking findings first with file paths, lines, impact, and a concrete correction.",
    tools: ["read", "grep", "glob"],
    spawns: [],
    model: "@review",
    thinking: "high",
    mode: "review",
    source: "bundled"
  },
  {
    name: "security-reviewer",
    description: "Review a change for realistic security vulnerabilities.",
    systemPrompt: "Work read-only. Trace trust boundaries, input validation, authorization, process and filesystem access, secret handling, and dependency impact. Separate definite findings from residual risk.",
    tools: ["read", "grep", "glob"],
    spawns: [],
    model: "@review",
    thinking: "high",
    mode: "review",
    source: "bundled"
  },
  {
    name: "designer",
    description: "Review a user-facing surface and propose concrete UX corrections.",
    systemPrompt: "Work read-only. Inspect the actual surface, preserve existing design conventions, and report accessibility and interaction risks.",
    tools: ["read", "grep", "glob"],
    spawns: [],
    model: "@review",
    thinking: "medium",
    mode: "review",
    source: "bundled"
  }
];

function parseList(value: string): string[] {
  const trimmed = value.trim().replace(/^\[|\]$/g, "");
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(file: string, source: AgentSource, filePath: string): AgentDefinition | null {
  const match = file.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const name = fields.get("name")?.trim();
  const description = fields.get("description")?.trim();
  if (!name || !description || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) return null;
  const thinking = fields.get("thinking") ?? fields.get("thinking-level");
  const mode = fields.get("mode");
  return {
    name,
    description,
    systemPrompt: match[2].trim(),
    tools: parseList(fields.get("tools") ?? "read,grep,glob"),
    spawns: parseList(fields.get("spawns") ?? ""),
    model: fields.get("model")?.replace(/^['\"]|['\"]$/g, ""),
    thinking: thinking === "low" || thinking === "medium" || thinking === "high" ? thinking : undefined,
    mode: mode === "write" ? "write" : "review",
    source,
    filePath
  };
}

async function loadDirectory(directory: string, source: AgentSource, warnings: string[]): Promise<AgentDefinition[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const definitions: AgentDefinition[] = [];
  for (const entry of entries.filter((item) => item.isFile() && /\.md$|\.markdown$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(directory, entry.name);
    try {
      const definition = parseFrontmatter(await fsp.readFile(filePath, "utf8"), source, filePath);
      if (definition) definitions.push(definition);
      else warnings.push(`Skipped invalid agent definition: ${filePath}`);
    } catch (error) {
      warnings.push(`Skipped unreadable agent definition ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return definitions;
}

export async function discoverAgentDefinitions(workspaceRoot: string, extraDirectories: string[] = []): Promise<AgentDiscoveryResult> {
  const home = process.env.AGENT_LOOM_HOME
    ? path.resolve(process.env.AGENT_LOOM_HOME)
    : path.join(os.homedir(), ".agent-loom");
  const configuredOmpAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const ompAgentDir = configuredOmpAgentDir ? path.resolve(configuredOmpAgentDir) : path.join(os.homedir(), ".omp", "agent");
  const directories: Array<{ directory: string; source: AgentSource }> = [
    ...extraDirectories.map((directory) => ({ directory: path.resolve(directory), source: "custom" as const })),
    { directory: path.join(workspaceRoot, ".omp", "agents"), source: "project" },
    { directory: path.join(home, "omp", "agents"), source: "user" },
    { directory: path.join(ompAgentDir, "agents"), source: "user" }
  ];
  const warnings: string[] = [];
  const agents: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const item of directories) {
    if (item.source === "project") {
      const [realRoot, realDirectory] = await Promise.all([
        fsp.realpath(workspaceRoot).catch(() => null),
        fsp.realpath(item.directory).catch(() => null)
      ]);
      if (realRoot && realDirectory) {
        const relative = path.relative(realRoot, realDirectory);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          warnings.push(`Skipped project agent directory outside workspace: ${item.directory}`);
          continue;
        }
      }
    }
    for (const definition of await loadDirectory(item.directory, item.source, warnings)) {
      if (!seen.has(definition.name)) {
        seen.add(definition.name);
        agents.push(definition);
      }
    }
  }
  for (const definition of BUNDLED_AGENTS) {
    if (!seen.has(definition.name)) agents.push(definition);
  }
  return { agents, warnings };
}

export async function resolveAgentDefinition(workspaceRoot: string, name = "task", extraDirectories: string[] = []): Promise<AgentDefinition> {
  const result = await discoverAgentDefinitions(workspaceRoot, extraDirectories);
  const definition = result.agents.find((agent) => agent.name === name);
  if (!definition) throw new Error(`Unknown agent \"${name}\". Available: ${result.agents.map((agent) => agent.name).join(", ")}`);
  return definition;
}

export function bundledAgentDefinitions(): AgentDefinition[] {
  return BUNDLED_AGENTS.map((agent) => ({ ...agent, tools: [...agent.tools], spawns: [...agent.spawns] }));
}
