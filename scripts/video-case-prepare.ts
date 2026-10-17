import { TapnowService } from '../src/service.js';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const s=new TapnowService();
try{
 const state=JSON.parse(await readFile('artifacts/video-case-state.json','utf8'));
 const args={canvasId:state.canvasId,nodeId:state.nodeId};
 const r=await s.edit({canvasId:state.canvasId,requestId:'courier-explicit-variant-v1',operations:[{op:'update',nodeId:state.nodeId,data:{params:{model:'seedance-2.0',variant:'reference',modelType:'reference_to_video',duration:10,generateAudio:false,aspectRatio:'16:9',resolution:'720p',times:1}}}]});
 assert.ok(r.results.every((r:any)=>r.ok));assert.equal(r.persistence.confirmed,true);
 await s.cdp.send('Page.reload');let b:any;
 for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,250));try{b=await s.inspect({nodeIds:[state.nodeId]});if(b.nodes.length)break;}catch{}}
 let prep=await s.generationPrepare(args);
 for(let i=0;i<15&&(prep.priceLoading||!prep.ready);i++){await new Promise(r=>setTimeout(r,500));prep=await s.generationPrepare(args);}
 b=await s.inspect();const n=b.nodes.find((n:any)=>n.id===state.nodeId);
 assert.equal(n.data.params.variant,'reference');assert.equal(n.data.params.duration,10);assert.equal(n.data.params.generateAudio,false);
 assert.equal(b.edges.filter((e:any)=>e.target===state.nodeId).length,3);
 assert.equal(prep.params.duration,10);assert.equal(prep.params.generateAudio,false);
 await s.save({canvasId:state.canvasId});
 await writeFile('artifacts/video-case-prepared.json',JSON.stringify(prep,null,2));
 const shot=await s.screenshot({canvasId:state.canvasId});await writeFile('output/courier/prepared.png',Buffer.from(shot.data,'base64'));
 console.log(JSON.stringify(prep,null,2));
}finally{await s.close();}
