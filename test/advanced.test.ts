import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAdvancedHandlers} from '../src/adapter/advanced.js';

const canvasId='canvas';
function fixture(){
 let items:any[]=[{id:'image',type:'image',position:{x:10,y:20},width:200,data:{type:'generate',src:'https://files.tapnow.media/current.png',prompt:'current',params:{model:'current'}}}];
 const b:any={id:canvasId,all:[]};let made=0,flushes=0;const edits:any[]=[];
 const native:any={generationHistory:async()=>({items:[{id:'batch'}]}),normalizeHistory:()=>({id:'batch',prompt:'old prompt',params:{model:'old'},options:{count:1},resources:[{sourceFileId:'file-old',url:'https://files.tapnow.media/old.png',metadata:{width:512,height:512}}]})};
 const bridge:any={guard:(id:string)=>assert.equal(id,canvasId),bindings:()=>b,node:(_:any,id:string)=>{const n=items.find(n=>n.id===id);if(!n)throw Object.assign(Error('missing'),{code:'NODE_NOT_FOUND'});return n;},nodes:()=>items,edges:()=>[],writable:()=>{},changes:async(_:any,changes:any[])=>{for(const c of changes){if(c.type==='add')items.push(c.item);if(c.type==='replace')items=items.map(n=>n.id===c.id?c.item:n);if(c.type==='select')items.forEach(n=>{if(n.id===c.id)n.selected=c.selected});}return b;},makeNode:(_:any,args:any)=>({id:'copy-'+(++made),type:args.kind,position:args.position,data:args.data}),runEdit:async(a:any)=>{edits.push(a);return {results:a.operations.map(()=>({ok:true}))}},flush:async()=>{flushes++;return{confirmed:true,status:'saved'}},pause:async()=>{}};
 return {native,bridge,b,handlers:createAdvancedHandlers(native,bridge),edits,get items(){return items},set items(v:any[]){items=v},get flushes(){return flushes}};
}
test('恢复历史同时还原资源、来源 ID、参数及元数据并保存',async()=>{const f=fixture();const r=await f.handlers.historyRestore({canvasId,nodeId:'image',historyId:'batch'});assert.equal(r.nodeId,'image');assert.equal(f.items[0].data.src,'https://files.tapnow.media/old.png');assert.equal(f.items[0].data.currentSourceFileId,'file-old');assert.equal(f.items[0].data.params.model,'old');assert.equal(f.items[0].data.prompt,'old prompt');assert.equal(f.flushes,1);});
test('历史另存为节点不覆盖原图，支持保留当前参数',async()=>{const f=fixture();const r=await f.handlers.historyRestore({canvasId,nodeId:'image',historyId:'batch',mode:'copy',restoreParameters:false,resourceId:'file-old'});assert.equal(f.items.length,2);assert.equal(f.items[0].data.prompt,'current');assert.equal(f.items[1].data.prompt,'current');assert.equal(f.items[1].data.type,'upload');assert.equal(r.nodeId,'copy-1');});

test('恢复清除旧预览，音频提示词写入原生 params；复制不继承旧历史身份',async()=>{
 const f=fixture();f.items[0].type='audio';Object.assign(f.items[0].data,{historyPreviewSrc:'https://files.tapnow.media/preview.png',historySourceNodeId:'old-source',historyLocalQueues:[['old']]});
 await f.handlers.historyRestore({canvasId,nodeId:'image',historyId:'batch'});assert.equal(f.items[0].data.params.prompt,'old prompt');assert.equal(f.items[0].data.prompt,undefined);assert.equal(f.items[0].data.historyPreviewSrc,undefined);
 await f.handlers.historyRestore({canvasId,nodeId:'image',historyId:'batch',mode:'copy'});assert.equal(f.items[1].data.historySourceNodeId,undefined);assert.equal(f.items[1].data.historyLocalQueues,undefined);assert.deepEqual(f.items[1].data.options,[]);
});
test('不存在的历史、资源或生成中的节点不会覆盖现有数据',async()=>{const f=fixture();await assert.rejects(f.handlers.historyRestore({canvasId,nodeId:'image',historyId:'missing'}),{code:'HISTORY_NOT_FOUND'});await assert.rejects(f.handlers.historyRestore({canvasId,nodeId:'image',historyId:'batch',resourceIndex:4}),{code:'RESOURCE_NOT_FOUND'});f.items[0].data.taskInfo={status:'running'};await assert.rejects(f.handlers.historyRestore({canvasId,nodeId:'image',historyId:'batch'}),{code:'NODE_BUSY'});assert.equal(f.flushes,0);});
test('复制分组保留相对位置、重映射内部引用和连线',async()=>{const f=fixture();f.items=[];const group={id:'g',type:'group',position:{x:100,y:100},data:{title:'group'}},a={id:'a',parentId:'g',type:'text',position:{x:20,y:30},data:{text:'text'}},n={id:'b',parentId:'g',type:'image',position:{x:50,y:60},data:{type:'generate',prompt:'{{node/a}}'}};const r=await f.handlers.pasteNodes({canvasId,nodes:[group,a,n],edges:[{source:'a',target:'b'},{source:'outside',target:'b'}],position:{x:500,y:600}});assert.deepEqual(f.items[0].position,{x:500,y:600});assert.deepEqual(f.items[1].position,{x:20,y:30});assert.equal(f.items[1].parentId,r.aliases.g);assert.equal(f.items[2].data.prompt,'{{node/'+r.aliases.a+'}}');assert.equal(f.edits[0].operations.length,1);});
test('循环分组和不支持的节点在写入前拒绝',async()=>{const f=fixture();for(const nodes of [[{id:'a',parentId:'b',type:'group',data:{}},{id:'b',parentId:'a',type:'group',data:{}}],[{id:'a',type:'unknown',data:{}}]])await assert.rejects(f.handlers.pasteNodes({canvasId,nodes}));assert.equal(f.items.length,1);});
test('原生取消不可用时不修改状态；唯一真实 stop 才可调用',async()=>{const f=fixture();await assert.rejects(f.handlers.taskControl({canvasId,nodeId:'image',action:'cancel'}),{code:'CAPABILITY_UNAVAILABLE'});let stops=0;const store={getState:()=>({recordsByNode:{image:[{id:'activity',status:'running',stop:async()=>{stops++}}]},setActions(){}})};f.b.all=[{memoizedProps:{value:store}}];const r=await f.handlers.taskControl({canvasId,nodeId:'image',action:'cancel'});assert.equal(stops,1);assert.equal(r.cancellationRequested,true);assert.equal(f.items[0].data.taskInfo,undefined);});
test('放大节点可在无成果地址时准备与设置参数，重复 UI 包装不误判',async()=>{const f=fixture();f.items[0].data={type:'upscale',src:''};const form:any={scale:2,style:'general',loading:false,tapiesRequired:'16~162',onScaleChange:(v:any)=>{form.scale=v},onStyleChange:(v:any)=>{form.style=v},onSubmit:()=>{throw Error('must not submit')}};const price={onClick:form.onSubmit,isGenerating:false,disabled:false,estimatedPrice:'16~162'};const owner={memoizedProps:{nodeId:'image',visible:true,parentImage:'https://files.tapnow.media/source.png'},child:{memoizedProps:form,child:{memoizedProps:{...form}},sibling:{memoizedProps:price}}};f.b.all=[owner];const r=await f.handlers.imageTools({canvasId,nodeId:'image',phase:'prepare',operation:'upscale',settings:{scale:4}});assert.equal(r.ready,true);assert.equal(r.fields.scale,4);await assert.rejects(f.handlers.imageTools({canvasId,nodeId:'image',phase:'execute',operation:'upscale'}),{code:'PAID_AUTHORIZATION_REQUIRED'});});

test('打光导出只调用节点内的免费原生导出按钮，按钮禁用时拒绝',async()=>{
 const f=fixture();f.items[0].data.mode='relight';let paid=0,exports=0;
 function ownerComponent(){return 'relightExport'}
 const free:any={'data-testid':'canvas-node-image-relight-export-btn',disabled:true,onClick:()=>{exports++}};
 const owner={type:ownerComponent,memoizedProps:{nodeId:'image',initialParams:{},parametersLocked:false,src:f.items[0].data.src},child:{memoizedProps:free,sibling:{memoizedProps:{estimatedPrice:20,disabled:false,isGenerating:false,onClick:()=>{paid++}}}}};f.b.all=[owner];
 const args={canvasId,nodeId:'image',operation:'relight',phase:'execute',output:'preview'};
 await assert.rejects(f.handlers.imageTools(args),{code:'GENERATION_NOT_READY'});free.disabled=false;
 assert.equal((await f.handlers.imageTools(args)).dispatched,true);assert.equal(exports,1);assert.equal(paid,0);
 await f.handlers.imageTools({...args,output:'generate',allowPaid:true});assert.equal(paid,1);
});

test('像素方案拒绝越界裁剪和超大输出，奇数尺寸分割不丢像素',async t=>{
 const previous=(globalThis as any).Image;
 const previousFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
 (globalThis as any).Image=class{naturalWidth=101;naturalHeight=99;async decode(){}};
 t.after(()=>{globalThis.fetch=previousFetch;if(previous===undefined)delete (globalThis as any).Image;else (globalThis as any).Image=previous;});
 const f=fixture(),base={canvasId,nodeId:'image',phase:'prepare'};
 await assert.rejects(f.handlers.imageTools({...base,operation:'crop',rect:{x:100,y:0,width:2,height:10}}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(f.handlers.imageTools({...base,operation:'resize',width:9000,height:100}),{code:'INVALID_ARGUMENT'});
 const r=await f.handlers.imageTools({...base,operation:'split',rows:2,cols:2});assert.equal(r.outputs.length,4);assert.equal(r.outputs.reduce((n:number,r:any)=>n+r.width*r.height,0),101*99);assert.equal(f.items.length,1);assert.equal(f.flushes,0);
});

test('图片处理拒绝伪装格式与超限流，失败时不创建节点',async t=>{
 const previousFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=previousFetch});
 const f=fixture(),args={canvasId,nodeId:'image',phase:'prepare',operation:'resize',width:32,height:32};
 globalThis.fetch=async()=>new Response('<html>',{headers:{'content-type':'text/html'}});
 await assert.rejects(f.handlers.imageTools(args),{code:'INVALID_IMAGE'});
 globalThis.fetch=async()=>new Response(new Uint8Array(1),{headers:{'content-type':'image/png','content-length':String(51*1024*1024)}});
 await assert.rejects(f.handlers.imageTools(args),{code:'FILE_TOO_LARGE'});
 globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(26*1024*1024));controller.enqueue(new Uint8Array(26*1024*1024));controller.close()}}),{headers:{'content-type':'image/png'}});
 await assert.rejects(f.handlers.imageTools(args),{code:'FILE_TOO_LARGE'});assert.equal(f.items.length,1);assert.equal(f.flushes,0);
});
