import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { TapnowService } from '../src/service.js';
import { TapnowError } from '../src/errors.js';

const canvasId = 'e1bcdd91-a65f-4710-a3ea-08d98a4da442';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tapnow-service-test-'));
  const services: TapnowService[] = [];
  const create = () => {
    const service = new TapnowService({ stateDir: directory, endpoint: 'http://127.0.0.1:9222' });
    (service as any).ready = async () => {};
    services.push(service);
    return service;
  };
  t.after(async () => { for (const service of services) await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { create, directory };
}

test('画布 guard 拒绝时不调用编辑且不建立请求账本', async t => {
  const f = await fixture(t), service = f.create();
  let writes = 0;
  (service as any).invoke = async (action: string) => {
    if (action === 'guard') throw new TapnowError('CANVAS_CHANGED', 'switched');
    writes++;
  };
  await assert.rejects(service.edit({ canvasId, requestId: 'request-one', operations: [{ op: 'create' }] }), (error: any) => error.code === 'CANVAS_CHANGED');
  assert.equal(writes, 0);
  assert.equal(await service.journal.lookup(canvasId, 'request-one'), null);
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.lock')).length, 0);
});

test('两服务共享状态目录时串行写入，完成后释放文件锁', async t => {
  const f = await fixture(t), first = f.create(), second = f.create();
  let running = 0, peak = 0, writes = 0;
  const invoke = async (action: string) => {
    if (action === 'guard') return { ok: true };
    running++; peak = Math.max(peak, running); writes++;
    await new Promise(resolve => setTimeout(resolve, 30));
    running--;
    return { ok: true };
  };
  (first as any).invoke = invoke; (second as any).invoke = invoke;
  await Promise.all([
    first.edit({ canvasId, requestId: 'first-request', operations: [{ op: 'create' }] }),
    second.edit({ canvasId, requestId: 'second-request', operations: [{ op: 'create' }] }),
  ]);
  assert.equal(writes, 2);
  assert.equal(peak, 1);
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.lock')).length, 0);
});

test('服务层提交连接超时后重复请求保持未知，不调用第二次提交', async t => {
  const f = await fixture(t), service = f.create();
  let submissions = 0;
  (service as any).invoke = async (action: string) => {
    if (action === 'guard') return { ok: true };
    submissions++;
    throw new TapnowError('OPERATION_TIMEOUT', 'unknown after submission');
  };
  const args = { canvasId, nodeId: 'node-one', requestId: 'request-one' };
  await assert.rejects(service.generationSubmit(args), (error: any) => error.code === 'OPERATION_TIMEOUT');
  await assert.rejects(service.generationSubmit(args), (error: any) => error.code === 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(submissions, 1);
});

test('同导入请求文件内容改变时拒绝重用，避免错误重放上传结果', async t => {
  const f = await fixture(t), service = f.create();
  const path = join(f.directory, 'test.png');
  let imports = 0;
  (service as any).invoke = async (action: string) => {
    if (action === 'guard') return { ok: true };
    imports++;
    return { ok: true, nodeId: 'imported-node' };
  };
  const args = { canvasId, path, requestId: 'import-request' };
  await writeFile(path, 'first sample content');
  await service.importAsset(args);
  await writeFile(path, 'different sample content');
  await assert.rejects(service.importAsset(args), (error: any) => error.code === 'REQUEST_ID_CONFLICT');
  assert.equal(imports, 1);
});

test('@素材列表走只读调用，不建立写入请求账本', async t => {
  const f = await fixture(t), service = f.create();
  const calls: any[] = [];
  (service as any).invoke = async (action: string, args: any) => {
    calls.push({ action, args });
    return { ok: true, items: [] };
  };
  const args = { canvasId, nodeId: 'generator', source: 'library' as const, query: '人物', limit: 10, offset: 20 };
  const result = await service.promptReferences(args);
  assert.deepEqual(result, { ok: true, items: [] });
  assert.deepEqual(calls, [{ action: 'promptReferences', args }]);
  assert.deepEqual(await readdir(f.directory), []);
});

test('@素材写入先检查画布，失败时不调用写入且不记录请求', async t => {
  const f = await fixture(t), service = f.create();
  let writes = 0;
  (service as any).invoke = async (action: string) => {
    if (action === 'guard') throw new TapnowError('CANVAS_CHANGED', 'switched');
    writes++;
    return { ok: true };
  };
  const args = { canvasId, nodeId: 'generator', requestId: 'mention-request', segments: [{ type: 'text' as const, text: '保留原提示词' }] };
  await assert.rejects(service.promptSet(args), (error: any) => error.code === 'CANVAS_CHANGED');
  assert.equal(writes, 0);
  assert.equal(await service.journal.lookup(canvasId, args.requestId), null);
});

test('@素材写入重试复用结果，更改引用不得重用 requestId', async t => {
  const f = await fixture(t), service = f.create();
  let writes = 0;
  const calls: string[] = [];
  (service as any).invoke = async (action: string) => {
    calls.push(action);
    if (action === 'guard') return { ok: true };
    writes++;
    return { ok: true, prompt: '{{Image 1}}', persistence: { status: 'saved', confirmed: true } };
  };
  const args = { canvasId, nodeId: 'generator', requestId: 'mention-request', segments: [{ type: 'reference' as const, source: 'canvas' as const, nodeId: 'source-one' }] };
  const first = await service.promptSet(args);
  assert.deepEqual(await service.promptSet(args), { ...first, replayed: true });
  await assert.rejects(service.promptSet({ ...args, segments: [{ type: 'reference', source: 'canvas', nodeId: 'source-two' }] }), (error: any) => error.code === 'REQUEST_ID_CONFLICT');
  assert.equal(writes, 1);
  assert.deepEqual(calls, ['guard', 'promptSet', 'guard', 'guard']);
});

test('@素材写入连接超时后重试保持未知，避免重复改动', async t => {
  const f = await fixture(t), service = f.create();
  let writes = 0;
  (service as any).invoke = async (action: string) => {
    if (action === 'guard') return { ok: true };
    writes++;
    throw new TapnowError('OPERATION_TIMEOUT', 'unknown after prompt write');
  };
  const args = { canvasId, nodeId: 'generator', requestId: 'mention-request', segments: [{ type: 'reference' as const, source: 'library' as const, assetId: 'library-one' }] };
  await assert.rejects(service.promptSet(args), (error: any) => error.code === 'OPERATION_TIMEOUT');
  await assert.rejects(service.promptSet(args), (error: any) => error.code === 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(writes, 1);
});
