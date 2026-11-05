import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {createServer} from '../src/server.js';

test('新增工具拒绝遗漏身份、任意代码和未声明参数',async()=>{
 let calls=0;const service:any={close:async()=>{}};for(const name of ['historyRestore','imageTools','canvasManage','elements','generationControl'])service[name]=async()=>{calls++;return {ok:true}};
 const {server}=createServer(service,{dual:true}),[a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'advanced-schema',version:'1'});await Promise.all([client.connect(a),server.connect(b)]);
 const base={target:'app',canvasId:'e1bcdd91-a65f-4710-a3ea-08d98a4da442',requestId:'advanced-request',nodeId:'image'};
 try{
  for(const [name,args]of [
   ['tapnow_history_restore',{...base,historyId:'batch',url:'https://arbitrary.example/a.png'}],
   ['tapnow_image_tools',{...base,phase:'execute',operation:'resize',settings:{eval:'code'}}],
   ['tapnow_image_tools',{...base,phase:'prepare',operation:'upscale',settings:{scale:100}}],
   ['tapnow_canvas_manage',{target:'app',action:'open',destinationCanvasId:'not-a-canvas'}],
   ['tapnow_elements',{...base,action:'get',elementId:'../file'}],
   ['tapnow_generation_control',{...base,action:'queue_advance',queueId:'../outside'}],
   ['tapnow_generation_control',{target:'app',canvasId:base.canvasId,action:'cancel',nodeId:'image'}],
  ] as any[]){try{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true,name);}catch(e){assert.match(String(e),/invalid|argument|schema|missing|Unrecognized/i);}}
  assert.equal(calls,0);
  await client.callTool({name:'tapnow_history_restore',arguments:{...base,historyId:'batch'}});
  await client.callTool({name:'tapnow_image_tools',arguments:{...base,phase:'prepare',operation:'multi_angle',settings:{rotation:15}}});assert.equal(calls,2);
 }finally{await client.close();await server.close();}
});

test('素材库写入必须有请求 ID、合法身份和动作参数；不接受任意接口或节点注入',async()=>{
  let calls=0;const service:any={libraryManage:async()=>{calls++;return {ok:true}},close:async()=>{}};
  const {server}=createServer(service,{dual:true});const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'new-tool-schema',version:'1'});
  await Promise.all([client.connect(a),server.connect(b)]);
  try{
    const base={target:'app',canvasId:'e1bcdd91-a65f-4710-a3ea-08d98a4da442',action:'rename_asset',assetId:'12',name:'new'};
    for(const args of [base,{...base,requestId:'valid-request',assetId:'../admin'},{...base,requestId:'valid-request',action:'delete_asset'},{...base,requestId:'valid-request',assets:[]},{...base,requestId:'valid-request',name:''}]){
      try{const r=await client.callTool({name:'tapnow_library',arguments:args});assert.equal(r.isError,true);}catch(e){assert.match(String(e),/invalid|argument|schema|missing|requestId|Unrecognized/i);}
    }
    assert.equal(calls,0);
    await client.callTool({name:'tapnow_library',arguments:{...base,requestId:'valid-request'}});assert.equal(calls,1);
  }finally{await client.close();await server.close();}
});
