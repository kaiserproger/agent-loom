import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loom-a-'));
const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loom-b-'));
const port = await freePort();
const token = 'agent-loom-routing-smoke-token';
const child = spawn(process.execPath, ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    AGENT_LOOM_ROOT: rootA,
    AGENT_LOOM_ALLOWED_ROOTS: [rootA, rootB].join(path.delimiter),
    AGENT_LOOM_HOST: '127.0.0.1',
    AGENT_LOOM_PORT: String(port),
    AGENT_LOOM_HTTP_TOKEN: token,
    CODEXPRO_TOOL_MODE: 'standard'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const listening = new Promise((resolve, reject) => {
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
    if (stderr.includes('HTTP MCP listening')) resolve();
  });
  child.once('exit', code => reject(new Error(`server exited ${code}: ${stderr}`)));
});
const connect = async name => {
  const client = new Client({ name, version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return { client, transport };
};
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
  return result.structuredContent;
};
try {
  await listening;
  const a = await connect('chat-a');
  const b = await connect('chat-b');
  try {
    const tools = (await a.client.listTools()).tools.map(tool => tool.name);
    for (const expected of ['workspace', 'pi', 'codex']) if (!tools.includes(expected)) throw new Error(`missing ${expected}`);
    const listed = await call(a.client, 'workspace', { action: 'list' });
    const wsA = listed.workspaces.find(item => item.root === rootA);
    const wsB = listed.workspaces.find(item => item.root === rootB);
    if (!wsA || !wsB) throw new Error('allowed workspaces were not listed');
    await call(a.client, 'workspace', { action: 'use', workspace_id: wsA.id });
    await call(b.client, 'workspace', { action: 'use', workspace_id: wsB.id });
    const currentA = await call(a.client, 'workspace', { action: 'current' });
    const currentB = await call(b.client, 'workspace', { action: 'current' });
    if (currentA.workspace.root !== rootA || currentB.workspace.root !== rootB) throw new Error('MCP session workspace selections leaked');
    console.log(JSON.stringify({ tools: ['workspace', 'pi', 'codex'], chat_a: currentA.workspace.root, chat_b: currentB.workspace.root, same_endpoint: true }, null, 2));
  } finally {
    await a.client.close();
    await b.client.close();
  }
} finally {
  child.kill('SIGTERM');
}
