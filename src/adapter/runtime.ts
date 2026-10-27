/** Serialized into the renderer. Keep this function self-contained; never accept code from tool inputs. */
export function installRuntime(native: any) {
  const w = globalThis as any;
  if (w.__tapnowCanvasMcp?.version === 1) return { installed: true };
  const failure = (code: string, message: string, details?: any): never => { throw Object.assign(new Error(message), { code, details }); };
  const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
  const clean = (value: any) => JSON.parse(JSON.stringify(value, (key, v) => key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : v));
  const route = () => {
    // Older builds route /canvas/<id>; 0.4.15x desktop routes /p/<project>?c=<canvas>.
    const legacy = /^\/canvas\/([0-9a-f-]{36})\/?$/i.exec(location.pathname)?.[1];
    const scoped = /^\/p\/[0-9a-f-]{36}\/?$/i.test(location.pathname) ? new URLSearchParams(location.search).get('c') : null;
    return legacy ?? (scoped && /^[0-9a-f-]{36}$/i.test(scoped) ? scoped : undefined) ?? failure('NO_ACTIVE_CANVAS', '请先在 Tapnow 主窗口打开一个画布。');
  };
  const guard = (id: string) => {
    const current = route();
    if (current !== id) failure('CANVAS_CHANGED', '当前画布已切换，已停止旧画布请求。', { expected: id, actual: current });
  };
  function fibers() {
    const element = document.getElementById('root') as any;
    const key = element && Object.keys(element).find(k => k.startsWith('__reactContainer$'));
    const container = key && element[key];
    const root = container?.stateNode?.current;
    if (!root) failure('UNSUPPORTED_VERSION', '未找到当前 React 画布根节点。');
    const all: any[] = [], stack = [root], seen = new Set();
    while (stack.length && all.length < 60000) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f); all.push(f);
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return all;
  }
  function bindings() {
    const id = route();
    const all = fibers();
    const props = all.map(f => f.memoizedProps).find(p => p?.['data-keyboard-scope'] === 'canvas' && p.nodeTypes && typeof p.onNodesChange === 'function');
    let store: any, flow: any, viewport: any, pile: any, host: any;
    const history: Record<string, any[]> = { undo: [], redo: [] };
    const owners = all.map(f => f.memoizedProps).filter(p => p?.canvasId && Array.isArray(p.nodes) && Array.isArray(p.edges));
    if (!owners.some(p => p.canvasId === id) || owners.some(p => p.canvasId !== id)) failure('CANVAS_NOT_READY', '画布正在切换或加载，请等画布显示后重新读取。');
    const candidates: any[] = [];
    for (const f of all) {
      const value = f.memoizedProps?.value;
      if (value && (typeof value === 'object' || typeof value === 'function')) candidates.push(value);
      if (f.memoizedProps?.canvasId === id && typeof f.memoizedProps?.isCanvasCreator === 'boolean') host = f.memoizedProps;
      let h = f.memoizedState, count = 0;
      while (h && count++ < 1000) {
        const s = h.memoizedState;
        if (Array.isArray(s) && s[0] && typeof s[0] === 'object') candidates.push(s[0]);
        if (f.memoizedProps?.canvasId === id && Array.isArray(f.memoizedProps.nodes) && Array.isArray(f.memoizedProps.edges) && Array.isArray(s) && typeof s[0] === 'function') {
          const src = Function.prototype.toString.call(s[0]);
          if (/^\(\)\s*=>/.test(src) && /\.flush\(\)/.test(src)) {
            if (f.memoizedProps.isCollaborationEnabled === true && /nodeChanges:/.test(src) && /edgeChanges:/.test(src) && /nextState:/.test(src)) {
              for (const direction of ['undo', 'redo']) if (new RegExp('["\u0027]' + direction + '["\u0027]').test(src)) history[direction].push(s[0]);
            } else if (f.memoizedProps.isCollaborationEnabled !== true && /\.current\[[\w$]+\]\?\.state/.test(src)) {
              if (/if\([\w$]+<=0\)return null/.test(src)) history.undo.push(s[0]);
              if (/if\([\w$]+>=[\w$]+\.current\.length-1\)return null/.test(src)) history.redo.push(s[0]);
            }
          }
        }
        h = h.next;
      }
    }
    for (const value of candidates) {
      if (typeof value.getNodes === 'function' && typeof value.deleteElements === 'function') flow ??= value;
      if (typeof value.fitView === 'function' && typeof value.setViewport === 'function') viewport ??= value;
      if (typeof value.createFromSelection === 'function' && typeof value.unpile === 'function') pile ??= value;
      if (typeof value.getState === 'function' && typeof value.subscribe === 'function') {
        try {
          const state = value.getState();
          if (Array.isArray(state.nodes) && state.nodeLookup instanceof Map && typeof state.triggerNodeChanges === 'function') store ??= value;
        } catch { /* Unrelated context values may be proxies. */ }
      }
    }
    if (!props || !store || !flow) failure('UNSUPPORTED_VERSION', '画布编辑接口不匹配；请运行诊断并更新适配层。', { props: !!props, store: !!store, flow: !!flow });
    return { id, all, props, store, flow, viewport, pile, host, history };
  }
  const nodes = (b: any) => b.flow.getNodes();
  const edges = (b: any) => b.flow.getEdges();
  const node = (b: any, id: string) => nodes(b).find((n: any) => n.id === id) ?? failure('NODE_NOT_FOUND', '节点已不存在。', { nodeId: id });
  const signature = (b: any) => JSON.stringify({ nodes: nodes(b).map((n: any) => ({ id: n.id, type: n.type, position: n.position, width: n.width, height: n.height, parentId: n.parentId, data: n.data })), edges: edges(b).map((e: any) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, data: e.data })) });
  const saved = new Map<string, string>();
  function writable(b: any, capability?: string) {
    guard(b.id);
    if (b.props.nodesDraggable === false || b.props.elementsSelectable === false) failure('EDITING_BLOCKED', '画布当前不可编辑，或正在使用会暂停编辑的模式。');
    const policy = native.policy?.getState?.().mergedPolicy;
    if (capability && policy?.nodes?.[capability] === false) failure('PERMISSION_DENIED', '该画布策略不允许此操作。', { capability });
  }
  async function settle(id: string) { await pause(); guard(id); return bindings(); }
  async function waitFor(id: string, predicate: (b: any) => boolean, timeout = 3000) {
    const started = Date.now();
    let b: any;
    do { b = await settle(id); if (predicate(b)) return b; } while (Date.now() - started < timeout);
    return b;
  }
  async function flush(id: string) {
    guard(id);
    await pause();
    guard(id);
    if (typeof native.flush !== 'function') return { status: 'unknown', confirmed: false };
    const b = bindings(), before = signature(b);
    const status = await native.flush(id);
    guard(id);
    const current = bindings();
    const confirmed = status === 'saved' && signature(current) === before;
    if (confirmed) saved.set(id, before);
    else saved.delete(id);
    return { status: confirmed ? 'saved' : status === 'failed' ? 'failed' : 'unconfirmed', confirmed };
  }
  function snapshot(b: any, args: any = {}) {
    const all = nodes(b), selected = all.filter((n: any) => n.selected).map((n: any) => n.id);
    const subset = args.nodeIds ? all.filter((n: any) => args.nodeIds.includes(n.id)) : all;
    const view = b.store.getState().transform;
    return { canvasId: b.id, title: document.querySelector('[data-testid="canvas-header-title-trigger"]')?.textContent ?? document.title,
      nodes: subset.map((n: any) => args.includeData === false ? { id: n.id, type: n.type, position: n.position, width: n.width, height: n.height, parentId: n.parentId, selected: n.selected, title: n.data?.title } : n),
      edges: edges(b), selectedNodeIds: selected, viewport: { x: view[0], y: view[1], zoom: view[2] },
      saveState: saved.get(b.id) === signature(b) ? 'saved' : 'unknown' };
  }
  function makeNode(b: any, op: any) {
    const data = clean(op.data ?? {});
    if (op.kind === 'audio' && typeof data.prompt === 'string') { data.params = { ...data.params, prompt: data.prompt }; delete data.prompt; }
    let key = op.kind;
    if (key === 'text' && op.mode === 'generate') key = 'textGenerate';
    if (key === 'image' && (op.mode === 'upload' || data.src)) key = 'imageUpload';
    if (key === 'video' && (op.mode === 'upload' || data.src)) key = 'videoUpload';
    const factory = native.factories[key];
    if (typeof factory !== 'function') failure('CAPABILITY_UNAVAILABLE', '当前版本未提供该节点类型的原生创建入口。', { kind: op.kind, mode: op.mode });
    const registry = native.modelRegistries?.[op.kind];
    const knownModel = Array.isArray(registry) ? registry.some((m: any) => m.model === data.params?.model) : registry?.[data.params?.model];
    if (data.params?.model && !knownModel && op.mode !== 'upload' && !data.src) failure('INVALID_MODEL', '模型不在当前应用能力表内。', { model: data.params.model });
    const n = factory(data, { position: op.position ?? { x: 0, y: 0 }, selected: false, ...(op.width ? { width: op.width } : {}), ...(op.height ? { height: op.height } : {}) });
    if (!n?.id || !n?.type || !n.data || !n.position) failure('UNSUPPORTED_VERSION', '原生节点工厂返回了不匹配的数据。');
    if (!b.props.nodeTypes[n.type]) failure('CAPABILITY_UNAVAILABLE', '当前画布不支持此节点类型。', { type: n.type });
    return n;
  }
  async function changes(b: any, list: any[]) {
    writable(b);
    b.props.onNodesChange(list);
    return settle(b.id);
  }
  const webNodeCreationAvailable = () => location.origin === 'https://app.tapnow.ai' &&
    !!document.querySelector('[data-testid="canvas-dockbar-add-node-btn"]');
  const supportedKinds = () => [...new Set([...Object.keys(native.factories).filter(k => typeof native.factories[k] === 'function'),
    ...webNodeCreationAvailable() ? ['text', 'textGenerate', 'audio'] : []])];
  // The current web bundle keeps the text/audio constructors private. Use the
  // native menu to create its default node, then the regular native edit path.
  // Preserve the web application's default mode. Creating a node never submits
  // generation; model changes require a separately identifiable native factory.
  async function createWebNode(b: any, op: any) {
    writable(b, 'creatable');
    if (!webNodeCreationAvailable() || !['text', 'audio'].includes(op.kind) || op.mode === 'upload' || op.kind === 'audio' && op.data?.src) failure('CAPABILITY_UNAVAILABLE', '当前版本未提供该节点类型的原生创建入口。');
    if (op.data?.params?.model) failure('CAPABILITY_UNAVAILABLE', '网页原生菜单创建仅支持当前默认模型，暂不支持指定模型。');
    const initial = new Set(nodes(b).map((n: any) => n.id));
    const itemSelector = `[data-testid="canvas-dockbar-add-${op.kind}-node-btn"]`;
    let item = document.querySelector(itemSelector) as HTMLElement | null;
    if (!item) {
      const button = document.querySelector('[data-testid="canvas-dockbar-add-node-btn"]') as HTMLButtonElement;
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') failure('EDITING_BLOCKED', '原生创建菜单当前不可用。');
      const trigger = button.closest('[aria-haspopup="dialog"]') as any;
      const propsKey = trigger && Object.keys(trigger).find(key => key.startsWith('__reactProps$'));
      const open = propsKey && trigger[propsKey]?.onClick;
      if (typeof open !== 'function') failure('CAPABILITY_UNAVAILABLE', '未找到原生创建菜单的打开入口。');
      open(new MouseEvent('click', { bubbles: true, button: 0 }));
      const started = Date.now();
      do { b = await settle(b.id); item = document.querySelector(itemSelector); } while (!item && Date.now() - started < 3000);
    }
    if (!item || item.getAttribute('aria-disabled') === 'true' || item.getAttribute('data-disabled') === 'true') failure('CAPABILITY_UNAVAILABLE', '原生节点创建菜单不可用。');
    guard(b.id); writable(b, 'creatable');
    item!.click();
    b = await waitFor(b.id, current => nodes(current).some((n: any) => !initial.has(n.id)));
    const added = nodes(b).filter((n: any) => !initial.has(n.id));
    if (added.length !== 1 || added[0].type !== op.kind || op.kind === 'text' && (!['pure', 'generate'].includes(added[0].data?.type) || op.mode === 'generate' && added[0].data.type !== 'generate') || op.kind === 'audio' && added[0].data?.type === 'upload') {
      failure('EDIT_OUTCOME_UNKNOWN', '原生菜单未返回唯一的兼容节点；请重新读取画布，勿重复创建。', { addedNodeIds: added.map((n: any) => n.id) });
    }
    const created = added[0];
    const data = clean(op.data ?? {});
    if (op.kind === 'audio' && typeof data.prompt === 'string') { data.params = { ...data.params, prompt: data.prompt }; delete data.prompt; }
    const next = { ...created, data: { ...created.data, ...data, ...(data.params ? { params: { ...created.data.params, ...data.params } } : {}) }, selected: false,
      position: op.position ?? { x: 0, y: 0 }, ...(op.width ? { width: op.width } : {}), ...(op.height ? { height: op.height } : {}) };
    b = await changes(b, [{ type: 'replace', id: created.id, item: next }]);
    const actual = node(b, created.id);
    if (JSON.stringify(actual.data) !== JSON.stringify(next.data) || JSON.stringify(actual.position) !== JSON.stringify(next.position)) {
      failure('EDIT_REJECTED', '已创建原生节点，但应用未接受后续配置。', { createdNodeId: created.id });
    }
    return { b, node: actual };
  }
  async function runEdit(args: any) {
    guard(args.canvasId);
    const results: any[] = [], aliases = new Map<string, string>();
    const resolve = (id: string) => aliases.get(id) ?? id;
    for (let index = 0; index < args.operations.length; index++) {
      guard(args.canvasId);
      let b = bindings(); writable(b);
      const op = args.operations[index];
      try {
        let result: any;
        switch (op.op) {
          case 'create': {
            writable(b, 'creatable');
            if (op.clientId && aliases.has(op.clientId)) failure('DUPLICATE_CLIENT_ID', '同一批次中的 clientId 不得重复。');
            let n: any;
            if (['text', 'audio'].includes(op.kind) && !(op.kind === 'text' && op.mode === 'generate' ? native.factories.textGenerate : native.factories[op.kind]) && webNodeCreationAvailable()) {
              const created = await createWebNode(b, op); b = created.b; n = created.node;
            } else {
              n = makeNode(b, op);
              b = await changes(b, [{ type: 'add', item: n }]);
            }
            const actual = node(b, n.id);
            if (op.clientId) aliases.set(op.clientId, n.id);
            result = { nodeId: actual.id, type: actual.type }; break;
          }
          case 'update': {
            const id = resolve(op.nodeId), n = node(b, id);
            const patch = clean(op.data ?? {});
            let replaceParams = false;
            if (n.type === 'audio' && typeof patch.prompt === 'string') { patch.params = { ...patch.params, prompt: patch.prompt }; delete patch.prompt; }
            if (patch.params?.model && patch.params.model !== n.data?.params?.model && (n.data?.type === 'generate' || n.type === 'audio' && n.data?.type !== 'upload')) {
              const fresh = makeNode(b, { kind: n.type, mode: 'generate', data: { params: patch.params } });
              patch.params = { ...fresh.data.params, ...(n.type === 'audio' && n.data.params?.prompt ? { prompt: n.data.params.prompt } : {}), ...patch.params };
              replaceParams = true;
            }
            const next = { ...n, ...(op.position ? { position: op.position } : {}), ...(op.width ? { width: op.width } : {}), ...(op.height ? { height: op.height } : {}), data: { ...n.data, ...patch, ...(patch.params ? { params: { ...replaceParams ? {} : n.data?.params, ...patch.params } } : {}) } };
            b = await changes(b, [{ type: 'replace', id, item: next }]);
            const actual = node(b, id);
            if (JSON.stringify(actual.data) !== JSON.stringify(next.data) || JSON.stringify(actual.position) !== JSON.stringify(next.position)) failure('EDIT_REJECTED', '应用未接受节点修改。');
            result = { nodeId: id }; break;
          }
          case 'delete': {
            writable(b, 'deletable');
            const ids = op.nodeIds.map(resolve); ids.forEach((id: string) => node(b, id));
            const outcome = await b.flow.deleteElements({ nodes: ids.map((id: string) => ({ id })) });
            b = await waitFor(b.id, current => !nodes(current).some((n: any) => ids.includes(n.id)));
            if (nodes(b).some((n: any) => ids.includes(n.id))) failure('DELETE_REJECTED', '应用未接受删除，节点可能正在执行任务或被锁定。', { outcome });
            result = { deletedNodeIds: ids }; break;
          }
          case 'connect': {
            writable(b, 'connectable');
            const connection = { source: resolve(op.source), target: resolve(op.target), sourceHandle: op.sourceHandle ?? null, targetHandle: op.targetHandle ?? null };
            node(b, connection.source); node(b, connection.target);
            if (connection.source === connection.target) failure('INVALID_CONNECTION', '不允许节点连接到自身。');
            // Tapnow hydrates omitted handles as right/left after reloading.
            // Treat those defaults identically to avoid a duplicate-connect error
            // when the same request is made against a restored graph.
            const duplicate = edges(b).find((e: any) => e.source === connection.source && e.target === connection.target &&
              (e.sourceHandle ?? 'right') === (connection.sourceHandle ?? 'right') && (e.targetHandle ?? 'left') === (connection.targetHandle ?? 'left'));
            if (duplicate) { result = { edgeId: duplicate.id, existing: true }; break; }
            if (typeof b.props.isValidConnection === 'function' && !b.props.isValidConnection(connection)) failure('INVALID_CONNECTION', 'Tapnow 不允许这两个节点建立该连接。');
            b = await changes(b, nodes(b).filter((n: any) => n.selected).map((n: any) => ({ id: n.id, type: 'select', selected: false })));
            b.props.onConnect(connection); b = await settle(b.id);
            const e = edges(b).find((e: any) => e.source === connection.source && e.target === connection.target);
            if (!e) failure('CONNECTION_REJECTED', '应用未创建连线。');
            result = { edgeId: e.id }; break;
          }
          case 'disconnect': {
            if (native.policy?.getState?.().mergedPolicy?.edges?.deletable === false) failure('PERMISSION_DENIED', '画布策略不允许删除连线。');
            const ids = op.edgeIds.map(resolve);
            ids.forEach((id: string) => { if (!edges(b).some((e: any) => e.id === id)) failure('EDGE_NOT_FOUND', '连线已不存在。', { edgeId: id }); });
            await b.flow.deleteElements({ edges: ids.map((id: string) => ({ id })) });
            b = await waitFor(b.id, current => !edges(current).some((e: any) => ids.includes(e.id)));
            if (edges(b).some((e: any) => ids.includes(e.id))) failure('DELETE_REJECTED', '应用未接受断开连线。');
            result = { deletedEdgeIds: ids }; break;
          }
          case 'select': {
            const ids = new Set(op.nodeIds.map(resolve)); ids.forEach(id => node(b, id as string));
            b = await changes(b, nodes(b).filter((n: any) => !!n.selected !== ids.has(n.id)).map((n: any) => ({ type: 'select', id: n.id, selected: ids.has(n.id) })));
            native.selection?.getState?.().setSelectedNodes?.(nodes(b).filter((n: any) => ids.has(n.id)));
            result = { selectedNodeIds: [...ids] }; break;
          }
          case 'layout': {
            const list = op.nodeIds ? op.nodeIds.map((id: string) => node(b, resolve(id))) : nodes(b).filter((n: any) => !n.parentId);
            const parents = new Set(list.map((n: any) => n.parentId ?? ''));
            if (parents.size > 1) failure('MIXED_PARENTS', '一次布局只能包含同一层级的节点。');
            const gap = op.gap ?? 80, direction = op.direction ?? 'grid';
            const positions = new Map<string, any>();
            const x0 = list.length ? Math.min(...list.map((n: any) => n.position.x)) : 0, y0 = list.length ? Math.min(...list.map((n: any) => n.position.y)) : 0;
            if (direction === 'grid') {
              const columns = Math.max(1, Math.ceil(Math.sqrt(list.length)));
              const width = Math.max(320, ...list.map((n: any) => n.width ?? n.measured?.width ?? 320));
              const height = Math.max(220, ...list.map((n: any) => n.height ?? n.measured?.height ?? 220));
              list.forEach((n: any, i: number) => positions.set(n.id, { x: x0 + (i % columns) * (width + gap), y: y0 + Math.floor(i / columns) * (height + gap) }));
            } else {
              const ids = new Set(list.map((n: any) => n.id)), links = edges(b).filter((e: any) => ids.has(e.source) && ids.has(e.target));
              const remaining = new Set(ids), levels = new Map<string, number>();
              while (remaining.size) {
                const available = [...remaining].filter(id => links.filter((e: any) => e.target === id).every((e: any) => !remaining.has(e.source)));
                if (!available.length) failure('LAYOUT_CYCLE', '连线包含环，请使用 grid 布局。');
                for (const id of available) { levels.set(id as string, Math.max(0, ...links.filter((e: any) => e.target === id).map((e: any) => (levels.get(e.source) ?? 0) + 1))); remaining.delete(id); }
              }
              const maxW = Math.max(320, ...list.map((n: any) => n.width ?? 320)), maxH = Math.max(220, ...list.map((n: any) => n.height ?? 220)), counts = new Map<number, number>();
              list.forEach((n: any) => { const level = levels.get(n.id) ?? 0, row = counts.get(level) ?? 0; counts.set(level, row + 1); positions.set(n.id, direction === 'LR' ? { x: x0 + level * (maxW + gap), y: y0 + row * (maxH + gap) } : { x: x0 + row * (maxW + gap), y: y0 + level * (maxH + gap) }); });
            }
            await changes(b, [...positions].map(([id, position]) => ({ id, type: 'position', position, dragging: false })));
            result = { nodeIds: list.map((n: any) => n.id), direction }; break;
          }
          case 'group': {
            writable(b, 'creatable');
            const list = op.nodeIds.map((id: string) => node(b, resolve(id)));
            if (list.length < 2) failure('INVALID_GROUP', '分组至少需要两个节点。');
            if (list.some((n: any) => n.parentId || n.type === 'group')) failure('NESTED_GROUP_UNSUPPORTED', '请先解除已有分组，再进行分组。');
            const x = Math.min(...list.map((n: any) => n.position.x)) - 40, y = Math.min(...list.map((n: any) => n.position.y)) - 80;
            const width = Math.max(...list.map((n: any) => n.position.x + (n.width ?? 320))) - x + 40;
            const height = Math.max(...list.map((n: any) => n.position.y + (n.height ?? 220))) - y + 40;
            const group = native.factories.group?.({ title: op.title ?? 'Group', layoutType: 'free' }, { position: { x, y }, width, height, selected: false });
            if (!group || !b.props.nodeTypes[group.type]) failure('CAPABILITY_UNAVAILABLE', '当前应用未提供可用的原生分组入口。');
            await changes(b, [{ type: 'add', item: group }, ...list.map((n: any) => ({ type: 'replace', id: n.id, item: { ...n, selected: false, parentId: group.id, extent: 'parent', position: { x: n.position.x - x, y: n.position.y - y } } }))]);
            result = { groupId: group.id, nodeIds: list.map((n: any) => n.id) }; break;
          }
          case 'ungroup': {
            writable(b, 'deletable');
            const g = node(b, resolve(op.nodeId));
            if (g.type !== 'group') failure('INVALID_GROUP', '指定节点不是分组。');
            const list = nodes(b).filter((n: any) => n.parentId === g.id);
            await changes(b, [...list.map((n: any) => { // 0.4.15x persists only present keys; explicit undefined clears them like the native ungroup.
              const item = { ...n, parentId: undefined, extent: n.extent === 'parent' ? undefined : n.extent, position: { x: n.position.x + g.position.x, y: n.position.y + g.position.y } }; return { type: 'replace', id: n.id, item }; }), { type: 'remove', id: g.id }]);
            result = { removedGroupId: g.id, nodeIds: list.map((n: any) => n.id) }; break;
          }
          default: failure('INVALID_OPERATION', '未知画布操作。');
        }
        results.push({ index, op: op.op, ok: true, ...result });
      } catch (error: any) {
        results.push({ index, op: op.op, ok: false, error: { code: error.code ?? 'EDIT_FAILED', message: error.message, ...(error.details ? { details: clean(error.details) } : {}) } });
        break;
      }
    }
    try { guard(args.canvasId); } catch (error: any) {
      error.details = { ...error.details, results, skipped: args.operations.length - results.length, aliases: Object.fromEntries(aliases), persistence: { status: 'unknown', confirmed: false } };
      throw error;
    }
    const persistence = await flush(args.canvasId);
    return { canvasId: args.canvasId, results, skipped: args.operations.length - results.length, aliases: Object.fromEntries(aliases), persistence };
  }
  async function setView(args: any) {
    guard(args.canvasId); const b = bindings();
    if (!b.viewport) failure('CAPABILITY_UNAVAILABLE', '未找到视图控制入口。');
    if (args.nodeIds) args.nodeIds.forEach((id: string) => node(b, id));
    if (args.action === 'set') await b.viewport.setViewport(args.viewport, { duration: 0 });
    else await b.viewport.fitView({ ...(args.nodeIds ? { nodes: args.nodeIds.map((id: string) => ({ id })) } : {}), duration: 0, padding: 0.2 });
    guard(args.canvasId);
    return snapshot(await settle(args.canvasId), { includeData: false });
  }
  function promptValue(n: any): string { return n.type === 'audio' ? n.data?.params?.prompt ?? '' : n.data?.prompt ?? ''; }
  function validPromptTarget(n: any) {
    if (!['text', 'image', 'video', 'audio'].includes(n.type) || n.data?.type === 'pure' || n.data?.type === 'upload') failure('NOT_GENERATION_NODE', '请选择可编辑提示词的生成节点。');
  }
  function promptEditor(b: any, nodeId: string) {
    const matches: any[] = [], refs = new Set();
    for (const owner of b.all.filter((f: any) => f.memoizedProps?.nodeId === nodeId && typeof f.memoizedProps?.onPromptChange === 'function')) {
      const stack = [owner.child];
      while (stack.length) {
        const f = stack.pop(); if (!f) continue;
        const p = f.memoizedProps;
        if (Array.isArray(p?.mentionItems) && p.tiptapRef?.current && typeof p.tiptapRef.current.getMentionIds === 'function' && !refs.has(p.tiptapRef)) {
          refs.add(p.tiptapRef); matches.push({ owner: owner.memoizedProps, items: p.mentionItems, ref: p.tiptapRef.current, readonly: !!(owner.memoizedProps.isReadonly || owner.memoizedProps.promptReadOnly || p.isReadonly) });
        }
        if (f.sibling) stack.push(f.sibling); if (f.child) stack.push(f.child);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  function canvasMaterial(n: any, target?: any, b?: any) {
    const kind = n.type, mediaSrc = typeof n.data?.src === 'string' ? n.data.src : '';
    const content = typeof n.data?.text === 'string' ? n.data.text : '';
    const usable = !['pending', 'running', 'processing'].includes(n.data?.taskInfo?.status) && (kind === 'text' ? !!content.trim() : /^https?:\/\//.test(mediaSrc));
    const connected = !!target && edges(b).some((e: any) => e.source === n.id && e.target === target.id);
    let canConnect = usable;
    if (target && n.id === target.id) canConnect = false;
    else if (target && !connected && typeof b.props.isValidConnection === 'function') canConnect = usable && !!b.props.isValidConnection({ source: n.id, target: target.id, sourceHandle: null, targetHandle: null });
    return { nodeId: n.id, label: n.data?.title ?? n.id, kind, ...(mediaSrc ? { mediaSrc } : {}), usable, ...(target ? { connected, canConnect } : {}) };
  }
  async function listPromptReferences(args: any) {
    guard(args.canvasId); const b = bindings();
    const target = args.nodeId ? node(b, args.nodeId) : undefined;
    if (target) validPromptTarget(target);
    const query = (args.query ?? '').trim(), limit = args.limit ?? 50, offset = args.offset ?? 0;
    if (args.source === 'library') {
      if (!native.mentions?.library?.list) failure('CAPABILITY_UNAVAILABLE', '当前版本未找到素材库读取入口。');
      const library = await native.mentions.library.list({ query, limit, offset });
      guard(args.canvasId);
      return { canvasId: args.canvasId, source: 'library', ...library, ...(target ? { nodeId: target.id, currentPrompt: promptValue(node(bindings(), target.id)) } : {}) };
    }
    const list = nodes(b).filter((n: any) => ['text', 'image', 'video', 'audio'].includes(n.type) && n.id !== target?.id)
      .map((n: any) => canvasMaterial(n, target, b)).filter((n: any) => !query || (n.label + ' ' + n.nodeId).toLowerCase().includes(query.toLowerCase()));
    return { canvasId: b.id, source: 'canvas', items: list.slice(offset, offset + limit), total: list.length, hasMore: offset + limit < list.length, nextOffset: offset + limit < list.length ? offset + limit : null, ...(target ? { nodeId: target.id, currentPrompt: promptValue(target) } : {}) };
  }
  async function setPromptReferences(args: any) {
    guard(args.canvasId); let b = bindings(); writable(b);
    const target = node(b, args.nodeId); validPromptTarget(target);
    if (!Array.isArray(args.segments) || !args.segments.length || args.segments.length > 200) failure('INVALID_ARGUMENT', '提示词需要 1–200 个文字或引用片段。');
    const references = new Map<string, any>(); let textLength = 0, referenceCount = 0;
    for (const segment of args.segments) {
      if (segment.type === 'text') {
        if (typeof segment.text !== 'string') failure('INVALID_ARGUMENT', '文字片段必须提供 text。');
        textLength += segment.text.length;
        if (/\{\{(?:Asset:|(?:Image|Video|Audio|Text)\s+\d+)/.test(segment.text)) failure('RESERVED_REFERENCE_TOKEN', '请使用 reference 片段插入原生素材引用，不要在文字中手工拼接引用标记。');
      } else if (segment.type === 'reference' && ['canvas', 'library'].includes(segment.source)) {
        referenceCount++;
        const id = segment.source === 'canvas' ? segment.nodeId : segment.assetId;
        if (typeof id !== 'string' || !id) failure('INVALID_ARGUMENT', '素材引用缺少身份标识。');
        references.set(segment.source + ':' + id, { source: segment.source, id });
      } else failure('INVALID_ARGUMENT', '未知提示词片段类型或素材来源。');
    }
    if (textLength > 200000 || referenceCount > 32) failure('INVALID_ARGUMENT', '提示词超过 200000 字符或 32 个引用片段。');
    const libraryReferences = [...references.values()].filter(r => r.source === 'library');
    if (libraryReferences.length && (!native.mentions?.library?.get || !native.mentions?.parseAsset)) failure('CAPABILITY_UNAVAILABLE', '当前版本无法校验素材库引用。');
    // Validate all canvas sources and all library metadata before any persistent edit.
    for (const ref of references.values()) {
      if (ref.source !== 'canvas') continue;
      const source = node(b, ref.id);
      if (!['image', 'video', 'audio', 'text'].includes(source.type)) failure('UNSUPPORTED_REFERENCE', '此画布节点不能作为素材引用。', { nodeId: ref.id });
      const material = canvasMaterial(source, target, b);
      if (!material.usable) failure('REFERENCE_NOT_READY', '引用素材尚未生成、上传完成，或没有可用内容。', { nodeId: ref.id });
      if (!material.canConnect) failure('INVALID_CONNECTION', '当前模型或画布不允许使用该引用素材。', { nodeId: ref.id });
      Object.assign(ref, material);
    }
    await Promise.all(libraryReferences.map(async ref => { ref.material = await native.mentions.library.get(ref.id); }));
    guard(args.canvasId); b = bindings(); writable(b);
    for (const ref of libraryReferences) {
      const m = ref.material;
      if (!m || m.assetId !== ref.id || !['image', 'video', 'audio', 'text'].includes(m.kind)) failure('ASSET_NOT_FOUND', '素材库未返回可读取的单素材。', { assetId: ref.id });
      if (target.type === 'image' && !['image', 'text'].includes(m.kind)) failure('UNSUPPORTED_REFERENCE', '图片生成提示词只支持图片和文字素材引用。', { assetId: ref.id });
      const payload = { id: m.assetId, nodeId: m.assetId, nodeType: m.kind, nodeName: m.label,
        ...(m.mediaSrc ? { mediaSrc: m.mediaSrc } : {}), ...(m.previewImage ? { previewImage: m.previewImage } : {}),
        ...(typeof m.durationMs === 'number' ? { durationMs: m.durationMs } : {}), ...(m.kind === 'text' ? { content: m.content ?? '' } : {}) };
      if (m.kind !== 'text' && !/^https?:\/\//.test(m.mediaSrc ?? '') || m.kind === 'text' && !m.content?.trim()) failure('REFERENCE_NOT_READY', '素材没有可用媒体地址或文字内容。', { assetId: ref.id });
      const parsed = native.mentions.parseAsset(payload);
      if (!parsed || parsed.id !== m.assetId || parsed.nodeId !== m.assetId || parsed.nodeType !== m.kind) failure('UNSUPPORTED_VERSION', '原生素材引用解析结果不匹配，已停止写入。');
      ref.token = '{{Asset:' + JSON.stringify(payload) + '}}'; ref.kind = m.kind; ref.label = m.label;
    }
    await prepareGeneration({ canvasId: args.canvasId, nodeId: args.nodeId });
    guard(args.canvasId); b = bindings();
    let editor = promptEditor(b, args.nodeId);
    if (!editor || editor.readonly) failure('PROMPT_EDITOR_UNAVAILABLE', '当前节点没有可编辑的原生 @素材 提示词面板。');
    const newLinks = [...references.values()].filter(ref => ref.source === 'canvas' && !edges(b).some((e: any) => e.source === ref.id && e.target === args.nodeId));
    const addedEdgeIds: string[] = [];
    if (newLinks.length) {
      const linked = await runEdit({ canvasId: args.canvasId, operations: newLinks.map(ref => ({ op: 'connect', source: ref.id, target: args.nodeId })) });
      for (const result of linked.results) if (result.ok && result.edgeId && !result.existing) addedEdgeIds.push(result.edgeId);
      if (linked.results.some((r: any) => !r.ok)) failure('REFERENCE_CONNECTION_FAILED', '应用未接受全部引用连线；提示词尚未写入。', { results: linked.results, addedEdgeIds });
      await prepareGeneration({ canvasId: args.canvasId, nodeId: args.nodeId });
      b = bindings(); editor = promptEditor(b, args.nodeId);
      if (!editor || editor.readonly) failure('PROMPT_EDITOR_UNAVAILABLE', '提示词面板已关闭，已停止写入。', { addedEdgeIds });
    }
    for (const ref of references.values()) {
      if (ref.source !== 'canvas') continue;
      const matches = editor.items.filter((item: any) => item.id === ref.id);
      if (matches.length !== 1 || !/^(?:Image|Video|Audio|Text)\s+\d+$/.test(matches[0].renderText ?? '')) failure('REFERENCE_UNAVAILABLE', '原生提示词面板没有唯一匹配的素材编号引用。', { nodeId: ref.id, addedEdgeIds });
      ref.token = '{{' + matches[0].renderText + '}}'; ref.label = matches[0].label;
    }
    const prompt = args.segments.map((segment: any) => segment.type === 'text' ? segment.text : references.get(segment.source + ':' + (segment.nodeId ?? segment.assetId)).token).join('');
    if (prompt.length > 400000) failure('INVALID_ARGUMENT', '引用元数据使提示词过长，请减少引用或文字内容。');
    guard(args.canvasId); writable(b);
    const current = node(b, args.nodeId);
    const data = current.type === 'audio' ? { ...current.data, params: { ...current.data.params, prompt } } : { ...current.data, prompt };
    // Keep the mounted editor's native draft and the persistent graph in agreement.
    editor.owner.onPromptChange(prompt);
    b = await changes(b, [{ type: 'replace', id: current.id, item: { ...current, data } }]);
    if (promptValue(node(b, current.id)) !== prompt) failure('EDIT_REJECTED', '应用未接受提示词修改。', { addedEdgeIds });
    const persistence = await flush(args.canvasId);
    editor = promptEditor(bindings(), args.nodeId);
    return { canvasId: args.canvasId, nodeId: args.nodeId, prompt, references: [...references.values()].map(ref => ({ source: ref.source, ...(ref.source === 'canvas' ? { nodeId: ref.id } : { assetId: ref.id }), kind: ref.kind, label: ref.label, token: ref.token })), addedEdgeIds, renderedMentionIds: editor?.ref.getMentionIds?.() ?? null, persistence };
  }
  function generationPanel(b: any, nodeId: string) {
    const candidates = b.all.map((f: any) => f.memoizedProps).filter((p: any) => p?.nodeId === nodeId && typeof p.onGenerate === 'function');
    // 0.4.15x renders several layers per node; the price-bearing action button is the submit control.
    const normal = candidates.find((p: any) => typeof p.canGenerate === 'boolean' && 'estimatedPrice' in p) ??
      candidates.find((p: any) => typeof p.canGenerate === 'boolean') ?? candidates[0];
    if (normal) return normal;
    // Audio uses a separate native button inside its node-specific config panel.
    const audioPanels = b.all.filter((f: any) => f.memoizedProps?.nodeId === nodeId && typeof f.memoizedProps.onGenerateReady === 'function' && 'voiceInput' in f.memoizedProps && 'lyrics' in f.memoizedProps);
    if (audioPanels.length !== 1) return undefined;
    const controls: any[] = [], stack = [audioPanels[0].child];
    while (stack.length) {
      const f = stack.pop(); if (!f) continue;
      const p = f.memoizedProps;
      if (p && typeof p.onClick === 'function' && 'sending' in p && 'isGenerating' in p && 'disabled' in p && 'estimatedPrice' in p) controls.push(p);
      if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
    }
    if (controls.length !== 1) return undefined;
    const p = controls[0];
    return { ...p, canGenerate: !p.disabled && !p.priceLoading, onGenerate: () => p.onClick({ stopPropagation() {}, preventDefault() {} }) };
  }
  async function prepareGeneration(args: any) {
    guard(args.canvasId); let b = bindings(); writable(b);
    const n = node(b, args.nodeId);
    if (n.type === 'text' && n.data?.type === 'pure' || ['image', 'video', 'audio'].includes(n.type) && n.data?.type === 'upload') failure('NOT_GENERATION_NODE', '上传素材或纯文字节点不能直接生成，请创建生成节点并连接输入。');
    const backToCanvas = () => typeof document.querySelectorAll !== 'function' ? undefined : Array.from(document.querySelectorAll('button[aria-label]')).find((e: any) => /^(返回画布|back to canvas)$/i.test(e.getAttribute('aria-label'))) as HTMLElement | undefined;
    if (!generationPanel(b, args.nodeId) && backToCanvas()) {
      // Another node's detail view covers the canvas; use its native back button.
      backToCanvas()!.click();
      for (let i = 0; i < 20 && backToCanvas(); i++) await pause(100);
      guard(args.canvasId); b = bindings();
    }
    b = await changes(b, nodes(b).map((n: any) => ({ id: n.id, type: 'select', selected: n.id === args.nodeId })));
    native.selection?.getState?.().setSelectedNodes?.([node(b, args.nodeId)]);
    if (b.viewport) await b.viewport.fitView({ nodes: [{ id: args.nodeId }], duration: 0, padding: 0.4 });
    await pause(250); guard(args.canvasId); b = bindings();
    let panel = generationPanel(b, args.nodeId);
    if (!panel && typeof document.querySelectorAll === 'function' && typeof document.elementFromPoint === 'function') {
      // 0.4.15x only mounts the generation panel in the node detail view, which opens on a pointer click.
      const element = Array.from(document.querySelectorAll('.react-flow__node')).find((e: any) => e.getAttribute('data-id') === args.nodeId);
      const rect = element?.getBoundingClientRect();
      const x = rect ? rect.left + rect.width / 2 : 0, y = rect ? rect.top + rect.height / 2 : 0;
      const target = rect && document.elementFromPoint(x, y);
      if (target && element!.contains(target)) {
        const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window };
        target.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 })); target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
        target.dispatchEvent(new PointerEvent('pointerup', init)); target.dispatchEvent(new MouseEvent('mouseup', init)); target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
        for (let i = 0; i < 20 && !panel; i++) { await pause(150); guard(args.canvasId); b = bindings(); panel = generationPanel(b, args.nodeId); }
      }
    }
    const task = n.data?.taskInfo;
    return { canvasId: b.id, nodeId: args.nodeId, nodeType: n.type, model: n.data?.params?.model, params: n.data?.params ?? {}, prompt: n.data?.params?.prompt ?? n.data?.prompt ?? n.data?.text ?? '', taskInfo: task ?? null,
      ready: !!panel && panel.canGenerate !== false && !panel.disabled && !panel.priceLoading && !panel.sending && !panel.isGenerating && !['pending', 'running', 'processing'].includes(task?.status),
      nativeSubmitAvailable: !!panel, estimatedPrice: panel?.estimatedPrice ?? null, estimatedPriceDisplay: typeof panel?.estimatedPriceDisplay === 'string' ? panel.estimatedPriceDisplay : typeof panel?.estimatedPriceDisplay?.text === 'string' ? panel.estimatedPriceDisplay.text : null,
      priceLoading: !!panel?.priceLoading,
      reason: !panel ? '当前节点尚未显示可用的生成控制面板。' : panel.priceLoading ? '应用正在计算价格，请稍后再次准备。' : panel.canGenerate === false || panel.disabled ? '应用认为输入条件尚未满足，或当前模型不可用。' : null };
  }
  const submissions = new Map<string, any>();
  async function submitGeneration(args: any) {
    guard(args.canvasId);
    const key = args.canvasId + ':' + args.requestId;
    if (submissions.has(key)) return submissions.get(key);
    const preparation = await prepareGeneration(args);
    if (!preparation.ready) failure('GENERATION_NOT_READY', '生成任务尚不能提交。', preparation);
    guard(args.canvasId);
    const b = bindings(); writable(b); const panel = generationPanel(b, args.nodeId);
    if (!panel || panel.canGenerate === false || panel.disabled || panel.priceLoading || panel.sending || panel.isGenerating) failure('GENERATION_NOT_READY', '生成面板已关闭或条件已变化。');
    const previousTaskId = node(b, args.nodeId).data?.taskInfo?.taskId;
    const record: any = { canvasId: args.canvasId, nodeId: args.nodeId, requestId: args.requestId, state: 'submitting', submittedAt: Date.now() };
    submissions.set(key, record);
    try {
      Promise.resolve(panel.onGenerate()).then(() => { record.callbackFinished = true; }, (e: any) => { record.error = String(e?.message ?? e); record.state = 'failed'; });
    } catch (e: any) { record.error = e.message; record.state = 'failed'; }
    for (let i = 0; i < 40; i++) {
      await pause(200); guard(args.canvasId);
      const current = node(bindings(), args.nodeId), info = current.data?.taskInfo;
      if (info?.taskId && info.taskId !== previousTaskId) { record.taskId = info.taskId; record.state = info.status ?? 'pending'; break; }
      if (record.error) break;
    }
    if (!record.taskId && record.state !== 'failed') record.state = 'outcome_unknown';
    return { ...record, taskInfo: record.taskId ? node(bindings(), args.nodeId).data?.taskInfo ?? null : null, persistence: await flush(args.canvasId) };
  }
  let stagedImport: { transferId: string; canvasId: string; size: number; name: string; mimeType: string; received: number; parts: Uint8Array[] } | undefined;
  function importFilePart(action: string, args: any) {
    if (action === 'importFileAbort') {
      if (stagedImport?.transferId === args.transferId && stagedImport?.canvasId === args.canvasId) stagedImport = undefined;
      return { cleared: !stagedImport };
    }
    guard(args.canvasId); writable(bindings(), 'creatable');
    if (action === 'importFileBegin') {
      if (stagedImport) failure('BUSY', '已有素材正在传输，请先结束原请求。');
      if (!Number.isInteger(args.size) || args.size <= 0 || args.size > 500 * 1024 * 1024 || typeof args.name !== 'string' || !args.name || !/^video\//.test(args.mimeType) || typeof args.transferId !== 'string' || !args.transferId) failure('INVALID_ARGUMENT', '大视频传输参数无效。');
      stagedImport = { transferId: args.transferId, canvasId: args.canvasId, size: args.size, name: args.name, mimeType: args.mimeType, received: 0, parts: [] };
      return { received: 0 };
    }
    const staged = stagedImport;
    if (!staged || staged.transferId !== args.transferId || staged.canvasId !== args.canvasId) failure('TRANSFER_NOT_FOUND', '未找到当前素材传输。');
    if (args.offset !== staged!.received || typeof args.base64 !== 'string' || args.base64.length > 4 * 1024 * 1024) failure('INVALID_CHUNK', '素材分块顺序或大小无效。');
    const bytes = Uint8Array.from(atob(args.base64), (c: string) => c.charCodeAt(0));
    if (!bytes.length || bytes.length > 2 * 1024 * 1024 || staged!.received + bytes.length > staged!.size) failure('INVALID_CHUNK', '素材分块超过预期长度。');
    staged!.parts.push(bytes); staged!.received += bytes.length;
    return { received: staged!.received };
  }
  async function importAsset(args: any) {
    guard(args.canvasId); let b = bindings(); writable(b, 'creatable');
    let info: any = { url: args.url };
    let importedName: string | undefined;
    if (args.file) {
      if (typeof native.upload !== 'function') failure('CAPABILITY_UNAVAILABLE', '未找到当前应用的原生上传管理器。');
      let file: File;
      if (args.file.transferId) {
        const staged = stagedImport;
        if (!staged || staged.transferId !== args.file.transferId || staged.canvasId !== args.canvasId || staged.received !== staged.size || args.kind !== 'video') failure('INCOMPLETE_TRANSFER', '视频尚未完整传输，未调用原生上传。');
        file = new File(staged!.parts as BlobPart[], staged!.name, { type: staged!.mimeType });
        stagedImport = undefined;
      } else {
        const bytes = Uint8Array.from(atob(args.file.base64), (c: string) => c.charCodeAt(0));
        file = new File([bytes], args.file.name, { type: args.file.mimeType });
      }
      importedName = file.name;
      info = await native.upload(file);
      guard(args.canvasId);
    }
    if (!info?.url) failure('UPLOAD_FAILED', '应用未返回上传后的素材 URL。');
    b = bindings(); writable(b, 'creatable');
    const n = makeNode(b, { kind: args.kind, mode: 'upload', position: args.position, data: { title: args.title ?? importedName ?? 'Imported asset', src: info.url, type: 'upload', ...(info.file_id ? { fileId: info.file_id } : {}), ...(info.duration ? { params: { duration: info.duration } } : {}) } });
    b = await changes(b, [{ type: 'add', item: n }]); node(b, n.id);
    return { canvasId: b.id, nodeId: n.id, url: info.url, persistence: await flush(b.id) };
  }
  async function dispatch(action: string, args: any = {}) {
    try {
      let result: any;
      switch (action) {
        case 'diagnose': {
          let canvas: any;
          try { const b = bindings(); canvas = { canvasId: b.id, nodeCount: nodes(b).length, edgeCount: edges(b).length, editingAvailable: b.props.nodesDraggable !== false, viewportAvailable: !!b.viewport }; }
          catch (e: any) { canvas = { error: { code: e.code, message: e.message } }; }
          result = { url: location.href, title: document.title, desktop: w.tapDesktop?.isDesktop === true, adapterVersion: 1, modules: native.moduleUrls, factories: supportedKinds(), creationMethods: Object.fromEntries(['text', 'audio'].map(kind => [kind, native.factories[kind] ? 'native-factory' : webNodeCreationAvailable() ? 'native-dockbar' : 'unavailable'])), nativeSaveAvailable: typeof native.flush === 'function', nativeUploadAvailable: typeof native.upload === 'function', nativeMentionsAvailable: !!native.mentions?.parseAsset, nativeLibraryAvailable: !!native.mentions?.library?.list, ...(native.mentionError ? { mentionError: native.mentionError } : {}), canvas }; break;
        }
        case 'inspect': result = snapshot(bindings(), args); break;
        case 'edit': result = await runEdit(args); break;
        case 'view': result = await setView(args); break;
        case 'save': result = { canvasId: args.canvasId, persistence: await flush(args.canvasId) }; break;
        case 'capabilities': result = { models: clean(native.modelRegistries), supportedNodeKinds: supportedKinds(), submissionMethod: 'native-generation-panel' }; break;
        case 'prepareGeneration': result = await prepareGeneration(args); break;
        case 'submitGeneration': result = await submitGeneration(args); break;
        case 'generationStatus': {
          guard(args.canvasId); const n = node(bindings(), args.nodeId);
          result = { canvasId: args.canvasId, nodeId: args.nodeId, taskInfo: n.data?.taskInfo ?? null, result: { src: n.data?.src, text: n.data?.text, options: n.data?.options }, submission: args.requestId ? submissions.get(args.canvasId + ':' + args.requestId) ?? null : null }; break;
        }
        case 'importFileBegin': case 'importFileChunk': case 'importFileAbort': result = importFilePart(action, args); break;
        case 'importAsset': result = await importAsset(args); break;
        case 'promptReferences': result = await listPromptReferences(args); break;
        case 'promptSet': result = await setPromptReferences(args); break;
        case 'prepareHistory': {
          guard(args.canvasId); writable(bindings());
          const active = document.activeElement as HTMLElement | null; active?.blur();
          result = { canvasId: args.canvasId }; break;
        }
        case 'history': {
          guard(args.canvasId); const b = bindings(); writable(b);
          const choices = b.history[args.action];
          if (!choices || choices.length !== 1) failure('CAPABILITY_UNAVAILABLE', '当前版本没有唯一匹配的原生撤销/重做入口。');
          // Guard and invocation share one renderer task, so navigation cannot interleave.
          guard(args.canvasId);
          const state = choices[0]();
          if (state && Array.isArray(state.nodes) && Array.isArray(state.edges)) {
            await waitFor(args.canvasId, current => nodes(current).length === state.nodes.length && edges(current).length === state.edges.length, 5000);
          } else await settle(args.canvasId);
          const persistence = await flush(args.canvasId);
          result = { ...snapshot(bindings()), historyAction: args.action, changed: state !== null, persistence }; break;
        }
        case 'guard': guard(args.canvasId); result = { canvasId: args.canvasId }; break;
        default: failure('INVALID_ACTION', '未知适配层动作。');
      }
      return { ok: true, ...clean(result) };
    } catch (e: any) { return { ok: false, error: { code: e.code ?? 'ADAPTER_ERROR', message: e.message ?? String(e), ...(e.details ? { details: clean(e.details) } : {}) } }; }
  }
  w.__tapnowCanvasMcp = { version: 1, dispatch };
  return { installed: true };
}
