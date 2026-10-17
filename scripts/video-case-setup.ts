import { TapnowService } from '../src/service.js';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const s = new TapnowService();
try {
 const b=await s.inspect(); assert.equal(b.canvasId,process.env.TAPNOW_TEST_CANVAS_ID);
 const cfg=(await s.generationCapabilities()).models.video['seedance-2.0']; assert.ok(cfg.variants.some((v:any)=>v.key==='reference'&&v.options.omniReference));
 if(b.nodes.length){ const deleted=await s.edit({canvasId:b.canvasId,requestId:'courier-clear-'+Date.now(),operations:[{op:'delete',nodeIds:b.nodes.map((n:any)=>n.id)}]}); assert.ok(deleted.results.every((r:any)=>r.ok));assert.equal(deleted.persistence.confirmed,true); }
 assert.equal((await s.inspect()).nodes.length,0);
 const created=await s.edit({canvasId:b.canvasId,requestId:'courier-video-'+Date.now(),operations:[{op:'create',kind:'video',mode:'generate',data:{title:'雨夜快递员｜Seedance 2.0 · 10秒 · 无音频',params:{model:'seedance-2.0',variant:'reference',modelType:'reference_to_video',duration:10,generateAudio:false,aspectRatio:'16:9',resolution:'720p',times:1}},position:{x:650,y:450}}]});
 assert.ok(created.results.every((r:any)=>r.ok));
 const nodeId=created.results[0].nodeId;
 await writeFile('artifacts/video-case-state.json',JSON.stringify({canvasId:b.canvasId,nodeId},null,2));
 console.log(JSON.stringify(await s.generationPrepare({canvasId:b.canvasId,nodeId}),null,2));
} finally {await s.close();}
