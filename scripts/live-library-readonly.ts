import { TapnowService } from '../src/service.js';
import assert from 'node:assert/strict';
import { guardedReload } from './safe-reload.js';
const id = process.env.TAPNOW_TEST_CANVAS_ID!;
const s = new TapnowService();
try {
  const list = await s.promptReferences({ canvasId: id, source: 'library', limit: 20 });
  console.log('library items', list.items.length, 'hasMore', list.hasMore, JSON.stringify(list.items.slice(0, 3).map((i: any) => ({ kind: i.kind, label: i.label, space: i.space }))));
  const asset = list.items.find((i: any) => i.kind === 'image');
  if (!asset) { console.log('no image asset in library; skipping write'); process.exit(0); }
  const searched = await s.promptReferences({ canvasId: id, source: 'library', query: asset.label, limit: 10 });
  console.log('search by label hits', searched.items.some((i: any) => i.assetId === asset.assetId));
  const created = await s.edit({ canvasId: id, requestId: 'lib-node-' + Date.now(), operations: [{ op: 'create', clientId: 't', kind: 'image', mode: 'generate', data: { title: '@素材库引用验证' }, position: { x: 1800, y: 1200 } }] });
  const target = created.aliases.t;
  const edgesBefore = (await s.inspect()).edges.length;
  const written = await s.promptSet({ canvasId: id, nodeId: target, requestId: 'lib-set-' + Date.now(), segments: [
    { type: 'text', text: '以 ' }, { type: 'reference', source: 'library', assetId: asset.assetId }, { type: 'text', text: ' 为参考制作简约海报。' } ] });
  console.log('SET', written.prompt, JSON.stringify(written.persistence), 'chips', written.renderedMentionIds.includes(asset.assetId));
  assert.equal((await s.inspect()).edges.length, edgesBefore, 'library reference must not add edges');
  await guardedReload(s);
  let after: any; for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 250)); try { after = await s.inspect({ nodeIds: [target] }); if (after.nodes[0]?.data?.prompt !== undefined) break; } catch {} }
  assert.equal(after.nodes[0].data.prompt, written.prompt);
  const prep = await s.generationPrepare({ canvasId: id, nodeId: target });
  const chips = await s.cdp.evaluate(`[...document.querySelectorAll('[contenteditable="true"]')].flatMap(e=>e.editor?.getJSON?.().content??[]).flatMap(p=>p.content??[]).filter(n=>n.type==='mention').map(n=>n.attrs.id)`);
  console.log('LIBRARY_PASS', JSON.stringify({ promptPersisted: true, chipAfterReload: chips.includes(asset.assetId), ready: prep.ready, price: prep.estimatedPrice }));
} finally { await s.close(); }
