#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loom-apply-'));
const home = path.join(temp, 'home');
const root = path.join(temp, 'main');
const worker = path.join(temp, 'worker');
const conflictWorker = path.join(temp, 'conflict-worker');
await fs.mkdir(home, { recursive: true });
await fs.mkdir(root, { recursive: true });
process.env.HOME = home;
run('git', ['init', '-b', 'main'], root);
run('git', ['config', 'user.name', 'Agent Loom Smoke'], root);
run('git', ['config', 'user.email', 'agent-loom-smoke@local.invalid'], root);
await fs.writeFile(path.join(root, 'worker.txt'), 'base\n');
await fs.writeFile(path.join(root, 'owner.txt'), 'base\n');
run('git', ['add', '.'], root);
run('git', ['commit', '-m', 'base'], root);
const head = run('git', ['rev-parse', 'HEAD'], root).trim();
run('git', ['clone', root, worker], temp);
await fs.writeFile(path.join(worker, 'worker.txt'), 'from worker\n');
const patch = run('git', ['diff', '--binary', 'HEAD'], worker);
await fs.writeFile(path.join(root, 'owner.txt'), 'owner dirty change\n');

const poolId = 'apply-smoke-pool';
const checkpointId = 'w1-20260830130000-a1b2c3';
const workspaceKey = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 20);
const privateDir = path.join(home, '.agent-loom', 'pools', workspaceKey, poolId);
const checkpointDir = path.join(root, '.agent-loom', 'pools', poolId, 'checkpoints');
await fs.mkdir(privateDir, { recursive: true });
await fs.mkdir(checkpointDir, { recursive: true });
await fs.writeFile(path.join(privateDir, 'pool.private.json'), JSON.stringify({
  pool_id: poolId,
  runtime: 'pi',
  root,
  workers: [{ worker_id: 'w1', identity: 'apply-smoke-w1' }]
}));
await fs.writeFile(path.join(checkpointDir, `${checkpointId}.patch`), patch);
await fs.writeFile(path.join(checkpointDir, `${checkpointId}.json`), JSON.stringify({ version: 1, pool_id: poolId, worker_id: 'w1', worker_identity: 'apply-smoke-w1', checkpoint_id: checkpointId, patch_sha256: createHash('sha256').update(patch).digest('hex') }));

const { applyAgentCheckpoint } = await import('../dist/agentPoolOps.js');
const workspace = { root };
const applyOptions = checkpoint_id => ({ pool_id: poolId, worker_id: 'w1', checkpoint_id, write_allowed: true, validate_path: patchPath => {
  const resolved = path.resolve(root, patchPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('path escaped workspace');
  return resolved;
} });
let writeModeRejected = false;
try { await applyAgentCheckpoint(workspace, { ...applyOptions(checkpointId), write_allowed: false }); }
catch (error) { writeModeRejected = String(error).includes('write mode=workspace'); }
if (!writeModeRejected) throw new Error('write policy did not block checkpoint application');
const applied = await applyAgentCheckpoint(workspace, applyOptions(checkpointId));
if (applied.state !== 'applied' || applied.already_applied) throw new Error('checkpoint was not applied');
if (await fs.readFile(path.join(root, 'worker.txt'), 'utf8') !== 'from worker\n') throw new Error('worker delta missing');
if (await fs.readFile(path.join(root, 'owner.txt'), 'utf8') !== 'owner dirty change\n') throw new Error('owner dirty change was overwritten');
if (run('git', ['rev-parse', 'HEAD'], root).trim() !== head) throw new Error('apply_checkpoint created a commit');
const repeated = await applyAgentCheckpoint(workspace, applyOptions(checkpointId));
if (!repeated.already_applied) throw new Error('repeat application was not blocked');

run('git', ['clone', root, conflictWorker], temp);
await fs.writeFile(path.join(conflictWorker, 'worker.txt'), 'conflicting worker\n');
const conflictPatch = run('git', ['diff', '--binary', 'HEAD'], conflictWorker);
const conflictId = 'w1-20260830130001-d4e5f6';
await fs.writeFile(path.join(checkpointDir, `${conflictId}.patch`), conflictPatch);
let conflictRejected = false;
try {
  await applyAgentCheckpoint(workspace, applyOptions(conflictId));
} catch (error) {
  conflictRejected = String(error).includes('rejected it before mutation');
}
if (!conflictRejected) throw new Error('conflicting checkpoint was not rejected atomically');
if (await fs.readFile(path.join(root, 'worker.txt'), 'utf8') !== 'from worker\n') throw new Error('conflict partially changed main worktree');

console.log(JSON.stringify({ applied: true, write_policy: true, dirty_preserved: true, head_unchanged: true, repeat_blocked: true, conflict_atomic: true }, null, 2));
await fs.rm(temp, { recursive: true, force: true });
