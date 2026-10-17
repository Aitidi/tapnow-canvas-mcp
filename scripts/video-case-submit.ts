import { TapnowService } from '../src/service.js';
import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const s=new TapnowService();
try{
 const state=JSON.parse(await readFile('artifacts/video-case-state.json','utf8'));
 const args={canvasId:state.canvasId,nodeId:state.nodeId,requestId:'courier-seedance20-10s-silent-submit-v1'};
 const p=await s.generationPrepare({canvasId:state.canvasId,nodeId:state.nodeId});
 assert.equal(p.model,'seedance-2.0');assert.equal(p.params.variant,'reference');assert.equal(p.params.duration,10);assert.equal(p.params.generateAudio,false);assert.equal(p.params.times,1);assert.equal(p.ready,true);
 const result=await s.generationSubmit(args);
 await writeFile('artifacts/video-case-submission.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}finally{await s.close();}
