import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAgentPool, runAgentTask, agentPoolStatus, stopAgentPool } from '../dist/agentPoolOps.js';

const runtime = process.argv[2];
if (runtime !== 'pi' && runtime !== 'codex') throw new Error('Usage: node scripts/agent-pool-smoke.mjs <pi|codex>');
const model = runtime === 'pi' ? 'zai/glm-5.3-flash' : 'gpt-5.6-sol';
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
  pool = await createAgentPool(workspace, { runtime, name: `${runtime}-smoke`, agents: [{ id: 'worker', model, role: 'reviewer', thinking: 'low' }], seed_dirty: false });
  const first = await runAgentTask(workspace, { pool_id: pool.pool_id, worker_id: 'worker', prompt: 'Read README.md only, make no edits, reply briefly, and end with RESULT=PASS.', max_wait_seconds: 60 });
  const second = await runAgentTask(workspace, { pool_id: pool.pool_id, worker_id: 'worker', prompt: 'Without rereading files, state the README title from our prior turn and end with RESULT=PASS.', max_wait_seconds: 60 });
  const status = await agentPoolStatus(workspace, { pool_id: pool.pool_id });
  const evidence = { runtime, pool: pool.pool_id, first: first.status, resumed: second.status, running: status.workers[0].running, model: status.workers[0].model };
  console.log(JSON.stringify(evidence, null, 2));
  if (first.state !== 'completed' || first.status !== 'PASS' || second.state !== 'completed' || second.status !== 'PASS' || !status.workers[0].running) process.exitCode = 1;
} finally {
  if (pool) await stopAgentPool(workspace, { pool_id: pool.pool_id, force: true }).catch(() => {});
}
