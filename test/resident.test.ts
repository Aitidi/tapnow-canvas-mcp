import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TapnowError } from '../src/errors.js';
import { createResidentService, ensureResident, readResidentRecord, residentConfig, residentRequest, residentStatus, stopResident } from '../src/resident.js';
import { startResidentWorker } from '../src/resident-worker.js';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tapnow-resident-test-'));
  const keys = ['TAPNOW_STATE_DIR', 'TAPNOW_CDP_URL', 'TAPNOW_TARGET', 'TAPNOW_TARGET_ID', 'TAPNOW_CHROME_USER_DATA_DIR'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.TAPNOW_STATE_DIR = directory; process.env.TAPNOW_CDP_URL = 'http://127.0.0.1:19222'; process.env.TAPNOW_TARGET = 'web';
  delete process.env.TAPNOW_TARGET_ID; delete process.env.TAPNOW_CHROME_USER_DATA_DIR;
  t.after(async () => {
    await stopResident().catch(() => {});
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(directory, { recursive: true, force: true });
  });
  return residentConfig();
}

test('常驻 IPC 需要认证且只开放固定服务方法，状态检查不调用浏览器', async t => {
  const config = await setup(t); let calls = 0, closed = 0;
  const worker = await startResidentWorker(config, { cdp: { status: { connected: false } }, diagnose: async () => { calls++; return { ok: true }; }, close: async () => { closed++; } });
  t.after(() => worker.shutdown());
  const record = (await readResidentRecord(config))!;
  assert.equal((await residentStatus(config)).running, true); assert.equal(calls, 0);
  await assert.rejects(residentRequest({ ...record, token: '0'.repeat(64) }, 'diagnose'), (e: any) => e.code === 'RESIDENT_UNAUTHORIZED');
  for (const method of ['constructor', 'cdp', 'eval', 'close']) await assert.rejects(residentRequest(record, method), (e: any) => e.code === 'INVALID_ACTION');
  await assert.rejects(residentRequest(record, 'diagnose', []), (e: any) => e.code === 'INVALID_ARGUMENT');
  assert.equal(calls, 0); assert.equal(closed, 0);
  assert.equal((await residentRequest(record, 'diagnose')).ok, true); assert.equal(calls, 1);
  await stopResident(config); assert.equal(closed, 1); assert.equal((await residentStatus(config)).running, false);
});

test('关闭多个代理不关闭后台服务，失败调用保留错误且不重放', async t => {
  const config = await setup(t); let calls = 0, closed = 0;
  const worker = await startResidentWorker(config, { cdp: { status: { connected: true } }, close: async () => { closed++; },
    edit: async () => { calls++; throw new TapnowError('OPERATION_TIMEOUT', 'unknown', { requestId: 'original' }); } });
  t.after(() => worker.shutdown());
  const first = createResidentService(), second = createResidentService();
  await assert.rejects(first.edit({ canvasId: 'canvas', requestId: 'original', operations: [] }), (e: any) => e.code === 'OPERATION_TIMEOUT' && e.details.requestId === 'original');
  await first.close(); await second.close();
  assert.equal(calls, 1); assert.equal(closed, 0); assert.equal((await residentStatus(config)).connected, true);
});

test('并发启动复用唯一后台进程且不会主动连接 Chrome', async t => {
  const config = await setup(t);
  const records = await Promise.all([ensureResident(config), ensureResident(config), ensureResident(config)]);
  assert.equal(new Set(records.map(r => r.pid)).size, 1); assert.equal(new Set(records.map(r => r.token)).size, 1);
  assert.equal((await residentStatus(config)).connected, false);
  assert.equal((await stopResident(config)).stopped, true);
});

test('独立 stdio MCP 客户端先后退出后仍复用同一后台服务', async t => {
  const config = await setup(t); let reads = 0, closed = 0;
  const worker = await startResidentWorker(config, { cdp: { status: { connected: true, targetId: 'same-browser-target' } }, close: async () => { closed++; },
    inspect: async () => { reads++; return { ok: true, canvasId: 'same-canvas', nodes: [], edges: [] }; } });
  t.after(() => worker.shutdown());
  const pids: number[] = [];
  for (let i = 0; i < 2; i++) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined)) as Record<string, string>;
    env.TAPNOW_RESIDENT = '1';
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL('../src/server.ts', import.meta.url))], env, stderr: 'pipe' });
    const client = new Client({ name: 'resident-test-' + i, version: '1' });
    try {
      await client.connect(transport); assert.equal((await client.listTools()).tools.length, 14);
      const result = await client.callTool({ name: 'tapnow_canvas_read', arguments: {} });
      assert.equal(result.structuredContent?.canvasId, 'same-canvas');
    } finally { await client.close(); await transport.close(); }
    pids.push((await residentStatus(config)).pid);
  }
  assert.deepEqual(pids, [process.pid, process.pid]); assert.equal(reads, 2); assert.equal(closed, 0);
});
