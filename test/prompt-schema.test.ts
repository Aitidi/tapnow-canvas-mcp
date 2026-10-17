import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptReferencesSchema, promptSegmentSchema, promptSetSchema } from '../src/server.js';

const canvasId = 'e1bcdd91-a65f-4710-a3ea-08d98a4da442';
const base = { canvasId, nodeId: 'generator', requestId: 'mention-request' };

test('@素材查询默认读取画布，分页限制明确且拒绝未知参数', () => {
  assert.deepEqual(promptReferencesSchema.parse({ canvasId }), { canvasId, source: 'canvas', limit: 50, offset: 0 });
  assert.equal(promptReferencesSchema.safeParse({ canvasId, source: 'library', limit: 100, offset: 20, query: '角色' }).success, true);
  for (const value of [
    { canvasId, source: 'all' }, { canvasId, limit: 101 }, { canvasId, limit: 0 },
    { canvasId, offset: -1 }, { canvasId, offset: 0.5 }, { canvasId, unknown: true },
  ]) assert.equal(promptReferencesSchema.safeParse(value).success, false);
});

test('@素材片段只接受文本或具有明确来源的引用，禁止混入原生代码和属性', () => {
  for (const value of [
    { type: 'text', text: '角色在街道行走' },
    { type: 'reference', source: 'canvas', nodeId: 'image-one' },
    { type: 'reference', source: 'library', assetId: 'character-one' },
  ]) assert.equal(promptSegmentSchema.safeParse(value).success, true);
  for (const value of [
    { type: 'reference', source: 'canvas', assetId: 'library-one' },
    { type: 'reference', source: 'library', nodeId: 'image-one' },
    { type: 'reference', source: 'canvas', nodeId: '' },
    { type: 'reference', source: 'library', assetId: 'x'.repeat(513) },
    { type: 'text', text: 'hello', token: '{{Image 1}}' },
    { type: 'reference', source: 'canvas', nodeId: 'image-one', script: 'alert(1)' },
    { type: 'text', text: 'x'.repeat(200001) },
  ]) assert.equal(promptSegmentSchema.safeParse(value).success, false);
});

test('@素材写入保留片段顺序并限制文本总长、片段数和引用数', () => {
  const segments = [{ type: 'text', text: '参考 ' }, { type: 'reference', source: 'canvas', nodeId: 'source-one' }, { type: 'text', text: ' 和 ' }, { type: 'reference', source: 'library', assetId: 'asset-one' }];
  assert.deepEqual(promptSetSchema.parse({ ...base, segments }), { ...base, segments });
  assert.equal(promptSetSchema.safeParse({ ...base, segments: [{ type: 'text', text: '' }] }).success, true);
  assert.equal(promptSetSchema.safeParse({ ...base, segments: Array.from({ length: 200 }, () => ({ type: 'text', text: '' })) }).success, true);
  assert.equal(promptSetSchema.safeParse({ ...base, segments: Array.from({ length: 32 }, () => ({ type: 'reference', source: 'canvas', nodeId: 'same-source' })) }).success, true);
  for (const value of [
    { ...base, segments: [] },
    { ...base, segments: Array.from({ length: 201 }, () => ({ type: 'text', text: '' })) },
    { ...base, segments: [{ type: 'text', text: 'x'.repeat(100001) }, { type: 'text', text: 'x'.repeat(100000) }] },
    { ...base, segments: Array.from({ length: 33 }, () => ({ type: 'reference', source: 'canvas', nodeId: 'same-source' })) },
    { ...base, requestId: 'short', segments }, { ...base, segments, nativeToken: '{{Image 1}}' },
  ]) assert.equal(promptSetSchema.safeParse(value).success, false);
});
