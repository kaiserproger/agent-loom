import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AGENT_LOOM_PACKAGE = "agent-loom";
export const AGENT_LOOM_REPOSITORY = "git+https://github.com/kaiserproger/agent-loom.git";
export const AGENT_LOOM_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function releaseRootError(actualPath) {
  return new Error(
    `Release commands must run from the Agent Loom root (${AGENT_LOOM_ROOT}). ` +
    `Current directory is ${actualPath}. Change directory first; do not use npm --prefix for npm pack or npm publish.`
  );
}

export function assertAgentLoomReleaseEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  const actualCwd = canonicalPath(cwd);
  if (actualCwd !== AGENT_LOOM_ROOT) throw releaseRootError(actualCwd);

  if (env.INIT_CWD && canonicalPath(env.INIT_CWD) !== AGENT_LOOM_ROOT) {
    throw releaseRootError(canonicalPath(env.INIT_CWD));
  }

  const expectedPackageJson = resolve(AGENT_LOOM_ROOT, "package.json");
  if (env.npm_package_json && canonicalPath(env.npm_package_json) !== canonicalPath(expectedPackageJson)) {
    throw new Error("npm is bound to a different package.json; stop before packing or publishing.");
  }

  const packageJson = JSON.parse(readFileSync(expectedPackageJson, "utf8"));
  if (packageJson.name !== AGENT_LOOM_PACKAGE) {
    throw new Error(`Expected package name ${AGENT_LOOM_PACKAGE}; found ${packageJson.name ?? "(missing)"}.`);
  }
  if (packageJson.repository?.url !== AGENT_LOOM_REPOSITORY) {
    throw new Error("Agent Loom repository metadata does not match the canonical release repository.");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version ?? "")) {
    throw new Error("Agent Loom package.json has an invalid release version.");
  }

  return {
    root: AGENT_LOOM_ROOT,
    name: packageJson.name,
    version: packageJson.version
  };
}

function isDirectInvocation() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectInvocation()) {
  try {
    const release = assertAgentLoomReleaseEnvironment();
    console.log(`Agent Loom release guard: ${release.name}@${release.version}`);
  } catch (error) {
    console.error(`[release guard] ${error.message}`);
    process.exitCode = 1;
  }
}
