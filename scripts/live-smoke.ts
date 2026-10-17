/** Explicit, opt-in integration test. Only run on a dedicated empty test canvas. */
import { TapnowService } from '../src/service.js';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const expected = process.env.TAPNOW_TEST_CANVAS_ID;
if (!expected) throw new Error('Set TAPNOW_TEST_CANVAS_ID to a dedicated empty test canvas.');
const service = new TapnowService();
try {
  const before = await service.inspect();
  assert.equal(before.canvasId, expected);
  assert.equal(before.nodes.length, 0, 'Refusing to modify a nonempty canvas');
  const report: any = { canvasId: expected, startedAt: new Date().toISOString(), paidGenerationSubmitted: false, steps: [] };
  await service.cdp.evaluate(`(async()=>{const root=document.getElementById('root'),key=Object.keys(root).find(k=>k.startsWith('__reactContainer$'));const stack=[root[key].stateNode.current];while(stack.length){const f=stack.pop();if(!f)continue;const p=f.memoizedProps;if(p&&typeof p.onRename==='function'&&typeof p.canvasName==='string'){return await p.onRename('MCP 开发验证');}if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);}return false;})()`);
  const created = await service.edit({ canvasId: expected, requestId: 'live-create-' + Date.now(), operations: [
    { op: 'create', clientId: 'brief', kind: 'text', data: { title: 'MCP 测试说明', text: '这是独立测试画布：验证节点、连线、保存、撤销、布局和素材导入，不提交付费生成。' }, position: { x: 0, y: 0 } },
    { op: 'create', clientId: 'script', kind: 'text', mode: 'generate', data: { title: '文字生成配置', prompt: '写一条简短的测试说明' }, position: { x: 450, y: 0 } },
    { op: 'create', clientId: 'image', kind: 'image', mode: 'generate', data: { title: '图片生成配置', prompt: 'A red cube on a white background' }, position: { x: 900, y: 0 } },
    { op: 'create', clientId: 'video', kind: 'video', mode: 'generate', data: { title: '视频生成配置', prompt: 'A slowly rotating red cube' }, position: { x: 900, y: 450 } },
    { op: 'create', clientId: 'audio', kind: 'audio', mode: 'generate', data: { title: '音频生成配置', prompt: 'Test voice' }, position: { x: 450, y: 450 } },
    { op: 'connect', source: 'brief', target: 'script' },
    { op: 'connect', source: 'brief', target: 'image' },
    { op: 'connect', source: 'image', target: 'video' },
  ] });
  console.log('CREATE', JSON.stringify(created)); report.steps.push({ name: 'create-and-connect', result: created });
  assert.ok(created.results.every((r: any) => r.ok), 'All creation/connection operations must succeed');
  assert.equal(created.persistence.confirmed, true);
  const imageId = created.aliases.image, briefId = created.aliases.brief;
  const updated = await service.edit({ canvasId: expected, requestId: 'live-update-' + Date.now(), operations: [
    { op: 'update', nodeId: briefId, data: { title: 'MCP 修改与持久化已验证' }, width: 400, height: 240 },
    { op: 'layout', direction: 'LR' },
  ] }); report.steps.push({ name: 'update-layout', result: updated });
  assert.ok(updated.results.every((r: any) => r.ok));
  const undo = await service.history({ canvasId: expected, action: 'undo' });
  const redo = await service.history({ canvasId: expected, action: 'redo' });
  report.steps.push({ name: 'history', undoNodeCount: undo.nodes.length, redoNodeCount: redo.nodes.length, persistence: redo.persistence });
  const prepared = await service.generationPrepare({ canvasId: expected, nodeId: imageId });
  console.log('PREPARE', JSON.stringify(prepared)); report.steps.push({ name: 'generation-prepare-no-submit', result: prepared });
  const group = await service.edit({ canvasId: expected, requestId: 'live-group-' + Date.now(), operations: [ { op: 'group', nodeIds: [created.aliases.audio, created.aliases.script], title: 'MCP 测试分组' } ] });
  console.log('GROUP', JSON.stringify(group)); report.steps.push({ name: 'group', result: group });
  assert.ok(group.results.every((r: any) => r.ok));
  const ungroup = await service.edit({ canvasId: expected, requestId: 'live-ungroup-' + Date.now(), operations: [{ op: 'ungroup', nodeId: group.results[0].groupId }] });
  assert.ok(ungroup.results.every((r: any) => r.ok));
  report.steps.push({ name: 'ungroup', result: ungroup });
  const invalid = await service.edit({ canvasId: expected, requestId: 'live-invalid-' + Date.now(), operations: [{ op: 'update', nodeId: 'does-not-exist', data: { title: 'invalid' } }] });
  assert.equal(invalid.results[0].error.code, 'NODE_NOT_FOUND'); report.steps.push({ name: 'invalid-node', result: invalid });
  await assert.rejects(service.edit({ canvasId: '00000000-0000-0000-0000-000000000000', requestId: 'live-wrong-canvas', operations: [{ op: 'create', kind: 'text', data: { text: 'must never appear' } }] }), (e: any) => e.code === 'CANVAS_CHANGED');
  const saved = await service.save({ canvasId: expected }); assert.equal(saved.persistence.confirmed, true);
  const state = await service.inspect();
  const persistenceSignature = (s: any) => JSON.stringify(s.nodes.map((n: any) => ({ id: n.id, type: n.type, title: n.data?.title, position: n.position, parentId: n.parentId })).sort((a: any, b: any) => a.id.localeCompare(b.id)));
  await service.cdp.send('Page.reload');
  let reloaded: any;
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 300)); try { reloaded = await service.inspect(); if (reloaded.nodes.length === state.nodes.length) break; } catch {} }
  assert.equal(persistenceSignature(reloaded), persistenceSignature(state), 'Reloaded data must match saved data');
  report.steps.push({ name: 'reload-persistence', nodeCount: reloaded.nodes.length, edgeCount: reloaded.edges.length });
  await service.view({ canvasId: expected, action: 'fit' });
  await mkdir('artifacts', { recursive: true });
  const screenshot = await service.screenshot({ canvasId: expected });
  await writeFile(resolve('artifacts/live-canvas.png'), Buffer.from(screenshot.data, 'base64'));
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve('artifacts/live-smoke.json'), JSON.stringify(report, null, 2));
  console.log('PASS', JSON.stringify({ canvasId: expected, steps: report.steps.length, nodes: reloaded.nodes.length, edges: reloaded.edges.length, paidGenerationSubmitted: false }));
} finally { await service.close(); }
