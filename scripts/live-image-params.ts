/** Opt-in: switch an image generation node through every native model and every listed parameter value. Never submits generation. */
import { TapnowService } from '../src/service.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { guardedReload } from './safe-reload.js';

const canvasId = process.env.TAPNOW_TEST_CANVAS_ID!;
if (!canvasId) throw new Error('Set TAPNOW_TEST_CANVAS_ID to the dedicated MCP test canvas.');
const s = new TapnowService();
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Serialized into the renderer: read the native image parameter bar and price button for one node. */
function readPanel(nodeId: string) {
  const root: any = document.getElementById('root');
  const key = Object.keys(root).find(k => k.startsWith('__reactContainer$'))!;
  const all: any[] = [], stack = [root[key].stateNode.current];
  while (stack.length) { const f = stack.pop(); if (!f) continue; all.push(f); if (f.sibling) stack.push(f.sibling); if (f.child) stack.push(f.child); }
  const props = all.map(f => f.memoizedProps);
  const bar = props.find(p => p && typeof p.onAspectRatioChange === 'function' && 'availableRatios' in p);
  const price = props.find(p => p && p.nodeId === nodeId && typeof p.onGenerate === 'function' && 'estimatedPrice' in p);
  if (!bar) return null;
  const plain = Object.fromEntries(Object.entries(bar).filter(([k, v]) => typeof v !== 'function' && k !== 'children' && !(v && typeof v === 'object' && !Array.isArray(v))));
  return { ...plain, estimatedPrice: price?.estimatedPrice ?? null, priceLoading: !!price?.priceLoading };
}

// Registry option list -> node param key -> native bar value/list keys.
const OPTION_KEYS: [string, string, string?, string?][] = [
  ['aspectRatios', 'aspectRatio', 'aspectRatio', 'availableRatios'],
  ['imageSizeOptions', 'imageSize', 'imageSize', 'availableImageSizes'],
  ['qualityOptions', 'quality', 'quality', 'availableQualities'],
  ['thinkingLevelOptions', 'thinking_level', 'thinkingLevel', 'availableThinkingLevels'],
  ['modes', 'generateMode', 'mode', 'availableModes'],
];
const BOOLEAN_KEYS = ['enableGoogleSearch', 'enable_image_search'];

const report: any = { canvasId, startedAt: new Date().toISOString(), paidGenerationSubmitted: false, models: [] };
let edits = 0;
const retried: any[] = [];
async function update(nodeId: string, params: any) {
  let r = await s.edit({ canvasId, requestId: 'img-param-' + Date.now() + '-' + edits++, operations: [{ op: 'update', nodeId, data: { params } }] });
  if (!r.results[0].ok && r.results[0].error?.code === 'EDIT_REJECTED') {
    // Record, then retry once: the app may still be settling a previous change.
    retried.push({ params, error: r.results[0].error });
    await pause(1000);
    r = await s.edit({ canvasId, requestId: 'img-param-' + Date.now() + '-' + edits++, operations: [{ op: 'update', nodeId, data: { params } }] });
  }
  if (!r.results[0].ok) return { ok: false, error: r.results[0].error };
  await pause(350);
  const node = (await s.inspect({ nodeIds: [nodeId] })).nodes[0];
  const panel = await s.cdp.evaluate(`(${readPanel.toString()})(${JSON.stringify(nodeId)})`);
  return { ok: true, params: node.data.params, panel, persistence: r.persistence };
}

try {
  const caps = await s.generationCapabilities({});
  const models = Object.entries(caps.models.image) as [string, any][];
  const only = process.env.IMAGE_MODELS?.split(',');
  const created = await s.edit({ canvasId, requestId: 'img-param-node-' + Date.now(), operations: [{ op: 'create', clientId: 't', kind: 'image', mode: 'generate', data: { title: '图片参数全量测试', prompt: 'parameter test, do not generate' }, position: { x: 2400, y: 600 } }] });
  const nodeId = created.aliases.t;
  report.nodeId = nodeId;
  await s.generationPrepare({ canvasId, nodeId });

  for (const [model, spec] of models) {
    if (only && !only.includes(model)) continue;
    const entry: any = { model, provider: spec.provider, defaults: spec.defaults, failures: [], checks: 0 };
    report.models.push(entry);
    const fail = (what: string, detail: any) => { entry.failures.push({ what, ...detail }); };
    const switched = await update(nodeId, { model });
    if (!switched.ok) { fail('switch-model', { error: switched.error }); continue; }
    entry.afterSwitch = { params: switched.params, panel: switched.panel };
    if (switched.params.model !== model) fail('switch-model', { got: switched.params.model });
    if (switched.params.provider !== spec.provider) fail('provider', { expected: spec.provider, got: switched.params.provider });
    for (const [k, v] of Object.entries(spec.defaults ?? {})) if (JSON.stringify(switched.params[k]) !== JSON.stringify(v)) fail('default-after-switch', { key: k, expected: v, got: switched.params[k] });
    if (!switched.panel) fail('native-panel-missing', {});
    // Native lists must offer what the registry lists, so an MCP-written value is selectable in the UI.
    for (const [optionKey, , , listKey] of OPTION_KEYS) {
      const listed = spec.options?.[optionKey];
      if (!listed || !switched.panel || !listKey || !(listKey in switched.panel)) continue;
      const native = switched.panel[listKey];
      if (JSON.stringify(native) !== JSON.stringify(listed)) entry.listMismatch = { ...entry.listMismatch, [optionKey]: { registry: listed, native } };
    }
    for (const [optionKey, paramKey, panelKey] of OPTION_KEYS) {
      const values = spec.options?.[optionKey];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const r = await update(nodeId, { [paramKey]: value }); entry.checks++;
        if (!r.ok) { fail('update', { key: paramKey, value, error: r.error }); continue; }
        if (r.params[paramKey] !== value) fail('data', { key: paramKey, value, got: r.params[paramKey] });
        if (r.params.model !== model) fail('model-drift', { key: paramKey, value, got: r.params.model });
        if (r.panel && panelKey && panelKey in r.panel && r.panel[panelKey] !== value) fail('native-panel', { key: paramKey, value, shown: r.panel[panelKey] });
        if (r.persistence?.confirmed !== true) fail('save', { key: paramKey, value, persistence: r.persistence });
      }
    }
    for (const key of BOOLEAN_KEYS) {
      if (!(key in (spec.defaults ?? {}))) continue;
      for (const value of [true, false]) {
        const r = await update(nodeId, { [key]: value }); entry.checks++;
        if (!r.ok || r.params[key] !== value) fail('boolean', { key, value, got: r.ok ? r.params[key] : r.error });
      }
    }
    const counts: number[] = switched.panel?.availableGenerationCounts ?? [];
    for (const value of counts) {
      const r = await update(nodeId, { times: value }); entry.checks++;
      if (!r.ok || r.params.times !== value) fail('times', { value, got: r.ok ? r.params.times : r.error });
      else if (r.panel && r.panel.generationCount !== value) fail('native-panel', { key: 'times', value, shown: r.panel.generationCount });
    }
    entry.availableGenerationCounts = counts;
    const price = await s.cdp.evaluate(`(${readPanel.toString()})(${JSON.stringify(nodeId)})`);
    entry.priceAfterChanges = price?.estimatedPrice ?? null;
    console.log(JSON.stringify({ model, checks: entry.checks, failures: entry.failures.length, listMismatch: entry.listMismatch ? Object.keys(entry.listMismatch) : [], price: entry.priceAfterChanges }));
  }

  // Persistence: leave a non-default combination, reload only after a confirmed save, and compare.
  const finalModel = only?.[0] ?? 'gpt-image-2.5-flare';
  const finalParams = { model: finalModel };
  await update(nodeId, finalParams);
  const spec = caps.models.image[finalModel];
  const last: any = {};
  for (const [optionKey, paramKey] of OPTION_KEYS) { const values = spec.options?.[optionKey]; if (Array.isArray(values) && values.length > 1) last[paramKey] = values[values.length - 1]; }
  last.times = 3;
  const before = await update(nodeId, last);
  await guardedReload(s);
  let after: any;
  for (let i = 0; i < 60; i++) { await pause(300); try { after = (await s.inspect({ nodeIds: [nodeId] })).nodes[0]; if (after?.data?.params?.model === finalModel && after.data.prompt !== undefined) break; } catch {} }
  report.persistence = { expected: before.params, afterReload: after?.data?.params, equal: JSON.stringify(after?.data?.params) === JSON.stringify(before.params) };
  console.log('PERSIST', JSON.stringify(report.persistence));
  report.finishedAt = new Date().toISOString(); report.retriedAfterReject = retried;
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/image-params.json', JSON.stringify(report, null, 2));
  const failing = report.models.filter((m: any) => m.failures.length);
  console.log('SUMMARY', JSON.stringify({ models: report.models.length, checks: report.models.reduce((a: number, m: any) => a + m.checks, 0), failingModels: failing.map((m: any) => m.model), listMismatchModels: report.models.filter((m: any) => m.listMismatch).map((m: any) => m.model), persisted: report.persistence.equal, retriedAfterReject: retried }));
} finally { await s.close(); }
