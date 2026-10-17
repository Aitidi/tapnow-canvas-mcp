/** Dedicated test canvas only. Mixed material references; never submits generation. */
import { TapnowService } from '../src/service.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const s = new TapnowService();
try {
  const before = await s.inspect();
  assert.equal(before.canvasId, process.env.TAPNOW_TEST_CANVAS_ID);
  assert.equal(before.title, 'MCP 开发验证');
  const canvasId = before.canvasId;
  const image = before.nodes.find((n: any) => n.type === 'image' && n.data.title === 'test-image.png' && n.data.src);
  assert.ok(image, 'Run the synthetic fixture upload test first');
  const library = JSON.parse(await readFile('artifacts/mention-library-fixture.json', 'utf8'));
  await mkdir('artifacts/fixtures', { recursive: true });
  let red = before.nodes.find((n: any) => n.data.title === 'multi-reference-red.png');
  if (!red) {
    const png = await s.cdp.evaluate(`(()=>{const c=document.createElement('canvas');c.width=64;c.height=64;const x=c.getContext('2d');x.fillStyle='#e85050';x.fillRect(0,0,64,64);return c.toDataURL('image/png').split(',')[1];})()`);
    const path = resolve('artifacts/fixtures/multi-reference-red.png');
    await writeFile(path, Buffer.from(png, 'base64'));
    const uploaded = await s.importAsset({ canvasId, requestId: 'multi-red-upload-' + Date.now(), path, position: { x: 1400, y: 1800 } });
    assert.equal(uploaded.persistence.confirmed, true);
    red = (await s.inspect()).nodes.find((n: any) => n.data.title === 'multi-reference-red.png');
  }
  assert.ok(red);
  let graph = await s.inspect();
  let text = graph.nodes.find((n: any) => n.data.title === '多素材测试文字');
  let target = graph.nodes.find((n: any) => n.data.title === '@多素材混合引用验证');
  if (!text || !target) {
    const operations: any[] = [];
    if (!text) operations.push({ op: 'create', kind: 'text', data: { title: '多素材测试文字', text: '海报要求：青色与珊瑚红搭配，简约留白，突出几何图形。' }, position: { x: 1800, y: 1800 } });
    if (!target) operations.push({ op: 'create', kind: 'image', mode: 'generate', data: { title: '@多素材混合引用验证' }, position: { x: 2200, y: 1800 } });
    const created = await s.edit({ canvasId, requestId: 'multi-create-' + Date.now(), operations });
    assert.ok(created.results.every((r: any) => r.ok));
    graph = await s.inspect();
    text = graph.nodes.find((n: any) => n.data.title === '多素材测试文字');
    target = graph.nodes.find((n: any) => n.data.title === '@多素材混合引用验证');
  }
  assert.ok(text); assert.ok(target);
  const sources = [image.id, red.id, text.id];
  const oldEdges = graph.edges.filter((e: any) => e.target === target.id && sources.includes(e.source));
  if (oldEdges.length) {
    const disconnected = await s.edit({ canvasId, requestId: 'multi-disconnect-' + Date.now(), operations: [{ op: 'disconnect', edgeIds: oldEdges.map((e: any) => e.id) }] });
    assert.ok(disconnected.results.every((r: any) => r.ok));
  }
  const request = { canvasId, nodeId: target.id, requestId: 'multi-prompt-' + Date.now(), segments: [
    { type: 'text', text: '以青色参考图 ' }, { type: 'reference', source: 'canvas', nodeId: image.id },
    { type: 'text', text: ' 和红色参考图 ' }, { type: 'reference', source: 'canvas', nodeId: red.id },
    { type: 'text', text: ' 的配色制作海报，遵循文字要求 ' }, { type: 'reference', source: 'canvas', nodeId: text.id },
    { type: 'text', text: '，同时参考素材库 ' }, { type: 'reference', source: 'library', assetId: library.assetId },
    { type: 'text', text: '。再次强调第一张图 ' }, { type: 'reference', source: 'canvas', nodeId: image.id },
    { type: 'text', text: ' 的青色。此节点仅用于引用测试，不执行生成。' },
  ] } as Parameters<TapnowService['promptSet']>[0];
  const written = await s.promptSet(request);
  assert.equal(written.references.length, 4);
  assert.equal(written.addedEdgeIds.length, 3);
  assert.equal(written.persistence.confirmed, true);
  const canvasImageTokens = written.references.filter((r: any) => r.source === 'canvas' && r.kind === 'image').map((r: any) => r.token);
  assert.equal(new Set(canvasImageTokens).size, 2, 'Distinct images need distinct native numbers');
  assert.equal((await s.promptSet(request)).replayed, true);
  graph = await s.inspect();
  for (const source of sources) assert.equal(graph.edges.filter((e: any) => e.source === source && e.target === target.id).length, 1);
  assert.equal(graph.edges.filter((e: any) => e.target === target.id).length, 3, 'Library references must not add canvas edges');
  await s.cdp.send('Page.reload');
  let restored: any;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { restored = await s.inspect({ nodeIds: [target.id] }); if (restored.nodes.length) break; } catch {}
  }
  assert.equal(restored.nodes[0].data.prompt, written.prompt);
  await s.generationPrepare({ canvasId, nodeId: target.id });
  const chips = await s.cdp.evaluate(`[...document.querySelectorAll('[contenteditable="true"]')].flatMap(e=>e.editor?.getJSON?.().content??[]).flatMap(p=>p.content??[]).filter(n=>n.type==='mention').map(n=>({id:n.attrs.id,label:n.attrs.label,type:n.attrs.type}))`);
  assert.deepEqual(chips.map((c: any) => c.id), [image.id, red.id, text.id, library.assetId, image.id]);
  graph = await s.inspect();
  for (const source of sources) assert.equal(graph.edges.filter((e: any) => e.source === source && e.target === target.id).length, 1);
  const screenshot = await s.screenshot({ canvasId });
  await writeFile('artifacts/mentions-multi.png', Buffer.from(screenshot.data, 'base64'));
  const report = { ok: true, testedAt: new Date().toISOString(), distinctMaterials: 4, canvasImages: 2, canvasText: 1, libraryImages: 1, inlineChips: 5, chipOrderAfterReloadConfirmed: true, distinctImageNumberingConfirmed: true, canvasEdges: 3, duplicateEdgeCount: 0, replayVerified: true, persistenceConfirmed: true, paidGenerationSubmitted: false };
  await writeFile('artifacts/mentions-multi-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await s.close(); }
