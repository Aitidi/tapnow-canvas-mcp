import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RequestJournal, digest } from '../src/journal.js';

const endpoint = 'http://127.0.0.1:9222';
const args = { canvasId: 'e1bcdd91-a65f-4710-a3ea-08d98a4da442', requestId: 'generation-123', nodeId: 'node-one' };
const hasCode = (code: string) => (error: any) => error?.code === code;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tapnow-journal-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, journal: new RequestJournal(directory, endpoint), path: join(directory, digest([endpoint, args.canvasId, args.requestId]) + '.json') };
}

test('请求账本持久化后重放结果，重建客户端也不重复执行', async t => {
  const f = await fixture(t);
  let calls = 0;
  const execute = async () => { calls++; return { ok: true, taskId: 'native-task-1' }; };
  assert.deepEqual(await f.journal.run('submitGeneration', args, execute), { ok: true, taskId: 'native-task-1' });
  const restarted = new RequestJournal(f.directory, endpoint);
  assert.deepEqual(await restarted.run('submitGeneration', { ...args }, execute), { ok: true, taskId: 'native-task-1', replayed: true });
  assert.equal(calls, 1);
  const record = await restarted.lookup(args.canvasId, args.requestId);
  assert.equal(record.state, 'done');
  assert.equal(record.nodeId, args.nodeId);
  assert.ok(record.completedAt);
});

test('同 requestId 不同参数或动作拒绝执行', async t => {
  const f = await fixture(t);
  let calls = 0;
  const execute = async () => { calls++; return { ok: true }; };
  await f.journal.run('submitGeneration', args, execute);
  await assert.rejects(f.journal.run('submitGeneration', { ...args, nodeId: 'node-two' }, execute), hasCode('REQUEST_ID_CONFLICT'));
  await assert.rejects(f.journal.run('edit', args, execute), hasCode('REQUEST_ID_CONFLICT'));
  assert.equal(calls, 1);
});

test('规范化指纹不受对象键序影响，数组顺序与具体值仍有区别', () => {
  assert.equal(digest({ x: { a: 1, b: 2 }, y: 3 }), digest({ y: 3, x: { b: 2, a: 1 } }));
  assert.equal(digest({ a: 1, b: undefined }), digest({ a: 1 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.notEqual(digest({ nodeId: 'one' }), digest({ nodeId: 'two' }));
});

test('执行抛异常保留 pending；下一客户端不得自动重试未知结果', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(f.journal.run('submitGeneration', args, async () => { calls++; throw new Error('connection lost after send'); }), /connection lost after send/);
  const restarted = new RequestJournal(f.directory, endpoint);
  await assert.rejects(restarted.run('submitGeneration', args, async () => { calls++; return { ok: true }; }), (error: any) => {
    assert.equal(error.code, 'REQUEST_OUTCOME_UNKNOWN');
    assert.equal(error.details.nodeId, args.nodeId);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal((await restarted.lookup(args.canvasId, args.requestId)).state, 'pending');
});

test('记录损坏时拒绝写操作且保留原文件便于诊断', async t => {
  const f = await fixture(t);
  const invalid = '{"state":"pending"';
  await writeFile(f.path, invalid);
  let calls = 0;
  await assert.rejects(f.journal.run('submitGeneration', args, async () => { calls++; }), hasCode('JOURNAL_ERROR'));
  assert.equal(calls, 0);
  assert.equal(await readFile(f.path, 'utf8'), invalid);
});

test('两个独立客户端同时 claim 同请求，只执行一次', async t => {
  const f = await fixture(t);
  const other = new RequestJournal(f.directory, endpoint);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = async () => { calls++; await gate; return { ok: true, taskId: 'single-task' }; };
  const running = [f.journal.run('submitGeneration', args, execute), other.run('submitGeneration', args, execute)];
  const settled = Promise.allSettled(running);
  // The successful claimant stays blocked until its competitor rejects. This
  // proves exclusion without assuming the filesystem finishes within a delay.
  const loser = Promise.race(running.map(promise => promise.then(() => null, error => error)));
  let timer: ReturnType<typeof setTimeout>;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Both claimants remained active')), 2000); });
    assert.ok(await Promise.race([loser, timeout]));
  } finally { clearTimeout(timer!); release(); }
  const results = await settled;
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(['REQUEST_IN_PROGRESS', 'REQUEST_OUTCOME_UNKNOWN', 'JOURNAL_ERROR'].includes(rejected.reason.code));
  assert.equal((await f.journal.lookup(args.canvasId, args.requestId)).state, 'done');
});

test('完成状态无法落盘时保留 pending，不允许重提可能已执行请求', async t => {
  const f = await fixture(t);
  await mkdir(f.path + '.' + process.pid + '.tmp');
  let calls = 0;
  await assert.rejects(f.journal.run('submitGeneration', args, async () => { calls++; return { ok: true, taskId: 'already-submitted' }; }), hasCode('JOURNAL_ERROR'));
  await assert.rejects(f.journal.run('submitGeneration', args, async () => { calls++; }), hasCode('REQUEST_OUTCOME_UNKNOWN'));
  assert.equal(calls, 1);
  assert.equal((await f.journal.lookup(args.canvasId, args.requestId)).state, 'pending');
});

test('同 requestId 按 endpoint 与画布隔离，路径不使用调用者原始字符串', async t => {
  const f = await fixture(t);
  const otherEndpoint = new RequestJournal(f.directory, 'http://127.0.0.1:9333');
  let calls = 0;
  const execute = async () => { calls++; return { ok: true }; };
  await f.journal.run('edit', { ...args, requestId: '../../unsafe-path' }, execute);
  await f.journal.run('edit', { ...args, canvasId: 'other-canvas', requestId: '../../unsafe-path' }, execute);
  await otherEndpoint.run('edit', { ...args, requestId: '../../unsafe-path' }, execute);
  const names = await readdir(f.directory);
  assert.equal(calls, 3);
  assert.equal(names.length, 3);
  assert.ok(names.every(name => /^[a-f0-9]{64}\.json$/.test(name)));
});
