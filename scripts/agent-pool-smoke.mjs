import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAgentPool, runAgentTask, agentPoolStatus, refreshAgentWorker, stopAgentPool } from '../dist/agentPoolOps.js';

const runtime = process.argv[2];
if (runtime !== 'pi' && runtime !== 'codex') throw new Error('Usage: node scripts/agent-pool-smoke.mjs <pi|codex>');
const model = runtime === 'pi' ? 'zai/glm-5.3-flash' : 'gpt-5.6-sol';
const preferredModel = runtime === 'pi' ? 'missing-provider/missing-model' : model;
const root = await fs.mkdtemp(path.join(os.tmpdir(), `agent-loom-${runtime}-`));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};
run('git', ['init', '-q']);
await fs.writeFile(path.join(root, 'README.md'), '# Agent Loom smoke\n');
run('git', ['add', 'README.md']);
run('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@local.invalid', 'commit', '-q', '-m', 'init']);
const workspace = { id: `smoke-${runtime}`, root };
let pool;
try {
  pool = await createAgentPool(workspace, { runtime, name: `${runtime}-smoke`, agents: [{ id: 'worker', model: preferredModel, role: 'reviewer', thinking: 'low' }], seed_dirty: false });
  const reused = await createAgentPool(workspace, { runtime, name: 'attempted-duplicate', agents: [{ id: 'duplicate', model: preferredModel, role: 'reviewer', thinking: 'low' }], seed_dirty: false });
  if (reused.pool_id !== pool.pool_id || !reused.reused || reused.workers.length !== 1) throw new Error('same-runtime start created a duplicate pool or worker');
  const otherRuntime = runtime === 'pi' ? 'codex' : 'pi';
  const otherModel = otherRuntime === 'pi' ? 'zai/glm-5.3-flash' : 'gpt-5.6-sol';
  const mixed = await createAgentPool(workspace, { runtime: otherRuntime, name: 'attempted-second-pool', agents: [{ id: 'worker', model: otherModel, role: 'reviewer', thinking: 'low' }], seed_dirty: false });
  if (mixed.pool_id !== pool.pool_id || mixed.runtime !== 'mixed' || mixed.workers.length !== 2) throw new Error('second runtime did not extend the canonical pool');
  await stopAgentPool(workspace, { pool_id: pool.pool_id, force: true });
  let stoppedRefreshRefused = false;
  try { await refreshAgentWorker(workspace, { pool_id: pool.pool_id, worker_id: 'worker', seed_dirty: true }); } catch { stoppedRefreshRefused = true; }
  if (!stoppedRefreshRefused) throw new Error('refresh partially revived a stopped pool');
  const restarted = await createAgentPool(workspace, { runtime, name: 'attempted-after-stop', seed_dirty: false });
  if (restarted.pool_id !== pool.pool_id || !restarted.reused) throw new Error('stopped canonical pool was replaced instead of revived');
  pool = restarted;
  const first = await runAgentTask(workspace, { pool_id: pool.pool_id, worker_id: 'worker', prompt: 'Read README.md only, make no edits, reply briefly, and end with RESULT=PASS.', max_wait_seconds: 60 });
  const second = await runAgentTask(workspace, { pool_id: pool.pool_id, worker_id: 'worker', prompt: 'Without rereading files, state the README title from our prior turn and end with RESULT=PASS.', max_wait_seconds: 60 });
  await fs.writeFile(path.join(root, 'HOST-LATEST.txt'), 'fresh-host-snapshot\n');
  const beforeRefreshStatus = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8' }).stdout;
  const beforeRefreshPoolStatus = await agentPoolStatus(workspace, { pool_id: pool.pool_id });
  const workerDir = beforeRefreshPoolStatus.workers.find(worker => worker.worker_id === 'worker').work_dir;
  await fs.writeFile(path.join(workerDir, 'UNPRESERVED.txt'), 'must-not-discard\n');
  let dirtyRefused = false;
  try { await refreshAgentWorker(workspace, { pool_id: pool.pool_id, worker_id: 'worker', seed_dirty: true }); } catch { dirtyRefused = true; }
  if (!dirtyRefused) throw new Error('refresh discarded uncheckpointed worker content');
  await fs.rm(path.join(workerDir, 'UNPRESERVED.txt'));
  const refreshed = await refreshAgentWorker(workspace, { pool_id: pool.pool_id, worker_id: 'worker', seed_dirty: true });
  const afterRefreshStatus = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8' }).stdout;
  if (afterRefreshStatus !== beforeRefreshStatus) throw new Error('refresh mutated the host worktree');
  const fresh = await runAgentTask(workspace, { pool_id: pool.pool_id, worker_id: 'worker', prompt: 'Read HOST-LATEST.txt. If it contains fresh-host-snapshot, end with RESULT=PASS; otherwise end with RESULT=FAIL.', max_wait_seconds: 60 });
  const status = await agentPoolStatus(workspace, { pool_id: pool.pool_id });
  const evidence = { runtime, pool: pool.pool_id, canonical: status.canonical_workspace_pool, mixed: status.runtime === 'mixed', revived: true, stopped_refresh_refused: stoppedRefreshRefused, dirty_refused: dirtyRefused, refreshed: Boolean(refreshed.refreshed_at), workers: status.workers.map(worker => `${worker.runtime}:${worker.worker_id}`), first: first.status, resumed: second.status, fresh_snapshot: fresh.status, attempted_models: first.attempted_models, running: status.workers[0].running, model: status.workers[0].model, model_candidates: status.workers[0].models?.length ?? 0 };
  if (runtime === 'pi' && (first.attempted_models?.length ?? 0) < 2) throw new Error('Pi provider/model failure did not trigger failover');
  console.log(JSON.stringify(evidence, null, 2));
  if (first.state !== 'completed' || first.status !== 'PASS' || second.state !== 'completed' || second.status !== 'PASS' || fresh.status !== 'PASS' || !status.workers[0].running) process.exitCode = 1;
} finally {
  if (pool) await stopAgentPool(workspace, { pool_id: pool.pool_id, force: true }).catch(() => {});
}
