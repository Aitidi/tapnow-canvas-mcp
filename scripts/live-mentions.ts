/** Opt-in native @material integration test; never submits a generation task. */
import { TapnowService } from '../src/service.js';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { guardedReload } from './safe-reload.js';
const s = new TapnowService();
try {
  let before = await s.inspect();
  assert.equal(before.canvasId, process.env.TAPNOW_TEST_CANVAS_ID); 
  const fixture = before.nodes.find((n: any) => n.type === 'image' && n.data.type === 'upload' && n.data.title === 'test-image.png');
  assert.ok(fixture);
  let target = before.nodes.find((n: any) => n.data.title === '@素材开发验证');
  if (!target) {
    const created = await s.edit({ canvasId: before.canvasId, requestId: 'mention-demo-create-' + Date.now(), operations: [{ op: 'create', kind: 'image', mode: 'generate', data: { title: '@素材开发验证' }, position: { x: 1400, y: 1200 } }] });
    target = (await s.inspect()).nodes.find((n: any) => n.id === created.results[0].nodeId);
  }
  const existing = (await s.inspect()).edges.filter((e: any) => e.source === fixture.id && e.target === target.id);
  if (existing.length) {
    const disconnected = await s.edit({ canvasId: before.canvasId, requestId: 'mention-test-disconnect-' + Date.now(), operations: [{ op: 'disconnect', edgeIds: existing.map((e: any) => e.id) }] });
    assert.ok(disconnected.results.every((r: any) => r.ok));
  }
  const candidates = await s.promptReferences({ canvasId: before.canvasId, nodeId: target.id, source: 'canvas' });
  assert.ok(candidates.items.some((item: any) => item.nodeId === fixture.id && item.usable));
  const request = { canvasId: before.canvasId, nodeId: target.id, requestId: 'mention-demo-set-' + Date.now(), segments: [
    { type: 'text' as const, text: '参考 ' }, { type: 'reference' as const, source: 'canvas' as const, nodeId: fixture.id },
    { type: 'text' as const, text: ' 的色彩，制作产品海报。重复引用：' }, { type: 'reference' as const, source: 'canvas' as const, nodeId: fixture.id },
  ] };
  const written = await s.promptSet(request);
  console.log('SET', JSON.stringify({ prompt: written.prompt, references: written.references.map((r: any) => ({ source: r.source, kind: r.kind, token: r.token })), renderedMentionIds: written.renderedMentionIds, persistence: written.persistence }));
  assert.match(written.prompt, /\{\{Image \d+\}\}/);
  assert.equal(written.references.length, 1);
  assert.equal(written.addedEdgeIds.length, 1, 'Inline reference must automatically create its missing input edge');
  assert.ok(written.renderedMentionIds.includes(fixture.id));
  assert.equal(written.persistence.confirmed, true);
  const replayed = await s.promptSet(request); assert.equal(replayed.replayed, true);
  const graph = await s.inspect(); assert.equal(graph.edges.filter((e: any) => e.source === fixture.id && e.target === target.id).length, 1);
  await guardedReload(s); let restored: any;
  for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 250)); try { restored = await s.inspect({ nodeIds: [target.id] }); if (restored.nodes[0]?.data?.prompt !== undefined) { console.log('prompt hydrated after polls', i); break; } } catch {} }
  assert.equal(restored.nodes[0].data.prompt, written.prompt);
  await s.generationPrepare({ canvasId: before.canvasId, nodeId: target.id });
  const rendered = await s.cdp.evaluate(`(()=>{const els=[...document.querySelectorAll('[contenteditable="true"]')];return els.flatMap(e=>e.editor?.getJSON?.().content??[]).flatMap(p=>p.content??[]).filter(c=>c.type==='mention').map(c=>({id:c.attrs.id,type:c.attrs.type,label:c.attrs.label}));})()`);
  assert.equal(rendered.filter((m: any) => m.id === fixture.id).length, 2);
  await mkdir('artifacts', { recursive: true });
  const shot = await s.screenshot({ canvasId: before.canvasId }); await writeFile('artifacts/mentions-canvas.png', Buffer.from(shot.data, 'base64'));
  const report = { ok: true, canvasReferencesVerified: true, missingReferenceEdgeAutomaticallyAdded: true, repeatedInlineReferenceWithoutDuplicateEdge: true, replayVerified: true, nativeChipsAfterReload: 2, persistenceConfirmed: true, paidGenerationSubmitted: false };
  await writeFile('artifacts/mentions-verification.json', JSON.stringify(report, null, 2));
  console.log('PASS', JSON.stringify(report));
} finally { await s.close(); }
