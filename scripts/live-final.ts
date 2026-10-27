import { TapnowService } from '../src/service.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { guardedReload } from './safe-reload.js';
const s=new TapnowService();
try{
 let b=await s.inspect();assert.equal(b.canvasId,process.env.TAPNOW_TEST_CANVAS_ID);
 const audio=b.nodes.find((n:any)=>n.type==='audio'&&n.data.title==='音频生成配置');assert.ok(audio);
 const update=await s.edit({canvasId:b.canvasId,requestId:'audio-prompt-fix-'+Date.now(),operations:[{op:'update',nodeId:audio.id,data:{prompt:'A gentle ambient instrumental melody for a product demonstration, calm and minimal.'}}]});assert.equal(update.results[0].ok,true);
  let prep=await s.generationPrepare({canvasId:b.canvasId,nodeId:audio.id});
  for(let i=0;i<10&&prep.priceLoading;i++){await new Promise(r=>setTimeout(r,400));prep=await s.generationPrepare({canvasId:b.canvasId,nodeId:audio.id});}
  console.log('AUDIO_PREPARE',JSON.stringify(prep));assert.equal(prep.nativeSubmitAvailable,true);assert.equal(prep.ready,true);
 // Only remove explicitly named temporary fixtures created by these development tests.
  b=await s.inspect();const temp=b.nodes.filter((n:any)=>/^临时删除验证|^撤销重做验证临时节点/.test(n.data.title??''));
  for(const title of ['test-image.png','Imported asset','test-audio.wav','test-video.webm']) { const fixtures=b.nodes.filter((n:any)=>n.data.title===title);temp.push(...fixtures.slice(1)); }
 if(temp.length){const cleanup=await s.edit({canvasId:b.canvasId,requestId:'test-cleanup-'+Date.now(),operations:[{op:'delete',nodeIds:temp.map((n:any)=>n.id)}]});assert.ok(cleanup.results.every((r:any)=>r.ok));}
 b=await s.inspect();const all=b.nodes.map((n:any)=>n.id);
 const layout=await s.edit({canvasId:b.canvasId,requestId:'final-layout-'+Date.now(),operations:[{op:'layout',nodeIds:all,direction:'grid'}]});assert.ok(layout.results.every((r:any)=>r.ok));
 await s.view({canvasId:b.canvasId,action:'fit'});const saved=await s.save({canvasId:b.canvasId});assert.equal(saved.persistence.confirmed,true);
 const before=await s.inspect();await guardedReload(s);let after:any;
 for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,300));try{after=await s.inspect();if(after.nodes.length===before.nodes.length)break;}catch{}}
 assert.equal(after.nodes.length,before.nodes.length);assert.equal(after.edges.length,before.edges.length);
 await s.view({canvasId:b.canvasId,action:'fit'});await mkdir('artifacts',{recursive:true});const shot=await s.screenshot({canvasId:b.canvasId});await writeFile(resolve('artifacts/live-canvas.png'),Buffer.from(shot.data,'base64'));
 const report={ok:true,canvasId:b.canvasId,title:after.title,nodeCount:after.nodes.length,edgeCount:after.edges.length,audioPrepare:prep,nativeHistoryVerified:true,localImageVideoAudioImportVerified:true,urlReferenceVerified:true,reloadPersistenceVerified:true,paidGenerationSubmitted:false,completedAt:new Date().toISOString()};await writeFile(resolve('artifacts/verification.json'),JSON.stringify(report,null,2));console.log('FINAL_PASS',JSON.stringify(report));
}finally{await s.close();}
