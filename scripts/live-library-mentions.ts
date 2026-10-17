/** Creates only a dedicated synthetic library fixture and a private test node. No generation submission. */
import { TapnowService } from '../src/service.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const s = new TapnowService();
try {
  const b = await s.inspect(); assert.equal(b.canvasId, process.env.TAPNOW_TEST_CANVAS_ID); assert.equal(b.title, 'MCP 开发验证');
  const fixture = b.nodes.find((n: any) => n.type === 'image' && n.data.title === 'test-image.png' && n.data.src);
  assert.ok(fixture);
  let libraryFixture: any;
  try { libraryFixture = JSON.parse(await readFile('artifacts/mention-library-fixture.json', 'utf8')); } catch {}
  if (!libraryFixture) {
    libraryFixture = await s.cdp.evaluate(`(async()=>{
      const url=[...document.querySelectorAll('link[rel="modulepreload"]')].map(l=>l.href).find(u=>u.includes('/UnlimitedModeToggle-')&&u.endsWith('.js'));
      const m=await import(url),api=Object.values(m).find(v=>v&&typeof v==='object'&&typeof Object.getOwnPropertyDescriptor(v,'listAssetsForMention')?.value==='function'&&typeof v.getAssetDetail==='function'&&typeof v.saveAssets==='function');
      if(!api||typeof api.createFolder!=='function')throw Error('Native library write API not found');
      const folderResponse=await api.createFolder({space_type:1,parent_id:'0',name:'MCP 素材引用验证'});
      const folder=folderResponse?.data?.folder??folderResponse?.data;
      const folderId=folder?.id??folder?.folder_id;
      if(!folderId)throw Error('Native folder response did not contain an ID');
      const saved=await api.saveAssets({folder_id:folderId,assets:[{asset_type:1,name:'MCP 合成参考图',source_url:${JSON.stringify(fixture.data.src)},thumbnail_url:${JSON.stringify(fixture.data.src)},width:64,height:64}]});
      const id=saved?.data?.asset_ids?.[0];if(!id)throw Error('Native asset response did not contain an ID');
      return {folderId,assetId:id,label:'MCP 合成参考图'};
    })()`);
    await writeFile('artifacts/mention-library-fixture.json', JSON.stringify(libraryFixture, null, 2));
  }
  const list = await s.promptReferences({ canvasId: b.canvasId, source: 'library', query: 'MCP 合成参考图', limit: 10 });
  assert.ok(list.items.some((m: any) => m.assetId === libraryFixture.assetId));
  let target = b.nodes.find((n: any) => n.data.title === '@素材库开发验证');
  if (!target) {
    const created = await s.edit({ canvasId: b.canvasId, requestId: 'library-mention-node-' + Date.now(), operations: [{ op: 'create', kind: 'image', mode: 'generate', data: { title: '@素材库开发验证' }, position: { x: 1800, y: 1200 } }] });
    target = (await s.inspect()).nodes.find((n: any) => n.id === created.results[0].nodeId);
  }
  const beforeEdges = (await s.inspect()).edges.length;
  const written = await s.promptSet({ canvasId: b.canvasId, nodeId: target.id, requestId: 'library-mention-set-' + Date.now(), segments: [
    { type: 'text', text: '以 ' }, { type: 'reference', source: 'library', assetId: libraryFixture.assetId }, { type: 'text', text: ' 为参考，保持配色并制作简约海报。' },
  ] });
  assert.match(written.prompt, /\{\{Asset:/); assert.equal(written.addedEdgeIds.length, 0); assert.equal(written.persistence.confirmed, true);
  assert.ok(written.renderedMentionIds.includes(libraryFixture.assetId));
  assert.equal((await s.inspect()).edges.length, beforeEdges);
  await s.cdp.send('Page.reload');
  let after: any; for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 250)); try { after = await s.inspect({ nodeIds: [target.id] }); if (after.nodes.length) break; } catch {} }
  assert.equal(after.nodes[0].data.prompt, written.prompt);
  await s.generationPrepare({ canvasId: b.canvasId, nodeId: target.id });
  const chips = await s.cdp.evaluate(`[...document.querySelectorAll('[contenteditable="true"]')].flatMap(e=>e.editor?.getJSON?.().content??[]).flatMap(p=>p.content??[]).filter(n=>n.type==='mention').map(n=>n.attrs.id)`);
  assert.ok(chips.includes(libraryFixture.assetId));
  // Check the exact native expansion without submitting or sending model requests.
  const expansion = await s.cdp.evaluate(`(async()=>{const url=[...document.querySelectorAll('link[rel="modulepreload"]')].map(l=>l.href).find(u=>u.includes('/UnlimitedModeToggle-')&&u.endsWith('.js'));const m=await import(url);const fn=Object.values(m).find(v=>{if(typeof v!=='function')return false;try{const x=Function.prototype.toString.call(v);return x.includes('allowedNodeTypes')&&x.includes('allowLegacyNodePayload')&&x.includes('{{Asset:')&&x.includes('images:')&&x.includes('audios:');}catch{return false;}});if(!fn)throw Error('Native expansion unavailable');const r=fn(${JSON.stringify(written.prompt)});return {keys:Object.keys(r),prompt:r.prompt,imageCount:r.images?.length};})()`);
  assert.equal(expansion.imageCount, 1); assert.match(expansion.prompt, /\{\{Image 1\}\}/);
  const shot = await s.screenshot({ canvasId: b.canvasId }); await writeFile('artifacts/mentions-library.png', Buffer.from(shot.data, 'base64'));
  const report = { ok: true, syntheticFixtureOnly: true, librarySearchVerified: true, nativeAssetTokenVerified: true, nativeChipAfterReload: true, nativeGenerationExpansionImageCount: 1, noNewCanvasEdges: true, persistenceConfirmed: true, paidGenerationSubmitted: false };
  await writeFile('artifacts/mentions-library-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await s.close(); }
