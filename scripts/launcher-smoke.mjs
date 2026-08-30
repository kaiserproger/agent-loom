#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const child = spawn(process.execPath, [
  path.join(root, 'scripts', 'agent-loom.mjs'), 'start',
  '--root', root,
  '--port', String(port),
  '--tunnel', 'none',
  '--bash', 'full',
  '--tool-mode', 'full',
  '--bash-transcript', 'full',
  '--codex-sessions', 'read',
  '--allow-root', '/tmp',
  '--allow-root', path.dirname(root),
  '--tool-cards', 'on'
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let client;
const endpoint = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('launcher did not publish its MCP URL')), 20_000);
  const consume = chunk => {
    output += chunk.toString();
    const match = output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/mcp\\?agent_loom_token=[a-f0-9]+`));
    if (match) {
      clearTimeout(timeout);
      resolve(match[0]);
    }
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('exit', code => {
    if (code !== null && code !== 0) {
      clearTimeout(timeout);
      reject(new Error(`launcher exited ${code}`));
    }
  });
});
try {
  if (!output.includes('tools=full') || !output.includes('write=workspace') || !output.includes('bash=full') || !output.includes('sessions=read')) {
    throw new Error('launcher did not preserve requested runtime modes');
  }
  client = new Client({ name: 'agent-loom-launcher-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const tools = (await client.listTools()).tools;
  const names = tools.map(tool => tool.name);
  for (const name of ['workspace', 'pi', 'codex', 'read', 'write', 'edit', 'bash', 'loom', 'loom_inventory']) {
    if (!names.includes(name)) throw new Error(`launcher full mode omitted ${name}`);
  }
  const pi = tools.find(tool => tool.name === 'pi');
  if (!pi?.description?.includes('No h5i')) throw new Error('launcher did not expose bounded on-demand agents');
  const bash = tools.find(tool => tool.name === 'bash');
  if (bash?._meta?.['openai/outputTemplate'] !== 'ui://widget/agent-loom-tool-card-v10.html') throw new Error('launcher tool cards are not enabled');
  console.log(JSON.stringify({ tool_mode: 'full', write: 'workspace', bash: 'full', transcript: 'full', codex_sessions: 'read', tool_cards: true }, null, 2));
} finally {
  await client?.close().catch(() => {});
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}
