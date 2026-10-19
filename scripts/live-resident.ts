import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { residentStatus } from '../dist/resident.js';

// Read-only verification. Closing either MCP client must leave the daemon and
// its Chrome connection running. No generation, edits, selection or saving.
process.env.TAPNOW_TARGET ??= 'web';
process.env.TAPNOW_CDP_URL ??= 'chrome';
process.env.TAPNOW_RESIDENT = '1';
const initial = await residentStatus();
assert.equal(initial.running, true, '请先运行 npm run resident:start');
assert.equal(initial.connected, true, '常驻服务需要先连接 Chrome');
const sessions: any[] = [];
for (let index = 0; index < 2; index++) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))], env, stderr: 'pipe' });
  const client = new Client({ name: 'tapnow-resident-verification-' + index, version: '0.2.0' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  let canvas: any;
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 14);
    const result = await client.callTool({ name: 'tapnow_canvas_read', arguments: { includeData: false } }, { timeout: 60000 });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent) + stderr);
    canvas = result.structuredContent;
    assert.equal(canvas.ok, true);
    if (process.env.TAPNOW_TEST_CANVAS_ID) assert.equal(canvas.canvasId, process.env.TAPNOW_TEST_CANVAS_ID);
  } finally { await client.close(); await transport.close(); }
  const status = await residentStatus();
  assert.equal(status.running, true); assert.equal(status.connected, true);
  assert.equal(status.pid, initial.pid); assert.equal(status.startedAt, initial.startedAt); assert.equal(status.targetId, initial.targetId);
  sessions.push({ clientExited: true, backendPid: status.pid, backendStartedAt: status.startedAt, targetId: status.targetId,
    canvasId: canvas.canvasId, nodes: canvas.nodes.length, edges: canvas.edges.length });
}
assert.equal(sessions[0].canvasId, sessions[1].canvasId);
const report = { ok: true, testedAt: new Date().toISOString(), separateStdioClients: 2, backendKeptRunning: true, browserKeptConnected: true, sessions, paidGenerationSubmitted: false };
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/resident-verification.json', JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
