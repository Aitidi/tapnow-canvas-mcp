import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { DualService } from '../src/dual.js';
import { TapnowError } from '../src/errors.js';
import { residentConfig } from '../src/resident.js';
import { createServer } from '../src/server.js';

const appCanvas = 'e1bcdd91-a65f-4710-a3ea-08d98a4da442', webCanvas = 'a49d97e2-542f-47da-a984-fd825368a703';
function fake(canvasId: string | null, calls: any[]) {
  return {
    diagnose: async () => { calls.push(['diagnose']); if (!canvasId) throw new TapnowError('NOT_CONNECTED', 'closed'); return { ok: true, canvas: { canvasId } }; },
    inspect: async (args: any) => { calls.push(['inspect', args]); return { ok: true, canvasId }; },
    save: async (args: any) => { calls.push(['save', args]); return { ok: true, canvasId: args.canvasId }; },
    close: async () => { calls.push(['close']); },
  } as any;
}

test('auto 只有一端打开画布时路由到该端，并去掉 target 参数', async () => {
  const app: any[] = [], web: any[] = [];
  const dual: any = new DualService({ app: fake(null, app), web: fake(webCanvas, web) });
  const result = await dual.inspect({ target: 'auto', includeData: true });
  assert.equal(result.target, 'web'); assert.equal(result.canvasId, webCanvas);
  assert.deepEqual(web.at(-1), ['inspect', { includeData: true }]);
  assert.equal(app.filter(c => c[0] === 'inspect').length, 0);
});

test('两端都打开时 auto 拒绝猜测，canvasId 或显式 target 可消除歧义', async () => {
  const app: any[] = [], web: any[] = [];
  const dual: any = new DualService({ app: fake(appCanvas, app), web: fake(webCanvas, web) });
  await assert.rejects(dual.inspect({}), (e: any) => e.code === 'AMBIGUOUS_TARGET' && e.details.sides.length === 2);
  assert.equal((await dual.save({ canvasId: appCanvas })).target, 'app');
  await assert.rejects(dual.save({ canvasId: '00000000-0000-0000-0000-000000000000' }), (e: any) => e.code === 'CANVAS_NOT_FOUND');
  const probes = app.length + web.length;
  assert.equal((await dual.inspect({ target: 'web' })).target, 'web');
  assert.equal(app.length + web.length, probes + 1, '显式 target 不探测另一端');
  await assert.rejects(dual.inspect({ target: 'chrome' }), (e: any) => e.code === 'INVALID_ARGUMENT');
});

test('诊断同时报告两端，一端失败不影响另一端', async () => {
  const dual: any = new DualService({ app: fake(appCanvas, []), web: fake(null, []) });
  const report = await dual.diagnose();
  assert.equal(report.ok, true); assert.equal(report.app.canvas.canvasId, appCanvas); assert.equal(report.web.error.code, 'NOT_CONNECTED');
  const calls: any[] = [];
  await new DualService({ app: fake(null, calls), web: fake(null, calls) }).close();
  assert.equal(calls.filter(c => c[0] === 'close').length, 2);
});

test('仅双端模式的工具接受 target', async () => {
  for (const dual of [false, true]) {
    const { server } = createServer(fake(appCanvas, []), { dual });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'dual-schema', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 14);
      for (const tool of tools) assert.equal('target' in (tool.inputSchema.properties ?? {}), dual, tool.name);
    } finally { await client.close(); }
  }
});

test('常驻配置按目标参数计算，与后台进程从环境变量重建的结果一致', () => {
  const keys = ['TAPNOW_TARGET', 'TAPNOW_CDP_URL', 'TAPNOW_TARGET_ID'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    process.env.TAPNOW_TARGET = 'both'; delete process.env.TAPNOW_CDP_URL; delete process.env.TAPNOW_TARGET_ID;
    const explicit = residentConfig({ endpoint: 'chrome', mode: 'web', targetId: '' });
    Object.assign(process.env, explicit.env);
    assert.equal(residentConfig().id, explicit.id);
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
});
