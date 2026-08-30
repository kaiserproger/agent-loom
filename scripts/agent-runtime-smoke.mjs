import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loom-runtime-'));
const bin = path.join(root, 'bin');
await fs.mkdir(bin, { recursive: true });
await fs.mkdir(path.join(root, '.git'));
await fs.writeFile(path.join(root, '.env'), 'secret=must-not-enter-sandbox\n');
await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
await fs.writeFile(path.join(root, '.omp', 'agents', 'scout.md'), `---
name: scout
description: Project scout override for runtime smoke.
model: @fast
thinking: low
tools: read,grep,glob
---
Inspect only the requested files and return evidence.
`, 'utf8');
await fs.writeFile(path.join(root, '.omp', 'agents', 'invalid.md'), 'not frontmatter\n', 'utf8');
const fakeOmp = path.join(root, 'fake-omp.mjs');
await fs.writeFile(fakeOmp, `import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
if (process.argv.includes('--version')) { console.log('omp smoke 1'); process.exit(0); }
if (process.argv[2] === 'models' && process.argv.includes('--json')) { console.log(JSON.stringify({ models: [{ selector: 'zai/glm-5.3-flash' }, { selector: 'openai-codex/gpt-5.6-luna' }] })); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
let readOnly = false;
try { await fs.writeFile('/workspace/native-write-probe', 'must fail'); } catch { readOnly = true; }
if (!readOnly) process.exit(8);
let secretsBlocked = true;
try { await fs.access('/workspace/.env'); secretsBlocked = false; } catch {}
if (!secretsBlocked) process.exit(9);
if (input.includes('fail-task')) process.exit(7);
if (input.includes('queue-first')) await sleep(3_000);
process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'RESULT=PASS ' + (input.includes('queue-first') ? 'FIRST' : 'SECOND') + ' ARGS=' + JSON.stringify(process.argv.slice(2)) }] } }) + '\\n');
`, 'utf8');
const command = process.platform === 'win32' ? path.join(bin, 'omp.cmd') : path.join(bin, 'omp');
const piCommand = process.platform === 'win32' ? path.join(bin, 'pi.cmd') : path.join(bin, 'pi');
const wrapper = `#!/usr/bin/env sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "${process.execPath}" "$SCRIPT_DIR/../fake-omp.mjs" "$@"\n`;
if (process.platform === 'win32') {
  await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${fakeOmp}" %*\r\n`, 'utf8');
} else {
  await fs.writeFile(command, wrapper, { mode: 0o755 });
}
process.env.AGENT_LOOM_HOME = path.join(root, 'state');
process.env.AGENT_LOOM_OMP_COMMAND = command;
process.env.AGENT_LOOM_PI_COMMAND = piCommand;
process.env.AGENT_LOOM_CODEX_COMMAND = path.join(root, 'missing-codex');
const {
  startOnDemandAgent,
  waitOnDemandAgent,
  onDemandAgentStatus,
  stopOnDemandAgent,
  availableAgentBackends,
  availableAgentDefinitions,
  availableOnDemandModels
} = await import('../dist/onDemandAgentOps.js');
const workspace = { id: 'agent-runtime-smoke', root };
try {
  const backends = availableAgentBackends();
  if (backends.length !== 1 || backends[0] !== 'omp') throw new Error(`auto backend selection failed: ${JSON.stringify(backends)}`);
  if (process.platform === 'win32') {
    await fs.writeFile(piCommand, `@echo off\r\n"${process.execPath}" "${fakeOmp}" %*\r\n`, 'utf8');
  } else {
    await fs.writeFile(piCommand, wrapper, { mode: 0o755 });
  }
  if (process.platform !== 'win32') {
    const symlinkWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loom-symlink-'));
    try {
      await fs.mkdir(path.join(symlinkWorkspace, '.omp'), { recursive: true });
      await fs.symlink(path.join(root, '.omp', 'agents'), path.join(symlinkWorkspace, '.omp', 'agents'), 'dir');
      const symlinkInventory = await availableAgentDefinitions(symlinkWorkspace);
      const symlinkScout = symlinkInventory.agents.find((agent) => agent.name === 'scout');
      if (!symlinkInventory.warnings.some((warning) => warning.includes('outside workspace')) || symlinkScout?.source === 'project') throw new Error(`project agent symlink escaped workspace: ${JSON.stringify({ symlinkScout, warnings: symlinkInventory.warnings })}`);
    } finally {
      await fs.rm(symlinkWorkspace, { recursive: true, force: true });
    }
  }
  const models = availableOnDemandModels('omp');
  if (!models.includes('zai/glm-5.3-flash')) throw new Error(`OMP model inventory failed: ${JSON.stringify(models)}`);
  if (availableOnDemandModels('codex').length !== 0) throw new Error('Codex model inventory should be empty');
  const inventory = await availableAgentDefinitions(root);
  const scout = inventory.agents.find((agent) => agent.name === 'scout');
  if (!scout || scout.source !== 'project' || !scout.description.includes('override') || inventory.warnings.length !== 1) throw new Error(`agent discovery precedence/warnings failed: ${JSON.stringify({ scout, warnings: inventory.warnings })}`);
  let unknownAgentRejected = false;
  try {
    await startOnDemandAgent(workspace, { backend: 'omp', agent: 'missing-agent', mode: 'review', task: 'unknown-agent', timeout_seconds: 30, queue: true });
  } catch (error) {
    unknownAgentRejected = String(error).includes('Unknown agent');
  }
  if (!unknownAgentRejected) throw new Error('unknown agent was not rejected');
  let writeModeRejected = false;
  try {
    await startOnDemandAgent(workspace, { backend: 'omp', agent: 'scout', mode: 'write', task: 'write-mode-rejected', timeout_seconds: 30, queue: true });
  } catch (error) {
    writeModeRejected = String(error).includes('native workers are read-only');
  }
  if (!writeModeRejected) throw new Error('native write mode was not rejected');
  let unsafeModelRejected = false;
  try {
    await startOnDemandAgent(workspace, { backend: 'omp', agent: 'scout', model: 'zai/glm&unsafe', mode: 'review', task: 'unsafe-model', timeout_seconds: 30, queue: true });
  } catch (error) {
    unsafeModelRejected = String(error).includes('unsupported shell characters');
  }
  if (!unsafeModelRejected) throw new Error('unsafe model selector was not rejected');
  const first = await startOnDemandAgent(workspace, { backend: 'auto', agent: 'scout', mode: 'review', task: 'queue-first', timeout_seconds: 30, queue: true });
  if (first.backend !== 'omp' || first.model !== 'zai/glm-5.3-flash' || first.state !== 'running') throw new Error(`OMP routing failed: ${JSON.stringify(first)}`);
  const second = await startOnDemandAgent(workspace, { backend: 'auto', agent: 'task', mode: 'review', task: 'queue-second', timeout_seconds: 30, queue: true });
  if (second.state !== 'queued' || !('queue_position' in second)) throw new Error(`queue admission failed: ${JSON.stringify(second)}`);
  await fs.rm(command);
  process.env.AGENT_LOOM_OMP_COMMAND = command;
  process.env.AGENT_LOOM_PI_COMMAND = piCommand;
  const firstResult = await waitOnDemandAgent(first.task_id, 20);
  const secondResult = await waitOnDemandAgent(second.task_id, 20);
  if (firstResult.state !== 'completed' || secondResult.state !== 'completed' || secondResult.backend !== 'pi') throw new Error(`queued task completion/fallback failed: first=${firstResult.state}/${firstResult.backend}, second=${secondResult.state}/${secondResult.backend}, firstError=${firstResult.error ?? ''}, secondError=${secondResult.error ?? ''}`);
  if (!String(firstResult.output_summary).includes('RESULT=PASS FIRST') || !String(secondResult.output_summary).includes('RESULT=PASS SECOND') || !String(firstResult.output_summary).includes('--mode') || !String(firstResult.output_summary).includes('zai/glm-5.3-flash')) throw new Error(`structured output summary failed: ${JSON.stringify({ firstResult, secondResult })}`);
  await fs.access(first.artifact_path);
  await fs.access(path.join(first.task_dir, 'stdout.log'));
  const status = await onDemandAgentStatus();
  if (process.platform === 'win32') {
    await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${fakeOmp}" %*\r\n`, 'utf8');
  } else {
    await fs.writeFile(command, wrapper, { mode: 0o755 });
  }
  process.env.AGENT_LOOM_OMP_COMMAND = path.join(root, 'missing-omp');
  process.env.AGENT_LOOM_PI_COMMAND = piCommand;
  const fallback = await startOnDemandAgent(workspace, { backend: 'auto', agent: 'scout', mode: 'review', task: 'fallback-task', timeout_seconds: 30, queue: true });
  if (fallback.backend !== 'pi') throw new Error(`Pi fallback failed: ${JSON.stringify(fallback)}`);
  const fallbackResult = await waitOnDemandAgent(fallback.task_id, 20);
  if (fallbackResult.state !== 'completed') throw new Error(`Pi fallback task failed: ${JSON.stringify(fallbackResult)}`);

  process.env.AGENT_LOOM_PI_COMMAND = path.join(root, 'missing-pi');
  process.env.AGENT_LOOM_CODEX_COMMAND = path.join(root, 'missing-codex');
  let noBackendRejected = false;
  try {
    await startOnDemandAgent(workspace, { backend: 'auto', agent: 'scout', mode: 'review', task: 'no-backend-task', timeout_seconds: 30, queue: true });
  } catch (error) {
    noBackendRejected = String(error).includes('No supported agent backend');
  }
  if (!noBackendRejected) throw new Error('missing backend was not rejected');

  process.env.AGENT_LOOM_OMP_COMMAND = command;
  const failed = await startOnDemandAgent(workspace, { backend: 'omp', agent: 'scout', mode: 'review', task: 'fail-task', timeout_seconds: 30, queue: true });
  const failedResult = await waitOnDemandAgent(failed.task_id, 20);
  if (failedResult.state !== 'failed') throw new Error(`non-zero worker failure was not surfaced: ${JSON.stringify(failedResult)}`);
  const holder = await startOnDemandAgent(workspace, { backend: 'omp', agent: 'scout', mode: 'review', task: 'queue-first', timeout_seconds: 30, queue: true });
  const cancellable = await startOnDemandAgent(workspace, { backend: 'omp', agent: 'task', mode: 'review', task: 'queue-second', timeout_seconds: 30, queue: true });
  const cancelled = await stopOnDemandAgent(cancellable.task_id);
  const holderResult = await waitOnDemandAgent(holder.task_id, 20);
  const cancelledResult = await waitOnDemandAgent(cancellable.task_id, 20);
  if (!cancelled.stopped || holderResult.state !== 'completed' || cancelledResult.state !== 'stopped') throw new Error(`queued cancellation failed: ${JSON.stringify({ cancelled, holderResult, cancelledResult })}`);
  const finalStatus = await onDemandAgentStatus();
  if (finalStatus.state !== 'idle') throw new Error(`edge queue did not drain: ${JSON.stringify(finalStatus)}`);
  console.log(JSON.stringify({ backend: 'omp', fallback_backend: fallback.backend, models, agent: scout.name, queued: second.state, completed: [firstResult.state, secondResult.state], failed: failedResult.state, queued_cancelled: cancelledResult.state, artifacts: true }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
