import { TapnowService } from '../src/service.js';
import { readFile,writeFile } from 'node:fs/promises';
const s=new TapnowService();
try{
 const state=JSON.parse(await readFile('artifacts/video-case-state.json','utf8'));
 const result=await s.generationStatus({canvasId:state.canvasId,nodeId:state.nodeId,requestId:'courier-seedance20-10s-silent-submit-v1'});
 await writeFile('artifacts/video-case-status.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
 if(process.argv.includes('--capture')) {
  await s.view({canvasId:state.canvasId,action:'fit'});
  const shot=await s.screenshot({canvasId:state.canvasId});await writeFile('output/courier/canvas.png',Buffer.from(shot.data,'base64'));
 }
}finally{await s.close();}
