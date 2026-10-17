import { TapnowService } from '../src/service.js';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createTestFixtures } from './test-fixtures.js';
const expected = process.env.TAPNOW_TEST_CANVAS_ID;
if (!expected) throw new Error('Set TAPNOW_TEST_CANVAS_ID to the dedicated MCP test canvas.');
const s = new TapnowService();
try {
  const current = await s.inspect();
  assert.equal(current.canvasId, expected); assert.match(current.title, /MCP 开发验证/);
  const report: any = { canvasId: expected, paidGenerationSubmitted: false, steps: [] };
  await createTestFixtures();
  const temporaryTitle = '临时删除验证-' + Date.now();
  const requestId = 'live-dedupe-' + Date.now();
  const input = { canvasId: expected, requestId, operations: [{ op: 'create', kind: 'text', data: { title: temporaryTitle, text: '此节点用于删除和撤销验证。' }, position: { x: 0, y: 1000 } }] };
  const once = await s.edit(input), twice = await s.edit(input);
  assert.equal(twice.replayed, true); assert.equal(twice.results[0].nodeId, once.results[0].nodeId);
  const temporaryId = once.results[0].nodeId;
  const deleted = await s.edit({ canvasId: expected, requestId: 'live-delete-' + Date.now(), operations: [{ op: 'delete', nodeIds: [temporaryId] }] });
  assert.equal(deleted.results[0].ok, true);
  assert.ok(!(await s.inspect()).nodes.some((n: any) => n.id === temporaryId));
  {
    const undo = await s.history({ canvasId: expected, action: 'undo' }); assert.ok(undo.nodes.some((n: any) => n.data.title === temporaryTitle), 'Undo must restore deleted content; Tapnow may assign a new node ID');
    const redo = await s.history({ canvasId: expected, action: 'redo' }); assert.ok(!redo.nodes.some((n: any) => n.data.title === temporaryTitle), 'Redo must delete the restored content');
    report.steps.push({ name: 'dedupe-delete-native-undo-redo', replayed: true, undoRestoredNode: true, redoDeletedNode: true });
  }
  for (const kind of ['text', 'image', 'video', 'audio']) {
    const n = current.nodes.find((n: any) => n.type === kind && (n.data.type === 'generate' || kind === 'audio' && n.data.type !== 'upload'));
    if (!n) continue;
    const prepared = await s.generationPrepare({ canvasId: expected, nodeId: n.id });
    console.log('PREPARE', kind, JSON.stringify(prepared));
    report.steps.push({ name: 'prepare-' + kind, result: prepared });
  }
  const image = await s.importAsset({ canvasId: expected, requestId: 'live-upload-image-' + Date.now(), path: resolve('artifacts/fixtures/test-image.png'), position: { x: 0, y: 950 } });
  console.log('IMAGE_UPLOAD', JSON.stringify(image)); report.steps.push({ name: 'local-image-upload', result: image });
  const urlImage = await s.importAsset({ canvasId: expected, requestId: 'live-url-image-' + Date.now(), url: image.url, kind: 'image', position: { x: 420, y: 950 } });
  report.steps.push({ name: 'remote-url-reference', result: urlImage });
  const audio = await s.importAsset({ canvasId: expected, requestId: 'live-upload-audio-' + Date.now(), path: resolve('artifacts/fixtures/test-audio.wav'), position: { x: 840, y: 950 } });
  console.log('AUDIO_UPLOAD', JSON.stringify(audio)); report.steps.push({ name: 'local-audio-upload', result: audio });
  const videoBase64 = await s.cdp.evaluate(`(async()=>{const c=document.createElement('canvas');c.width=64;c.height=64;const ctx=c.getContext('2d');ctx.fillStyle='#28b4dc';ctx.fillRect(0,0,64,64);const stream=c.captureStream(5),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];return await new Promise((resolve,reject)=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onerror=reject;recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());const bytes=new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());resolve(btoa(String.fromCharCode(...bytes)));};recorder.start();const timer=setInterval(()=>{ctx.fillStyle='#28b4dc';ctx.fillRect(0,0,64,64);},100);setTimeout(()=>{clearInterval(timer);recorder.stop();},600);});})()`);
  await writeFile(resolve('artifacts/fixtures/test-video.webm'), Buffer.from(videoBase64, 'base64'));
  const video = await s.importAsset({ canvasId: expected, requestId: 'live-upload-video-' + Date.now(), path: resolve('artifacts/fixtures/test-video.webm'), position: { x: 1260, y: 950 } });
  console.log('VIDEO_UPLOAD', JSON.stringify(video)); report.steps.push({ name: 'local-video-upload', result: video });
  await s.save({ canvasId: expected });
  const before = await s.inspect();
  await s.cdp.send('Page.reload');
  let after: any;
  for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 300)); try { after = await s.inspect(); if (after.nodes.length === before.nodes.length) break; } catch {} }
  assert.equal(after.nodes.length, before.nodes.length);
  for (const imported of [image, urlImage, audio, video]) { const n = after.nodes.find((n: any) => n.id === imported.nodeId); assert.ok(n); assert.equal(n.data.src, imported.url); }
  report.steps.push({ name: 'media-persisted-after-reload', nodeCount: after.nodes.length });
  await s.view({ canvasId: expected, action: 'fit' });
  await mkdir('artifacts', { recursive: true });
  const screenshot = await s.screenshot({ canvasId: expected });
  await writeFile(resolve('artifacts/live-canvas.png'), Buffer.from(screenshot.data, 'base64'));
  await writeFile(resolve('artifacts/live-extended.json'), JSON.stringify(report, null, 2));
  console.log('EXTENDED_PASS', JSON.stringify({ steps: report.steps.length, nodeCount: after.nodes.length, paidGenerationSubmitted: false }));
} finally { await s.close(); }
