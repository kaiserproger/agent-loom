import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loom-on-demand-'));
const bin = path.join(root, 'bin');
await fs.mkdir(bin);
await fs.mkdir(path.join(root, '.git'));
const fakePiScript = path.join(root, 'fake-pi.mjs');
await fs.writeFile(fakePiScript, `import { setTimeout as sleep } from 'node:timers/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (input.includes('slow-task')) await sleep(30_000);
if (input.includes('timeout-task')) await sleep(45_000);
if (input.includes('noisy-task')) process.stdout.write('x'.repeat(5 * 1024 * 1024));
process.stdout.write('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"RESULT=PASS"}]}}\\\\n');
`, 'utf8');
if (process.platform === 'win32') {
  await fs.writeFile(path.join(bin, 'pi.cmd'), `@echo off\r\n"${process.execPath}" "${fakePiScript}" %*\r\n`, 'utf8');
} else {
  await fs.writeFile(path.join(bin, 'pi'), `#!/usr/bin/env sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "${process.execPath}" "$SCRIPT_DIR/../fake-pi.mjs" "$@"\n`, { mode: 0o755 });
}
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.AGENT_LOOM_HOME = path.join(root, 'state');
process.env.AGENT_LOOM_PI_COMMAND = process.platform === 'win32' ? path.join(bin, 'pi.cmd') : path.join(bin, 'pi');
const { startOnDemandAgent, waitOnDemandAgent, onDemandAgentStatus, stopOnDemandAgent } = await import('../dist/onDemandAgentOps.js');
const workspace = { id: 'on-demand-smoke', root };
const supervisorRoot = path.join(process.env.AGENT_LOOM_HOME, 'on-demand');
const deadPid = process.pid + 100_000_000;
await fs.mkdir(path.join(supervisorRoot, 'launch.lock'), { recursive: true });
await fs.writeFile(path.join(supervisorRoot, 'launch.lock', 'owner.json'), `${JSON.stringify({ pid: deadPid, pid_start_time: 'dead', created_at: '2000-01-01T00:00:00.000Z' })}\n`);
await fs.writeFile(path.join(supervisorRoot, 'active.json'), `${JSON.stringify({
  task_id: '20000101000000-deadbeef',
  pid: deadPid,
  mode: 'review',
  workspace_id: workspace.id,
  workspace_root: workspace.root,
  model: null,
  timeout_seconds: 30,
  max_concurrency: 1,
  started_at: '2000-01-01T00:00:00.000Z',
  task_dir: path.join(supervisorRoot, 'tasks', '20000101000000-deadbeef')
})}\n`);

try {
  const recovered = await startOnDemandAgent(workspace, { runtime: 'pi', mode: 'review', task: 'stale-recovery-task', timeout_seconds: 30, thinking: 'low' });
  const recoveredResult = await waitOnDemandAgent(recovered.task_id, 20);
  if (recoveredResult.state !== 'completed') throw new Error(`supervisor did not recover stale state: ${JSON.stringify(recoveredResult)}`);
  const attempts = await Promise.allSettled([
    startOnDemandAgent(workspace, { runtime: 'pi', mode: 'review', task: 'race-task-a', timeout_seconds: 30, thinking: 'low', queue: false }),
    startOnDemandAgent(workspace, { runtime: 'pi', mode: 'review', task: 'race-task-b', timeout_seconds: 30, thinking: 'low', queue: false })
  ]);
  const started = attempts.filter(result => result.status === 'fulfilled');
  const refused = attempts.filter(result => result.status === 'rejected');
  if (started.length !== 1 || refused.length !== 1) throw new Error(`max_concurrency=1 was not enforced: ${JSON.stringify(attempts)}`);
  const first = started[0].value;
  if (first.max_concurrency !== 1) throw new Error(`supervisor reported the wrong concurrency limit: ${JSON.stringify(first)}`);
  const completed = await waitOnDemandAgent(first.task_id, 20);
  if (completed.state !== 'completed' || !completed.stdout_tail.includes('RESULT=PASS')) throw new Error(`on-demand task failed: ${JSON.stringify(completed)}`);

  const noisy = await startOnDemandAgent(workspace, { runtime: 'pi', mode: 'review', task: 'noisy-task', timeout_seconds: 30, thinking: 'low' });
  const noisyResult = await waitOnDemandAgent(noisy.task_id, 20);
  const noisyLog = path.join(noisy.task_dir, 'stdout.log');
  const noisyBytes = (await fs.stat(noisyLog)).size;
  if (noisyResult.state !== 'completed' || noisyBytes > 4 * 1024 * 1024 + 128 || !noisyResult.stdout_tail.includes('output truncated by Agent Loom')) {
    throw new Error(`on-demand output was not bounded: ${JSON.stringify({ noisyBytes, noisyResult })}`);
  }
  const timedOut = await startOnDemandAgent(workspace, { runtime: 'pi', mode: 'review', task: 'timeout-task', timeout_seconds: 30, thinking: 'low' });
  const timedOutResult = await waitOnDemandAgent(timedOut.task_id, 40);
  if (timedOutResult.state !== 'timed_out') throw new Error(`on-demand timeout failed: ${JSON.stringify(timedOutResult)}`);

  const slow = await startOnDemandAgent(workspace, { runtime: 'pi', mode: 'review', task: 'slow-task', timeout_seconds: 30, thinking: 'low' });
  const stopped = await stopOnDemandAgent(slow.task_id);
  const stoppedResult = await waitOnDemandAgent(slow.task_id, 20);
  if (!stopped.stopped || !['stopped', 'failed'].includes(stoppedResult.state)) throw new Error(`on-demand stop failed: ${JSON.stringify(stoppedResult)}`);
  let supervisorStatus = await onDemandAgentStatus();
  for (let attempt = 0; attempt < 100 && supervisorStatus.state !== 'idle'; attempt += 1) {
    await sleep(25);
    supervisorStatus = await onDemandAgentStatus();
  }
  if (supervisorStatus.state !== 'idle') throw new Error(`supervisor did not release the stopped task: ${JSON.stringify(supervisorStatus)}`);
  try { await fs.access(path.join(root, '.git', '.h5i')); throw new Error('on-demand runtime created h5i state'); } catch (error) { if (error?.message === 'on-demand runtime created h5i state') throw error; }
  console.log(JSON.stringify({ completed: completed.state, stale_state_recovered: recoveredResult.state, max_concurrency: first.max_concurrency, concurrency_refused: true, output_bounded: noisyBytes, timed_out: timedOutResult.state, stopped: stoppedResult.state, h5i: false }, null, 2));
} finally {
  const active = await onDemandAgentStatus().catch(() => ({ state: 'idle' }));
  if (active.state !== 'idle') await stopOnDemandAgent().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
