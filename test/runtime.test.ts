import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { installRuntime } from '../src/adapter/runtime.js';

const canvasId = 'e1bcdd91-a65f-4710-a3ea-08d98a4da442';
const otherCanvasId = '00000000-0000-0000-0000-000000000002';

function fixture(options: { webDockbar?: { disabled?: boolean; extraNode?: boolean }; flushResult?: string; switchAfterChange?: boolean; policy?: any; initialNodes?: any[]; initialEdges?: any[]; history?: 'local' | 'collab'; mutateDuringFlush?: boolean; audioPanel?: { disabled?: boolean; priceLoading?: boolean; duplicate?: boolean }; modelDefaults?: Record<string, Record<string, Record<string, unknown>>>; mentions?: { readonly?: boolean; rejectAsset?: boolean; libraryItems?: any[]; missingMentionItems?: boolean } } = {}) {
  let nodes: any[] = options.initialNodes ?? [], edges: any[] = options.initialEdges ?? [];
  let edits = 0, flushes = 0, factories = 0, uploads = 0, generations = 0;
  let uploadedFile: File | undefined;
  let promptDraft = '', promptChanges = 0, libraryGets = 0;
  const historyCalls: Record<string, number> = { localUndo: 0, localRedo: 0, collabUndo: 0, collabRedo: 0 };
  const location = { pathname: '/canvas/' + canvasId, href: 'tapnow://app/canvas/' + canvasId };
  const store = { getState: () => ({ nodes, nodeLookup: new Map(nodes.map(n => [n.id, n])), triggerNodeChanges() {}, transform: [0, 0, 1] }), subscribe() {} };
  const flow = { getNodes: () => nodes, getEdges: () => edges, deleteElements: async (args: any) => {
    if (args.nodes) nodes = nodes.filter(n => !args.nodes.some((item: any) => n.id === item.id));
    if (args.edges) edges = edges.filter(e => !args.edges.some((item: any) => e.id === item.id));
  } };
  const props = {
    'data-keyboard-scope': 'canvas', nodeTypes: { text: {}, image: {}, video: {}, audio: {}, group: {} }, nodesDraggable: true,
    onNodesChange(changes: any[]) {
      edits++;
      for (const change of changes) {
        if (change.type === 'add') nodes.push(change.item);
        else if (change.type === 'remove') nodes = nodes.filter(n => n.id !== change.id);
        else if (change.type === 'replace') nodes = nodes.map(n => n.id === change.id ? change.item : n);
        else nodes = nodes.map(n => n.id === change.id ? { ...n, ...(change.position ? { position: change.position } : {}), ...(change.type === 'select' ? { selected: change.selected } : {}) } : n);
      }
      if (options.switchAfterChange) location.pathname = '/canvas/' + otherCanvasId;
    },
    onConnect(connection: any) { edges.push({ id: 'edge-' + edges.length, ...connection }); },
    isValidConnection: () => true,
  };
  const viewport = { fitView: async () => {}, setViewport: async () => {} };
  const panel = { nodeId: 'generator', canGenerate: true, onGenerate() { generations++; } };
  const owner: any = { memoizedProps: { canvasId, nodes, edges, isCollaborationEnabled: options.history === 'collab' } };
  const audioControl = { onClick() { generations++; }, sending: false, isGenerating: false, disabled: options.audioPanel?.disabled ?? false, priceLoading: options.audioPanel?.priceLoading ?? false, estimatedPrice: 3 };
  const panelFiber = options.audioPanel ? { memoizedProps: { nodeId: 'generator', onGenerateReady() {}, voiceInput: null, lyrics: '' }, child: { memoizedProps: audioControl, ...(options.audioPanel.duplicate ? { sibling: { memoizedProps: { ...audioControl } } } : {}) } } : { memoizedProps: panel };
  const fibers: any[] = [owner, { memoizedProps: props }, { memoizedProps: { value: store } }, { memoizedProps: { value: flow } }, { memoizedProps: { value: viewport } }, panelFiber];
  if (options.mentions) {
    const mentionItems = () => options.mentions?.missingMentionItems ? [] : edges.filter(e => e.target === 'generator').map((e, index) => ({ id: e.source, label: nodes.find(n => n.id === e.source)?.data.title ?? e.source, renderText: 'Image ' + (index + 1) }));
    fibers.push({ memoizedProps: { nodeId: 'generator', isReadonly: options.mentions.readonly, onPromptChange(value: string) { promptChanges++; promptDraft = value; } }, child: { memoizedProps: {
      get mentionItems() { return mentionItems(); },
      tiptapRef: { current: { getMentionIds() { return [...new Set(mentionItems().filter(item => promptDraft.includes('{{' + item.renderText + '}}')).map(item => item.id))]; } } },
    } } });
  }
  fibers.forEach((f, index) => { f.sibling = fibers[index + 1]; });
  const root = { '__reactContainer$test': { stateNode: { current: fibers[0] } } };
  const document = { title: 'test', getElementById: () => root, querySelector: () => null };
  const make = (kind: string) => (data: any, config: any) => {
    factories++;
    const defaults = options.modelDefaults?.[kind]?.[data.params?.model];
    const initialized = defaults ? { ...data, params: { ...defaults, ...data.params } } : data;
    return { id: 'native-' + factories, type: kind, position: { x: 0, y: 0 }, data: initialized, ...config };
  };
  const native: any = {
    factories: { text: make('text'), textGenerate: make('text'), image: make('image'), imageUpload: make('image'), videoUpload: make('video'), audio: make('audio'), group: make('group') },
    modelRegistries: { image: options.modelDefaults?.image ?? {}, audio: [{ model: 'audio-model', provider: 'native' }, ...Object.keys(options.modelDefaults?.audio ?? {}).map(model => ({ model, provider: 'native' }))] },
    flush: async () => { flushes++; if (options.mutateDuringFlush && nodes.length) nodes = nodes.map(n => ({ ...n, data: { ...n.data, text: 'latest-after-save' } })); return options.flushResult ?? 'saved'; },
    upload: async (file: File) => { uploads++; uploadedFile = file; return { url: 'https://assets.example/test.png' }; },
    policy: { getState: () => ({ mergedPolicy: options.policy ?? {} }) }, selection: { getState: () => ({ setSelectedNodes() {} }) },
  };
  if (options.mentions) native.mentions = {
    parseAsset(payload: any) { return options.mentions?.rejectAsset ? null : payload; },
    library: {
      async list(args: any) {
        const items = (options.mentions?.libraryItems ?? []).filter(item => !args.query || item.label.includes(args.query));
        return { items: items.slice(args.offset, args.offset + args.limit), hasMore: args.offset + args.limit < items.length, nextOffset: args.offset + args.limit < items.length ? args.offset + args.limit : null };
      },
      async get(assetId: string) { libraryGets++; return options.mentions?.libraryItems?.find(item => item.assetId === assetId) ?? null; },
    },
  };
  const sandbox: any = { location, document, native, console, Map, Set, File, atob, setTimeout: (fn: () => void) => setTimeout(fn, 0), __name: (value: any) => value };
  if (options.webDockbar) {
    delete native.factories.text;
    delete native.factories.textGenerate;
    delete native.factories.audio;
    Object.assign(location, { origin: 'https://app.tapnow.ai', href: 'https://app.tapnow.ai/canvas/' + canvasId });
    let open = false;
    const trigger = { __reactProps$test: { onClick() { open = true; } } };
    const button = { disabled: false, getAttribute: () => null, closest: () => trigger };
    const item = { getAttribute: () => options.webDockbar?.disabled ? 'true' : null, click() {
      open = false;
      nodes.push({ id: 'native-menu-text', type: 'text', position: { x: 0, y: 0 }, data: { type: 'generate', title: 'Text', text: '', prompt: '', params: { model: 'native-default', provider: 'native' } } });
      if (options.webDockbar?.extraNode) nodes.push({ id: 'concurrent-node', type: 'image', position: { x: 0, y: 0 }, data: {} });
    } };
    const audioItem = { getAttribute: () => null, click() {
      open = false;
      nodes.push({ id: 'native-menu-audio', type: 'audio', position: { x: 0, y: 0 }, data: { type: 'default', title: 'Audio', src: '', params: { model: 'native-default', provider: 'native', scene: 'Music' } } });
    } };
    document.querySelector = (selector: string): any => selector.includes('dockbar-add-node-btn') ? button : selector.includes('dockbar-add-text-node-btn') && open ? item : selector.includes('dockbar-add-audio-node-btn') && open ? audioItem : null;
    sandbox.MouseEvent = class { constructor(public type: string, public options: any) {} };
  }
  if (options.history) {
    const restored = [{ id: 'restored-new-id', type: 'text', position: { x: 0, y: 0 }, data: { text: 'restored content' } }];
    sandbox.queue = { flush() {} };
    sandbox.history = { current: [{ state: { nodes: [], edges: [] } }, { state: { nodes: restored, edges: [] } }] };
    sandbox.collaborationState = (direction: string) => ({ nodeChanges: [], edgeChanges: [], nextState: { nodes: direction === 'undo' ? restored : [], edges: [] } });
    sandbox.applyHistory = (family: string, direction: string, state: any) => {
      historyCalls[family + (direction === 'undo' ? 'Undo' : 'Redo')]++;
      // Model native deletion/restoration animations completing after more than
      // one renderer turn. The adapter must wait before snapshotting or saving.
      setTimeout(() => setTimeout(() => { nodes = state.nodes; edges = state.edges; }, 0), 0);
      return state;
    };
    const callbacks = runInNewContext(`[
      ()=>{queue.flush();const i=1;if(i<=0)return null;const state=history.current[i]?.state;return applyHistory("local","undo",state)},
      ()=>{queue.flush();const i=0;if(i>=history.current.length-1)return null;const state=history.current[i]?.state;return applyHistory("local","redo",{nodes:[],edges:[]})},
      ()=>{queue.flush();const{nodeChanges:n,edgeChanges:e,nextState:s}=collaborationState("undo");return applyHistory("collab","undo",s)},
      ()=>{queue.flush();const{nodeChanges:n,edgeChanges:e,nextState:s}=collaborationState("redo");return applyHistory("collab","redo",s)}
    ]`, sandbox);
    const hooks = callbacks.map((callback: any) => ({ memoizedState: [callback, []], next: null }));
    hooks.forEach((hook: any, index: number) => { hook.next = hooks[index + 1]; });
    owner.memoizedState = hooks[0];
  }
  runInNewContext(`(${installRuntime.toString()})(native)`, sandbox);
  return {
    dispatch: async (action: string, args?: any) => JSON.parse(JSON.stringify(await sandbox.__tapnowCanvasMcp.dispatch(action, args))),
    counters: () => ({ edits, flushes, factories, uploads, generations }),
    currentNodes: () => JSON.parse(JSON.stringify(nodes)),
    currentEdges: () => JSON.parse(JSON.stringify(edges)),
    mentionState: () => ({ promptDraft, promptChanges, libraryGets }),
    historyCalls: () => ({ ...historyCalls }),
    uploadedFile: () => uploadedFile,
  };
}

test('大视频仅在所有分块完整到达后调用原生上传，并保留文件字节与名称', async () => {
  const f = fixture(), transferId = 'test-transfer';
  assert.equal((await f.dispatch('importFileBegin', { canvasId, transferId, size: 6, name: '原始视频.mp4', mimeType: 'video/mp4' })).ok, true);
  assert.equal((await f.dispatch('importFileChunk', { canvasId, transferId, offset: 0, base64: Buffer.from('abc').toString('base64') })).ok, true);
  const incomplete = await f.dispatch('importAsset', { canvasId, kind: 'video', file: { transferId } });
  assert.equal(incomplete.error.code, 'INCOMPLETE_TRANSFER'); assert.equal(f.counters().uploads, 0);
  assert.equal((await f.dispatch('importFileChunk', { canvasId, transferId, offset: 3, base64: Buffer.from('def').toString('base64') })).ok, true);
  const uploaded = await f.dispatch('importAsset', { canvasId, kind: 'video', file: { transferId } });
  assert.equal(uploaded.ok, true); assert.equal(f.counters().uploads, 1);
  assert.equal(await f.uploadedFile()!.text(), 'abcdef'); assert.equal(f.uploadedFile()!.name, '原始视频.mp4'); assert.equal(f.uploadedFile()!.type, 'video/mp4');
  assert.equal(f.currentNodes()[0].data.title, '原始视频.mp4');
  assert.equal((await f.dispatch('importAsset', { canvasId, kind: 'video', file: { transferId } })).error.code, 'INCOMPLETE_TRANSFER');
});

test('视频分块拒绝乱序、超量及跨画布请求，取消后释放旧传输', async () => {
  const f = fixture(), transferId = 'guarded-transfer';
  const begin = { canvasId, transferId, size: 3, name: 'sample.mp4', mimeType: 'video/mp4' };
  await f.dispatch('importFileBegin', begin);
  const chunk = { canvasId, transferId, offset: 0, base64: Buffer.from('abc').toString('base64') };
  assert.equal((await f.dispatch('importFileChunk', { ...chunk, offset: 1 })).error.code, 'INVALID_CHUNK');
  assert.equal((await f.dispatch('importFileChunk', { ...chunk, base64: Buffer.from('abcd').toString('base64') })).error.code, 'INVALID_CHUNK');
  assert.equal((await f.dispatch('importFileChunk', { ...chunk, canvasId: otherCanvasId })).error.code, 'CANVAS_CHANGED');
  await f.dispatch('importFileAbort', { canvasId: otherCanvasId, transferId });
  assert.equal((await f.dispatch('importFileBegin', begin)).error.code, 'BUSY');
  await f.dispatch('importFileAbort', { canvasId, transferId });
  assert.equal((await f.dispatch('importFileBegin', begin)).ok, true);
  assert.equal(f.counters().uploads, 0);
});

test('网页文字创建复用原生菜单默认模式，编辑后保存且不提交生成', async () => {
  const f = fixture({ webDockbar: {} });
  const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'create', kind: 'text', clientId: 'new', data: { title: '网页测试', text: 'hello' }, position: { x: 25, y: 50 } }] });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.aliases.new, 'native-menu-text');
  assert.equal(result.persistence.confirmed, true);
  const n = f.currentNodes()[0];
  assert.equal(n.data.type, 'generate');
  assert.equal(n.data.text, 'hello');
  assert.deepEqual(n.position, { x: 25, y: 50 });
  assert.equal(n.data.params.model, 'native-default');
  assert.equal(f.counters().factories, 0);
  assert.equal(f.counters().generations, 0);
});

test('网页文字菜单禁用或指定模型时不创建节点', async () => {
  for (const setup of [{ webDockbar: { disabled: true }, data: {} }, { webDockbar: {}, data: { params: { model: 'unsupported' } } }]) {
    const f = fixture(setup);
    const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'create', kind: 'text', data: setup.data }] });
    assert.equal(result.results[0].ok, false);
    assert.equal(f.currentNodes().length, 0);
    assert.equal(f.counters().generations, 0);
  }
});

test('网页音频菜单回退保留默认模型与场景，通用提示词写入 params.prompt 且不提交生成', async () => {
  const f = fixture({ webDockbar: {} });
  const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'create', kind: 'audio', mode: 'generate', data: { title: '音频测试', prompt: 'music prompt' } }] });
  assert.equal(result.results[0].ok, true);
  const n = f.currentNodes()[0];
  assert.equal(n.type, 'audio');
  assert.equal(n.data.params.prompt, 'music prompt');
  assert.equal(n.data.params.scene, 'Music');
  assert.equal(n.data.params.model, 'native-default');
  assert.equal(n.data.prompt, undefined);
  assert.equal(f.counters().generations, 0);
});

test('网页创建遇到并发新增节点时报告实际新增 ID，不继续套用配置', async () => {
  const f = fixture({ webDockbar: { extraNode: true } });
  const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'create', kind: 'text', data: { text: 'must not apply' } }] });
  assert.equal(result.results[0].error.code, 'EDIT_OUTCOME_UNKNOWN');
  assert.deepEqual(result.results[0].error.details.addedNodeIds, ['native-menu-text', 'concurrent-node']);
  assert.equal(f.currentNodes()[0].data.text, '');
});

test('运行时拒绝过期 canvasId，原生编辑、上传、生成均不调用', async () => {
  const f = fixture();
  for (const [action, args] of [
    ['edit', { operations: [{ op: 'create', kind: 'text', data: { text: 'must not be written' } }] }],
    ['importAsset', { kind: 'image', url: 'https://example.com/test.png' }],
    ['submitGeneration', { nodeId: 'generator', requestId: 'request-one' }],
    ['save', {}],
  ] as const) {
    const result = await f.dispatch(action, { canvasId: otherCanvasId, ...args });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CANVAS_CHANGED');
  }
  assert.deepEqual(f.counters(), { edits: 0, flushes: 0, factories: 0, uploads: 0, generations: 0 });
});

test('批量编辑使用原生工厂和变化入口，别名解析后保存并报告结果', async () => {
  const f = fixture();
  const result = await f.dispatch('edit', { canvasId, operations: [
    { op: 'create', clientId: 'new-text', kind: 'text', data: { text: 'hello' }, position: { x: 12, y: 34 } },
    { op: 'update', nodeId: 'new-text', data: { text: 'updated' } },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.every((item: any) => item.ok), true);
  assert.deepEqual(result.aliases, { 'new-text': 'native-1' });
  assert.deepEqual(result.persistence, { status: 'saved', confirmed: true });
  assert.equal(f.currentNodes()[0].data.text, 'updated');
  assert.equal(f.counters().factories, 1);
  assert.equal((await f.dispatch('inspect')).saveState, 'saved');
});

test('批次中失败停止后续操作，已完成部分仍报告持久化结果', async () => {
  const f = fixture();
  const result = await f.dispatch('edit', { canvasId, operations: [
    { op: 'create', kind: 'text', data: { text: 'first' } },
    { op: 'update', nodeId: 'missing', data: { text: 'cannot write' } },
    { op: 'create', kind: 'text', data: { text: 'must be skipped' } },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].error.code, 'NODE_NOT_FOUND');
  assert.equal(result.skipped, 1);
  assert.equal(f.currentNodes().length, 1);
  assert.equal(f.counters().flushes, 1);
});

test('刷新后原生连线端口 right/left 与省略端口等价，重复连接复用原有边', async () => {
  const f = fixture({ initialNodes: ['source', 'target'].map(id => ({ id, type: 'text', position: { x: 0, y: 0 }, data: {} })),
    initialEdges: [{ id: 'persisted-edge', source: 'source', target: 'target', sourceHandle: 'right', targetHandle: 'left' }] });
  const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'connect', source: 'source', target: 'target' }] });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].existing, true);
  assert.equal(result.results[0].edgeId, 'persisted-edge');
  assert.equal(f.currentEdges().length, 1);
  assert.equal(f.counters().edits, 0);
});

test('等待界面更新时画布切换，停止后续编辑与保存', async () => {
  const f = fixture({ switchAfterChange: true });
  const result = await f.dispatch('edit', { canvasId, operations: [
    { op: 'create', kind: 'text', data: { text: 'first' } },
    { op: 'create', kind: 'text', data: { text: 'must not touch new canvas' } },
  ] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CANVAS_CHANGED');
  assert.equal(f.counters().edits, 1);
  assert.equal(f.counters().flushes, 0);
});

test('原生保存失败时不宣称已保存', async () => {
  const f = fixture({ flushResult: 'failed' });
  const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'create', kind: 'text', data: { text: 'draft' } }] });
  assert.deepEqual(result.persistence, { status: 'failed', confirmed: false });
  assert.equal((await f.dispatch('inspect')).saveState, 'unknown');
});

test('创建权限被禁止时拒绝原生工厂调用', async () => {
  const f = fixture({ policy: { nodes: { creatable: false } } });
  const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'create', kind: 'text', data: {} }] });
  assert.equal(result.results[0].error.code, 'PERMISSION_DENIED');
  assert.equal(f.counters().factories, 0);
  assert.equal(f.counters().edits, 0);
});

test('生成准备过程不会调用付费生成回调', async () => {
  const f = fixture({ initialNodes: [{ id: 'generator', type: 'image', position: { x: 0, y: 0 }, data: { type: 'generate', prompt: 'test' } }] });
  const result = await f.dispatch('prepareGeneration', { canvasId, nodeId: 'generator' });
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(f.counters().generations, 0);
});

test('音频模型数组中的合法模型可用于创建生成节点', async () => {
  const f = fixture();
  const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'create', kind: 'audio', mode: 'generate', data: { params: { model: 'audio-model' } } }] });
  assert.equal(result.results[0].ok, true);
  assert.equal(f.currentNodes()[0].data.params.model, 'audio-model');
});

test('分组、取消分组、断线分别遵守原生策略', async () => {
  const f = fixture({ policy: { nodes: { creatable: false, deletable: false }, edges: { deletable: false } } });
  for (const operation of [
    { op: 'group', nodeIds: ['first', 'second'] },
    { op: 'ungroup', nodeId: 'group' },
    { op: 'disconnect', edgeIds: ['edge'] },
  ]) {
    const result = await f.dispatch('edit', { canvasId, operations: [operation] });
    assert.equal(result.results[0].error.code, 'PERMISSION_DENIED');
  }
  assert.equal(f.counters().edits, 0);
  assert.equal(f.counters().factories, 0);
});

test('生成提交不把旧任务当新结果，重复 requestId 不再次调用原生回调', async () => {
  const f = fixture({ initialNodes: [{ id: 'generator', type: 'image', position: { x: 0, y: 0 }, data: { type: 'generate', taskInfo: { taskId: 'old-task', status: 'completed' } } }] });
  const args = { canvasId, nodeId: 'generator', requestId: 'request-one' };
  const result = await f.dispatch('submitGeneration', args);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(result.taskId, undefined);
  assert.equal(result.taskInfo, null);
  await f.dispatch('submitGeneration', args);
  assert.equal(f.counters().generations, 1);
});

for (const family of ['local', 'collab'] as const) {
  test(`${family} 历史仅选择当前画布模式的回调，等待动画后返回新节点 ID`, async () => {
    const f = fixture({ history: family });
    const undoPending = f.dispatch('history', { canvasId, action: 'undo' });
    // Synchronous observation proves no renderer yield occurs between the
    // canvas guard and the actual history callback invocation.
    assert.equal(f.historyCalls()[family === 'local' ? 'localUndo' : 'collabUndo'], 1);
    assert.equal(f.historyCalls()[family === 'local' ? 'collabUndo' : 'localUndo'], 0);
    const undo = await undoPending;
    assert.equal(undo.ok, true);
    assert.equal(undo.changed, true);
    assert.deepEqual(undo.nodes.map((n: any) => n.id), ['restored-new-id']);
    assert.equal(undo.nodes[0].data.text, 'restored content');
    assert.deepEqual(undo.persistence, { status: 'saved', confirmed: true });
    const redo = await f.dispatch('history', { canvasId, action: 'redo' });
    assert.equal(redo.ok, true);
    assert.deepEqual(redo.nodes, []);
    assert.equal(f.historyCalls()[family === 'local' ? 'localRedo' : 'collabRedo'], 1);
    assert.equal(f.historyCalls()[family === 'local' ? 'collabRedo' : 'localRedo'], 0);
    assert.equal(redo.saveState, 'saved');
  });
}

test('历史操作携带过期画布 ID 时两套历史回调均不执行', async () => {
  const f = fixture({ history: 'local' });
  const result = await f.dispatch('history', { canvasId: otherCanvasId, action: 'undo' });
  assert.equal(result.error.code, 'CANVAS_CHANGED');
  assert.deepEqual(f.historyCalls(), { localUndo: 0, localRedo: 0, collabUndo: 0, collabRedo: 0 });
});

test('历史响应读取保存后的最新数据，保存期间发生变化时不误报持久化成功', async () => {
  const f = fixture({ history: 'local', mutateDuringFlush: true });
  const result = await f.dispatch('history', { canvasId, action: 'undo' });
  assert.equal(result.ok, true);
  assert.equal(result.nodes[0].data.text, 'latest-after-save');
  assert.equal(result.persistence.confirmed, false);
  assert.equal(result.saveState, 'unknown');
});

test('音频创建和更新将通用 prompt 映射到原生 params.prompt 并保留其他参数', async () => {
  const f = fixture();
  const created = await f.dispatch('edit', { canvasId, operations: [{ op: 'create', clientId: 'audio', kind: 'audio', mode: 'generate', data: { prompt: 'create audio prompt', params: { model: 'audio-model', speed: 1 } } }] });
  assert.equal(created.results[0].ok, true);
  const nodeId = created.aliases.audio;
  assert.equal(f.currentNodes()[0].data.prompt, undefined);
  assert.deepEqual(f.currentNodes()[0].data.params, { model: 'audio-model', speed: 1, prompt: 'create audio prompt' });
  const updated = await f.dispatch('edit', { canvasId, operations: [{ op: 'update', nodeId, data: { prompt: 'updated audio prompt', params: { speed: 2 } } }] });
  assert.equal(updated.results[0].ok, true);
  assert.equal(f.currentNodes()[0].data.prompt, undefined);
  assert.deepEqual(f.currentNodes()[0].data.params, { model: 'audio-model', speed: 2, prompt: 'updated audio prompt' });
});

test('音频独立面板准备读取原生 prompt 与价格，不触发生成按钮', async () => {
  const f = fixture({ audioPanel: {}, initialNodes: [{ id: 'generator', type: 'audio', position: { x: 0, y: 0 }, data: { type: 'generate', params: { model: 'audio-model', prompt: 'audio prompt' } } }] });
  const result = await f.dispatch('prepareGeneration', { canvasId, nodeId: 'generator' });
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.prompt, 'audio prompt');
  assert.equal(result.nativeSubmitAvailable, true);
  assert.equal(result.estimatedPrice, 3);
  assert.equal(f.counters().generations, 0);
});

test('音频面板禁用、价格加载和控件歧义均不报告可提交且不触发生成', async () => {
  for (const audioPanel of [{ disabled: true }, { priceLoading: true }, { duplicate: true }]) {
    const f = fixture({ audioPanel, initialNodes: [{ id: 'generator', type: 'audio', position: { x: 0, y: 0 }, data: { type: 'generate', params: { model: 'audio-model', prompt: 'audio prompt' } } }] });
    const result = await f.dispatch('prepareGeneration', { canvasId, nodeId: 'generator' });
    assert.equal(result.ok, true);
    assert.equal(result.ready, false);
    assert.equal(f.counters().generations, 0);
  }
});

test('更换生成模型时重建原生 provider 与默认参数，移除旧模型字段并保留提示词', async () => {
  for (const kind of ['image', 'audio']) {
    const f = fixture({
      modelDefaults: { [kind]: { 'new-model': { model: 'new-model', provider: 'new-provider', newOnly: 'native-default', quality: 'standard' } } },
      initialNodes: [{ id: 'existing-node', type: kind, position: { x: 10, y: 20 }, data: { title: 'keep title', type: 'generate', ...(kind === 'image' ? { prompt: 'keep image prompt' } : {}), params: { model: 'old-model', provider: 'old-provider', oldOnly: 'must disappear', ...(kind === 'audio' ? { prompt: 'keep audio prompt' } : {}) } } }],
    });
    const result = await f.dispatch('edit', { canvasId, operations: [{ op: 'update', nodeId: 'existing-node', data: { params: { model: 'new-model', quality: 'high' } } }] });
    assert.equal(result.results[0].ok, true);
    const updated = f.currentNodes()[0];
    assert.equal(updated.id, 'existing-node');
    assert.deepEqual(updated.position, { x: 10, y: 20 });
    assert.equal(updated.data.title, 'keep title');
    assert.equal(updated.data.params.model, 'new-model');
    assert.equal(updated.data.params.provider, 'new-provider');
    assert.equal(updated.data.params.newOnly, 'native-default');
    assert.equal(updated.data.params.quality, 'high');
    assert.equal(updated.data.params.oldOnly, undefined);
    assert.equal(kind === 'audio' ? updated.data.params.prompt : updated.data.prompt, `keep ${kind} prompt`);
    assert.equal(f.counters().factories, 1);
  }
});

const mentionTarget = () => ({ id: 'generator', type: 'image', position: { x: 0, y: 0 }, data: { type: 'generate', prompt: '原提示词', params: { model: 'image-model' } } });
const mentionSource = (id = 'source-one') => ({ id, type: 'image', position: { x: 100, y: 0 }, data: { type: 'upload', title: '参考图 ' + id, src: 'https://assets.example/' + id + '.png' } });
const mentionAsset = () => ({ assetId: 'asset-one', kind: 'image', label: '库中角色', mediaSrc: 'https://assets.example/character.png' });

test('@素材画布和素材库查询只读，不选择节点、不连线、不保存', async () => {
  const f = fixture({ mentions: { libraryItems: [mentionAsset()] }, initialNodes: [mentionTarget(), mentionSource()] });
  const canvas = await f.dispatch('promptReferences', { canvasId, nodeId: 'generator', source: 'canvas' });
  assert.equal(canvas.ok, true);
  assert.equal(canvas.currentPrompt, '原提示词');
  assert.equal(canvas.items.length, 1);
  assert.deepEqual({ nodeId: canvas.items[0].nodeId, usable: canvas.items[0].usable, canConnect: canvas.items[0].canConnect, connected: canvas.items[0].connected }, { nodeId: 'source-one', usable: true, canConnect: true, connected: false });
  const library = await f.dispatch('promptReferences', { canvasId, source: 'library', query: '角色', limit: 5, offset: 0 });
  assert.deepEqual(library.items, [mentionAsset()]);
  assert.equal(f.currentNodes().some((n: any) => n.selected), false);
  assert.deepEqual(f.currentEdges(), []);
  assert.deepEqual(f.counters(), { edits: 0, flushes: 0, factories: 0, uploads: 0, generations: 0 });
});

test('@素材混排使用原生编号和库token，重复引用只创建一条线并保留已有连线', async () => {
  const existing = { id: 'keep-edge', source: 'unrelated-source', target: 'generator' };
  const f = fixture({ mentions: { libraryItems: [mentionAsset()] }, initialNodes: [mentionTarget(), mentionSource(), mentionSource('unrelated-source')], initialEdges: [existing] });
  const result = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [
    { type: 'text', text: '让 ' }, { type: 'reference', source: 'canvas', nodeId: 'source-one' },
    { type: 'text', text: ' 模仿 ' }, { type: 'reference', source: 'library', assetId: 'asset-one' },
    { type: 'text', text: '，仍保留 ' }, { type: 'reference', source: 'canvas', nodeId: 'source-one' },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.references.length, 2);
  const assetPayload = { id: 'asset-one', nodeId: 'asset-one', nodeType: 'image', nodeName: '库中角色', mediaSrc: 'https://assets.example/character.png' };
  const prompt = '让 {{Image 2}} 模仿 {{Asset:' + JSON.stringify(assetPayload) + '}}，仍保留 {{Image 2}}';
  assert.equal(result.prompt, prompt);
  assert.equal(f.currentNodes().find((n: any) => n.id === 'generator').data.prompt, prompt);
  assert.deepEqual(f.currentEdges(), [existing, { id: 'edge-1', source: 'source-one', target: 'generator', sourceHandle: null, targetHandle: null }]);
  assert.deepEqual(result.addedEdgeIds, ['edge-1']);
  assert.deepEqual(result.renderedMentionIds, ['source-one']);
  assert.deepEqual(result.persistence, { status: 'saved', confirmed: true });
  assert.deepEqual(f.mentionState(), { promptDraft: prompt, promptChanges: 1, libraryGets: 1 });
  assert.equal(f.counters().generations, 0);
});

test('@素材已连接的来源不重复添加边，纯素材库引用不添加画布边', async () => {
  const existing = { id: 'existing', source: 'source-one', target: 'generator' };
  const f = fixture({ mentions: { libraryItems: [mentionAsset()] }, initialNodes: [mentionTarget(), mentionSource()], initialEdges: [existing] });
  const canvas = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [{ type: 'reference', source: 'canvas', nodeId: 'source-one' }] });
  assert.equal(canvas.prompt, '{{Image 1}}');
  assert.deepEqual(canvas.addedEdgeIds, []);
  const library = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [{ type: 'reference', source: 'library', assetId: 'asset-one' }] });
  assert.equal(library.ok, true);
  assert.deepEqual(library.addedEdgeIds, []);
  assert.deepEqual(f.currentEdges(), [existing]);
});

test('@素材所有来源在编辑前完整校验，缺失节点或无效素材库元数据不改动画布', async () => {
  for (const entry of [
    { segment: { type: 'reference', source: 'canvas', nodeId: 'missing' }, code: 'NODE_NOT_FOUND' },
    { segment: { type: 'reference', source: 'library', assetId: 'missing' }, code: 'ASSET_NOT_FOUND' },
    { segment: { type: 'reference', source: 'library', assetId: 'asset-one' }, item: { ...mentionAsset(), mediaSrc: '' }, code: 'REFERENCE_NOT_READY' },
    { segment: { type: 'reference', source: 'library', assetId: 'asset-one' }, item: { ...mentionAsset(), kind: 'video' }, code: 'UNSUPPORTED_REFERENCE' },
  ]) {
    const f = fixture({ mentions: { libraryItems: entry.item ? [entry.item] : [] }, initialNodes: [mentionTarget(), mentionSource()] });
    const result = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [{ type: 'reference', source: 'canvas', nodeId: 'source-one' }, entry.segment] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, entry.code);
    assert.equal(f.currentNodes()[0].data.prompt, '原提示词');
    assert.equal(f.counters().edits, 0);
    assert.equal(f.counters().flushes, 0);
    assert.equal(f.mentionState().promptChanges, 0);
    assert.deepEqual(f.currentEdges(), []);
  }
});

test('@素材原生解析拒绝素材库token时不写入提示词或连线', async () => {
  const f = fixture({ mentions: { rejectAsset: true, libraryItems: [mentionAsset()] }, initialNodes: [mentionTarget(), mentionSource()] });
  const result = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [{ type: 'reference', source: 'canvas', nodeId: 'source-one' }, { type: 'reference', source: 'library', assetId: 'asset-one' }] });
  assert.equal(result.error.code, 'UNSUPPORTED_VERSION');
  assert.equal(f.counters().edits, 0);
  assert.equal(f.counters().flushes, 0);
  assert.equal(f.mentionState().promptChanges, 0);
  assert.deepEqual(f.currentEdges(), []);
});

test('@素材原生编辑器只读或编号缺失时不写入提示词', async () => {
  for (const mentions of [{ readonly: true }, { missingMentionItems: true }]) {
    const f = fixture({ mentions, initialNodes: [mentionTarget(), mentionSource()], initialEdges: [{ id: 'existing', source: 'source-one', target: 'generator' }] });
    const result = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [{ type: 'reference', source: 'canvas', nodeId: 'source-one' }] });
    assert.equal(result.error.code, mentions.readonly ? 'PROMPT_EDITOR_UNAVAILABLE' : 'REFERENCE_UNAVAILABLE');
    assert.equal(f.currentNodes()[0].data.prompt, '原提示词');
    assert.equal(f.mentionState().promptChanges, 0);
    assert.equal(f.counters().flushes, 0);
  }
});

test('@素材保存失败时保留界面更新结果但不宣称已持久化', async () => {
  const f = fixture({ mentions: {}, flushResult: 'failed', initialNodes: [mentionTarget(), mentionSource()], initialEdges: [{ id: 'existing', source: 'source-one', target: 'generator' }] });
  const result = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [{ type: 'text', text: '参考 ' }, { type: 'reference', source: 'canvas', nodeId: 'source-one' }] });
  assert.equal(result.ok, true);
  assert.equal(f.currentNodes()[0].data.prompt, '参考 {{Image 1}}');
  assert.deepEqual(result.persistence, { status: 'failed', confirmed: false });
  assert.equal((await f.dispatch('inspect')).saveState, 'unknown');
});

test('@素材拒绝过期画布并在等待编辑器期间切换画布时停止写入', async () => {
  const f = fixture({ mentions: {}, switchAfterChange: true, initialNodes: [mentionTarget(), mentionSource()] });
  const args = { canvasId, nodeId: 'generator', segments: [{ type: 'reference', source: 'canvas', nodeId: 'source-one' }] };
  assert.equal((await f.dispatch('promptReferences', { ...args, canvasId: otherCanvasId })).error.code, 'CANVAS_CHANGED');
  assert.equal((await f.dispatch('promptSet', { ...args, canvasId: otherCanvasId })).error.code, 'CANVAS_CHANGED');
  assert.equal(f.counters().edits, 0);
  const result = await f.dispatch('promptSet', args);
  assert.equal(result.error.code, 'CANVAS_CHANGED');
  assert.equal(f.currentNodes()[0].data.prompt, '原提示词');
  assert.equal(f.mentionState().promptChanges, 0);
  assert.equal(f.counters().flushes, 0);
  assert.deepEqual(f.currentEdges(), []);
});

test('@素材普通文字不得伪造原生引用token，允许空文本清除提示词', async () => {
  const f = fixture({ mentions: {}, initialNodes: [mentionTarget()] });
  for (const text of ['{{Image 1}}', '{{Asset:{"id":"asset"}}}']) {
    const result = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [{ type: 'text', text }] });
    assert.equal(result.error.code, 'RESERVED_REFERENCE_TOKEN');
  }
  assert.equal(f.counters().edits, 0);
  const result = await f.dispatch('promptSet', { canvasId, nodeId: 'generator', segments: [{ type: 'text', text: '' }] });
  assert.equal(result.ok, true);
  assert.equal(f.currentNodes()[0].data.prompt, '');
  assert.equal(f.counters().generations, 0);
});
