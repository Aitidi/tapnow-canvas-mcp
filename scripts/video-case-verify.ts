import { TapnowService } from '../src/service.js';
import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const s=new TapnowService();
try{
 const state=JSON.parse(await readFile('artifacts/video-case-state.json','utf8'));
 const status=await s.generationStatus({canvasId:state.canvasId,nodeId:state.nodeId});
 assert.equal(status.taskInfo.status,'completed');
 const response=await fetch(status.result.src);assert.ok(response.ok);
 const bytes=Buffer.from(await response.arrayBuffer());
 const tracks:string[]=[];let duration:number|undefined;
 function boxes(start:number,end:number){
  for(let offset=start;offset+8<=end;){
   let size=bytes.readUInt32BE(offset),header=8;
   const type=bytes.toString('ascii',offset+4,offset+8);
   if(size===1){assert.ok(offset+16<=end);size=Number(bytes.readBigUInt64BE(offset+8));header=16;}else if(size===0)size=end-offset;
   assert.ok(size>=header&&offset+size<=end,'Malformed MP4 box');
   const body=offset+header;
   if(['moov','trak','mdia'].includes(type))boxes(body,offset+size);
   if(type==='hdlr')tracks.push(bytes.toString('ascii',body+8,body+12));
   if(type==='mvhd'){
    const version=bytes[body];const scale=bytes.readUInt32BE(body+(version===1?20:12));
    const ticks=version===1?Number(bytes.readBigUInt64BE(body+24)):bytes.readUInt32BE(body+16);
    duration=ticks/scale;
   }
   offset+=size;
  }
 }
 boxes(0,bytes.length);
 assert.ok(tracks.includes('vide'));assert.ok(!tracks.includes('soun'),'Output must have no audio track');
 assert.ok(duration!==undefined&&Math.abs(duration-10)<0.1,'Output must be 10 seconds');
 const saved=await s.save({canvasId:state.canvasId});assert.equal(saved.persistence.confirmed,true);
 const report={ok:true,completedAt:new Date().toISOString(),taskId:'635f8bf5-5070-440b-acf3-0ef76ab36c30',model:'seedance-2.0',variant:'reference',durationSeconds:duration,trackTypes:tracks,audioTrackCount:tracks.filter(t=>t==='soun').length,referenceImages:3,resultUrl:status.result.src,persistenceConfirmed:true};
 await writeFile('output/courier/result.json',JSON.stringify(report,null,2));
 await s.view({canvasId:state.canvasId,action:'fit'});await new Promise(r=>setTimeout(r,1000));
 const shot=await s.screenshot({canvasId:state.canvasId});await writeFile('output/courier/canvas.png',Buffer.from(shot.data,'base64'));
 console.log(JSON.stringify(report,null,2));
}finally{await s.close();}
