import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { CdpConnection, isTapnowTarget, type Target } from '../src/cdp.js';

async function fixture(t: TestContext) {
  let targets: unknown = [];
  const server = createServer((request, response) => {
    if (request.url !== '/json/list') { response.writeHead(404).end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(targets));
  });
  const wss = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const connection = new CdpConnection(`http://127.0.0.1:${port}`);
  const target = (overrides: Partial<Target> = {}): Target => ({
    id: 'tapnow-main', title: 'TapNow', type: 'page', url: 'tapnow://app/editor/canvas-one',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/main`, ...overrides,
  });
  t.after(async () => {
    connection.close();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { connection, wss, target, setTargets: (value: unknown) => { targets = value; } };
}

const hasCode = (code: string) => (error: any) => error?.code === code;

test('仅允许没有凭据的本机 HTTP 调试端点', () => {
  for (const endpoint of [
    'http://example.com:9222', 'http://192.168.1.2:9222', 'https://127.0.0.1:9222',
    'http://localhost:9222', 'http://user:secret@127.0.0.1:9222', 'http://127.0.0.1:9222/json/list',
  ]) assert.throws(() => new CdpConnection(endpoint), hasCode('INVALID_ENDPOINT'), endpoint);
  assert.equal(new CdpConnection('http://127.0.0.1:9222').endpoint, 'http://127.0.0.1:9222');
  assert.equal(new CdpConnection('http://[::1]:9222').endpoint, 'http://[::1]:9222');
});

test('拒绝普通网页、开发者工具和伪装 Tapnow 域名', async t => {
  const f = await fixture(t);
  f.setTargets([
    f.target({ id: 'browser', url: 'https://tapnow.ai/canvas' }),
    f.target({ id: 'devtools', type: 'other', url: 'tapnow://app/editor' }),
    f.target({ id: 'lookalike', url: 'tapnow://app.evil/editor' }),
    f.target({ id: 'suffix', url: 'tapnow://application/editor' }),
  ]);
  await assert.rejects(f.connection.connect(), hasCode('APP_PAGE_NOT_FOUND'));
});

test('存在多个 Tapnow 主窗口时拒绝猜测活动画布', async t => {
  const f = await fixture(t);
  f.setTargets([f.target(), f.target({ id: 'second', url: 'tapnow://app/editor/other' })]);
  await assert.rejects(f.connection.connect(), (error: any) => {
    assert.equal(error.code, 'AMBIGUOUS_WINDOW');
    assert.equal(error.details.candidates.length, 2);
    return true;
  });
});

test('拒绝非本机、异端口和加密 WebSocket 目标', async t => {
  const f = await fixture(t);
  for (const webSocketDebuggerUrl of [
    'ws://example.com:9222/debug', 'ws://192.168.1.2:9222/debug',
    'ws://127.0.0.1:1/debug', 'wss://127.0.0.1:9222/debug',
  ]) {
    f.setTargets([f.target({ webSocketDebuggerUrl })]);
    await assert.rejects(f.connection.connect(), hasCode('INVALID_TARGET'));
  }
});

test('拒绝携带凭据的本机 WebSocket 目标', async t => {
  const f = await fixture(t);
  const target = f.target();
  target.webSocketDebuggerUrl = target.webSocketDebuggerUrl.replace('ws://', 'ws://user:secret@');
  f.setTargets([target]);
  await assert.rejects(f.connection.connect(), hasCode('INVALID_TARGET'));
});

test('非数组和缺少字段的目标列表返回结构化错误', async t => {
  const f = await fixture(t);
  for (const invalid of [null, {}, [{ id: 'broken' }], [null]]) {
    f.setTargets(invalid);
    await assert.rejects(f.connection.connect(), hasCode('INVALID_TARGET_LIST'));
  }
});

test('无效 JSON 帧关闭连接并拒绝在途操作', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  f.wss.on('connection', socket => socket.on('message', () => socket.send('{invalid-json')));
  await f.connection.connect();
  await assert.rejects(f.connection.send('Pending'), hasCode('CONNECTION_LOST'));
});

test('JSON null 帧安全关闭连接而不会抛出未捕获异常', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  f.wss.on('connection', socket => socket.on('message', () => socket.send('null')));
  await f.connection.connect();
  await assert.rejects(f.connection.send('Pending'), hasCode('CONNECTION_LOST'));
});

test('真实 JSON RPC 往返保留请求参数且按 ID 对应并发响应', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  const requests: any[] = [];
  f.wss.on('connection', socket => socket.on('message', raw => {
    requests.push(JSON.parse(raw.toString()));
    if (requests.length !== 2) return;
    for (const request of requests.slice().reverse()) socket.send(JSON.stringify({ id: request.id, result: { method: request.method, params: request.params } }));
  }));
  await f.connection.connect();
  const result = await Promise.all([f.connection.send('First', { value: 1 }), f.connection.send('Second', { value: 2 })]);
  assert.deepEqual(result, [{ method: 'First', params: { value: 1 } }, { method: 'Second', params: { value: 2 } }]);
  assert.notEqual(requests[0].id, requests[1].id);
});

test('连接复用同一目标；evaluate 使用返回值及 awaitPromise', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  let connections = 0;
  f.wss.on('connection', socket => {
    connections++;
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      assert.equal(request.method, 'Runtime.evaluate');
      assert.deepEqual(request.params, { expression: 'Promise.resolve({ ok: true })', awaitPromise: true, returnByValue: true, userGesture: true });
      socket.send(JSON.stringify({ id: request.id, result: { result: { value: { ok: true } } } }));
    });
  });
  await f.connection.connect();
  await f.connection.connect();
  assert.deepEqual(await f.connection.evaluate('Promise.resolve({ ok: true })'), { ok: true });
  assert.equal(connections, 1);
});

test('evaluate 将页面异常转换为结构化 ADAPTER_ERROR', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  f.wss.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    socket.send(JSON.stringify({ id: request.id, result: { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: canvas changed' } } } }));
  }));
  await f.connection.connect();
  await assert.rejects(f.connection.evaluate('throw new Error()'), (error: any) => error.code === 'ADAPTER_ERROR' && error.message === 'Error: canvas changed');
});

test('CDP 协议错误转换为 CDP_ERROR', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  f.wss.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Unknown method' } }));
  }));
  await f.connection.connect();
  await assert.rejects(f.connection.send('Unknown'), (error: any) => error.code === 'CDP_ERROR' && error.message === 'Unknown method');
});

test('未连接时立即拒绝发送', async () => {
  const connection = new CdpConnection();
  await assert.rejects(connection.send('Runtime.evaluate'), hasCode('NOT_CONNECTED'));
});

test('请求超时后清理等待项且不会自动重发', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  let requests = 0;
  f.wss.on('connection', socket => socket.on('message', () => { requests++; }));
  await f.connection.connect();
  await assert.rejects(f.connection.send('Runtime.evaluate', {}, 20), (error: any) => error.code === 'OPERATION_TIMEOUT' && error.details.method === 'Runtime.evaluate');
  assert.equal(requests, 1);
});

test('连接中断拒绝所有在途请求且后续操作必须重连', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  let serverSocket: WebSocket | undefined;
  f.wss.on('connection', socket => {
    serverSocket = socket;
    socket.on('message', () => socket.close());
  });
  await f.connection.connect();
  const promises = [f.connection.send('First'), f.connection.send('Second')];
  const results = await Promise.allSettled(promises);
  assert.ok(serverSocket);
  for (const result of results) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason.code, 'CONNECTION_LOST'); }
  await assert.rejects(f.connection.send('Third'), hasCode('NOT_CONNECTED'));
});

test('主动关闭连接立即拒绝在途请求', async t => {
  const f = await fixture(t);
  f.setTargets([f.target()]);
  await f.connection.connect();
  const request = f.connection.send('Pending');
  f.connection.close();
  await assert.rejects(request, hasCode('CONNECTION_LOST'));
});

test('网页模式仅接受官方 HTTPS 画布，默认桌面模式不附着网页', () => {
  const canvas = 'https://app.tapnow.ai/canvas/f45bf063-e173-4ebb-bcdc-b5c70c60f464';
  assert.equal(isTapnowTarget(canvas, 'web'), true);
  assert.equal(isTapnowTarget(canvas, 'desktop'), false);
  for (const url of [canvas.replace('https:', 'http:'), canvas.replace('app.tapnow.ai', 'app.tapnow.ai.evil'),
    canvas.replace('app.tapnow.ai', 'user:secret@app.tapnow.ai'), canvas.replace('app.tapnow.ai', 'app.tapnow.ai:444'),
    'https://app.tapnow.ai/home', 'https://app.tapnow.ai/canvas/broken', 'tapnow://app/canvas/test']) {
    assert.equal(isTapnowTarget(url, 'web'), false, url);
  }
});

test('浏览器 WebSocket 端点拒绝外网、凭据、查询参数及页面级路径', () => {
  for (const endpoint of ['ws://example.com:9222/devtools/browser/abc', 'ws://user:secret@127.0.0.1:9222/devtools/browser',
    'ws://127.0.0.1:9222/devtools/page/abc', 'ws://127.0.0.1:9222/devtools/browser?token=abc',
    'http://127.0.0.1:9222/?token=abc', 'http://127.0.0.1:9222/#hash']) {
    assert.throws(() => new CdpConnection(endpoint), hasCode('INVALID_ENDPOINT'));
  }
  assert.equal(new CdpConnection('chrome', { mode: 'web' }).endpoint, 'chrome');
});

test('浏览器会话通过 Target 协议选定网页，读写与截图命令携带同一 sessionId', async t => {
  const f = await fixture(t);
  const endpoint = f.connection.endpoint.replace('http:', 'ws:') + '/devtools/browser/test';
  const connection = new CdpConnection(endpoint, { mode: 'web' });
  t.after(() => connection.close());
  const calls: any[] = [];
  f.wss.on('connection', socket => socket.on('message', raw => {
    const call = JSON.parse(raw.toString()); calls.push(call);
    const result = call.method === 'Target.getTargets' ? { targetInfos: [
      { targetId: 'desktop', type: 'page', url: 'tapnow://app/canvas/test' },
      { targetId: 'web', type: 'page', url: 'https://app.tapnow.ai/canvas/f45bf063-e173-4ebb-bcdc-b5c70c60f464' },
      { targetId: 'other', type: 'page', url: 'https://example.com/' },
    ] } : call.method === 'Target.attachToTarget' ? { sessionId: 'canvas-session' } : { result: { value: 'ok' } };
    socket.send(JSON.stringify({ id: call.id, result, ...(call.sessionId ? { sessionId: call.sessionId } : {}) }));
  }));
  assert.equal((await connection.connect()).id, 'web');
  await connection.connect();
  assert.equal(await connection.evaluate('document.title'), 'ok');
  await connection.send('Page.captureScreenshot');
  assert.equal(calls.filter(c => c.method === 'Target.attachToTarget').length, 1);
  assert.deepEqual(calls.find(c => c.method === 'Target.attachToTarget').params, { targetId: 'web', flatten: true });
  assert.equal(calls.find(c => c.method === 'Runtime.evaluate').sessionId, 'canvas-session');
  assert.equal(calls.find(c => c.method === 'Page.captureScreenshot').sessionId, 'canvas-session');
  assert.equal(calls.filter(c => c.method.startsWith('Target.')).every(c => c.sessionId === undefined), true);
});

test('网页多个标签时拒绝猜测，指定目标 ID 后才允许连接', async t => {
  const f = await fixture(t);
  const endpoint = f.connection.endpoint.replace('http:', 'ws:') + '/devtools/browser/test';
  const first = new CdpConnection(endpoint, { mode: 'web' });
  const second = new CdpConnection(endpoint, { mode: 'web', targetId: 'two' });
  t.after(() => { first.close(); second.close(); });
  const attaches: string[] = [];
  f.wss.on('connection', socket => socket.on('message', raw => {
    const call = JSON.parse(raw.toString());
    if (call.method === 'Target.attachToTarget') attaches.push(call.params.targetId);
    socket.send(JSON.stringify({ id: call.id, result: call.method === 'Target.getTargets' ? { targetInfos: ['one', 'two'].map(targetId => ({ targetId, type: 'page', url: 'https://app.tapnow.ai/canvas/f45bf063-e173-4ebb-bcdc-b5c70c60f464' })) } : { sessionId: 'chosen' } }));
  }));
  await assert.rejects(first.connect(), hasCode('AMBIGUOUS_WINDOW'));
  assert.deepEqual(attaches, []);
  assert.equal((await second.connect()).id, 'two');
  assert.deepEqual(attaches, ['two']);
});
