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
    AGENT_LOOM_TOOL_MODE: 'full',
    AGENT_LOOM_BASH_MODE: 'full',
    AGENT_LOOM_BASH_TRANSCRIPT: 'full',
    AGENT_LOOM_CODEX_SESSIONS: 'read',
    AGENT_LOOM_TOOL_CARDS: '1'
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
    const listedTools = (await a.client.listTools()).tools;
    const tools = listedTools.map(tool => tool.name);
    const bashTool = listedTools.find(tool => tool.name === 'bash');
    if (bashTool?._meta?.['openai/outputTemplate'] !== 'ui://widget/agent-loom-tool-card-v10.html') throw new Error('Agent Loom tool-card metadata missing');
    const requiredTools = ['workspace', 'pi', 'codex', 'read', 'write', 'edit', 'apply_patch', 'bash', 'tree', 'search', 'show_changes'];
    for (const expected of requiredTools) if (!tools.includes(expected)) throw new Error(`missing ${expected}`);
    const listed = await call(a.client, 'workspace', { action: 'list' });
    const wsA = listed.workspaces.find(item => item.root === rootA);
    const wsB = listed.workspaces.find(item => item.root === rootB);
    if (!wsA || !wsB) throw new Error('allowed workspaces were not listed');
    await call(a.client, 'workspace', { action: 'use', workspace_id: wsA.id });
    await call(b.client, 'workspace', { action: 'use', workspace_id: wsB.id });
    const currentA = await call(a.client, 'workspace', { action: 'current' });
    const currentB = await call(b.client, 'workspace', { action: 'current' });
    if (currentA.workspace.root !== rootA || currentB.workspace.root !== rootB) throw new Error('MCP session workspace selections leaked');
    await call(a.client, 'write', { path: 'chat-a.txt', content: 'before\n' });
    const edited = await call(a.client, 'edit', { path: 'chat-a.txt', old_text: 'before', new_text: 'after' });
    const read = await call(a.client, 'read', { path: 'chat-a.txt' });
    const bash = await call(a.client, 'bash', { command: 'pwd' });
    const wrapped = await call(a.client, 'loom', { action: 'config' });
    if (edited.replacements !== 1 || edited.loom_tool !== 'edit' || 'codexpro_tool' in edited || !read.text.includes('after') || bash.stdout.trim() !== rootA || bash.exitCode !== 0) throw new Error(`direct ChatGPT edit/bash tools failed: ${JSON.stringify({ edited, read, bash })}`);
    if (wrapped.loom_tool !== 'server_config' || 'codexpro_tool' in wrapped) throw new Error(`Agent Loom supertool card data failed: ${JSON.stringify(wrapped)}`);
    console.log(JSON.stringify({ tools: requiredTools, chat_a: currentA.workspace.root, chat_b: currentB.workspace.root, same_endpoint: true, direct_edit: true, direct_bash: true }, null, 2));
  } finally {
    await a.client.close();
    await b.client.close();
  }
} finally {
  child.kill('SIGTERM');
}
