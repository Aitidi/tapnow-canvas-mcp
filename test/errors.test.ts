import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TapnowError, errorResult } from '../src/errors.js';

test('业务错误保留结构化 code 和 details', () => {
  assert.deepEqual(errorResult(new TapnowError('CANVAS_CHANGED', '当前画布已改变', { expected: 'one', actual: 'two' })), {
    ok: false, error: { code: 'CANVAS_CHANGED', message: '当前画布已改变', details: { expected: 'one', actual: 'two' } },
  });
});

test('无 details 时不输出 undefined 属性', () => {
  assert.deepEqual(errorResult(new TapnowError('NOT_CONNECTED', '未连接')), {
    ok: false, error: { code: 'NOT_CONNECTED', message: '未连接' },
  });
});

test('意外异常规范化为 INTERNAL_ERROR 且不携带调用栈', () => {
  assert.deepEqual(errorResult(new Error('unexpected')), { ok: false, error: { code: 'INTERNAL_ERROR', message: 'unexpected' } });
  assert.deepEqual(errorResult('unexpected'), { ok: false, error: { code: 'INTERNAL_ERROR', message: 'unexpected' } });
});
