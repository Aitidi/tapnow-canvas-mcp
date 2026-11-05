/** Serialized renderer extension. Only receives fixed bridge functions, never caller code. */
export function createAdvancedHandlers(native:any, bridge:any) {
  const {guard,bindings,node,nodes,edges,writable,changes,makeNode,runEdit,flush,snapshot,pause,prepareGeneration,generationPanel}=bridge;
  const fail=(code:string,message:string,details?:any):never=>{throw Object.assign(new Error(message),{code,details});};
  const clone=(v:any)=>JSON.parse(JSON.stringify(v));
  const idle=(n:any)=>{if(['pending','running','processing'].includes(n.data?.taskInfo?.status))fail('NODE_BUSY','节点仍有生成任务，不能覆盖或复制。');};
  async function historyRestore(args:any) {
    guard(args.canvasId);let b=bindings();writable(b);const current=node(b,args.nodeId);idle(current);
    if(!['image','video','audio'].includes(current.type))fail('UNSUPPORTED_NODE','历史结果恢复目前支持图片、视频和音频。');
    if(!native.generationHistory||!native.normalizeHistory)fail('CAPABILITY_UNAVAILABLE','当前版本没有完整的原生历史解析入口。');
    const raw=await native.generationHistory(args.canvasId,args.nodeId,100);guard(args.canvasId);
    const batch=raw.items.map(native.normalizeHistory).find((r:any)=>r?.id===args.historyId);
    if(!batch)fail('HISTORY_NOT_FOUND','所选批次不在最近 100 条可读历史中。');
    const resource=args.resourceId?batch.resources.find((r:any)=>r.sourceFileId===args.resourceId):batch.resources[args.resourceIndex??0];
    if(!resource||!/^https?:\/\//.test(resource.url))fail('RESOURCE_NOT_FOUND','所选历史资源不可用。');
    b=bindings();writable(b);const latest=node(b,args.nodeId);idle(latest);
    const data={...clone(latest.data),src:resource.url,currentSourceFileId:resource.sourceFileId,__metadata:{...resource.metadata,url:resource.url},options:batch.options,historyPreviewSrc:undefined,historyVariantsHidden:false,historyVariantCount:Math.max(batch.resources.length,Number(raw.resource_total)||0),taskInfo:{status:'completed'}};
    if(args.restoreParameters!==false){data.params=clone(batch.params??{});if(latest.type==='audio'){data.params.prompt=batch.prompt;delete data.prompt;}else data.prompt=batch.prompt;}
    let restoredId=latest.id;
    if(args.mode==='copy'){
      const copyData={...data,type:'upload',options:[],historyVariantCount:1,title:(latest.data.title??latest.type)+' · '+args.historyId};
      for(const k of ['historySourceNodeId','historyLocalQueues','historyLocalQueueMetadata','historyLocalQueueResourceMetadata'])delete copyData[k];
      const copy=makeNode(b,{kind:latest.type,mode:'upload',data:copyData,position:args.position??{x:latest.position.x+(latest.width??400)+100,y:latest.position.y}});
      b=await changes(b,[{type:'add',item:copy}]);restoredId=copy.id;
    }else b=await changes(b,[{type:'replace',id:latest.id,item:{...latest,data}}]);
    const actual=node(b,restoredId);if(actual.data?.src!==resource.url)fail('EDIT_REJECTED','应用未接受历史结果。',{nodeId:restoredId});
    return {canvasId:args.canvasId,nodeId:restoredId,sourceNodeId:args.nodeId,historyId:batch.id,resourceId:resource.sourceFileId,mode:args.mode??'replace',persistence:await flush(args.canvasId)};
  }
  async function canvasList(args:any){if(!native.canvasApi)fail('CAPABILITY_UNAVAILABLE','当前版本没有画布查询接口。');return native.canvasApi.list(args);}
  async function canvasGet(args:any){if(!native.canvasApi)fail('CAPABILITY_UNAVAILABLE','当前版本没有画布查询接口。');return native.canvasApi.get(args.destinationCanvasId);}
  async function canvasCreate(args:any){if(!native.canvasApi)fail('CAPABILITY_UNAVAILABLE','当前版本没有画布创建接口。');return native.canvasApi.create(args);}
  async function pasteNodes(args:any) {
    guard(args.canvasId);let b=bindings();writable(b,'creatable');const aliases=new Map<string,string>(),copies:any[]=[];
    if(!Array.isArray(args.nodes)||!args.nodes.length||args.nodes.length>100)fail('INVALID_ARGUMENT','每次复制 1–100 个节点。');
    const allowed=new Set(['text','image','video','audio','group']);
    if(args.nodes.some((n:any)=>!allowed.has(n.type)))fail('UNSUPPORTED_NODE','复制仅支持文字、图片、视频、音频和分组。');
    args.nodes.forEach(idle);
    const sources=new Set(args.nodes.map((n:any)=>n.id)),roots=args.nodes.filter((n:any)=>!n.parentId||!sources.has(n.parentId));
    for(const source of args.nodes){const seen=new Set<string>();let n=source;while(n?.parentId&&sources.has(n.parentId)){if(seen.has(n.id))fail('INVALID_GROUP','来源分组存在循环。');seen.add(n.id);n=args.nodes.find((v:any)=>v.id===n.parentId);}}
    if(!roots.length)fail('INVALID_GROUP','来源分组没有根节点。');
    const minX=Math.min(...roots.map((n:any)=>n.position.x)),minY=Math.min(...roots.map((n:any)=>n.position.y));
    for(const source of args.nodes){
      const data=clone(source.data);delete data.taskInfo;delete data.session_id;
      for(const k of ['options','historySourceNodeId','historyPreviewSrc','historyVariantsHidden','historyVariantCount','historyLocalQueues','historyLocalQueueMetadata','historyLocalQueueResourceMetadata'])delete data[k];
      const copy=makeNode(b,{kind:source.type,mode:source.data?.type==='generate'?'generate':source.data?.type==='upload'?'upload':'plain',data,position:{x:source.position.x-minX+(args.position?.x??0),y:source.position.y-minY+(args.position?.y??0)},width:source.width,height:source.height});
      aliases.set(source.id,copy.id);copies.push(copy);
    }
    for(let i=0;i<copies.length;i++)if(args.nodes[i].parentId&&aliases.has(args.nodes[i].parentId)){copies[i].parentId=aliases.get(args.nodes[i].parentId);copies[i].extent='parent';copies[i].position=clone(args.nodes[i].position);}
    for(const copy of copies)for(const container of [copy.data,copy.data.params])if(typeof container?.prompt==='string')for(const [oldId,newId]of aliases)container.prompt=container.prompt.replaceAll('{{node/'+oldId+'}}','{{node/'+newId+'}}');
    b=await changes(b,copies.map(item=>({type:'add',item})));
    const present=new Set(nodes(b).map((n:any)=>n.id));
    if(copies.some(n=>!present.has(n.id)))fail('EDIT_REJECTED','应用没有接受全部复制节点，请先读取目标画布。',{nodeIds:copies.filter(n=>present.has(n.id)).map(n=>n.id)});
    const links=(args.edges??[]).filter((e:any)=>aliases.has(e.source)&&aliases.has(e.target));
    const connected=links.length?await runEdit({canvasId:args.canvasId,operations:links.map((e:any)=>({op:'connect',source:aliases.get(e.source),target:aliases.get(e.target),sourceHandle:e.sourceHandle??undefined,targetHandle:e.targetHandle??undefined}))}):null;
    return {canvasId:args.canvasId,aliases:Object.fromEntries(aliases),nodeIds:copies.map(n=>n.id),connections:connected?.results??[],partial:connected?.results.some((r:any)=>!r.ok)??false,persistence:await flush(args.canvasId)};
  }
  async function elements(args:any){guard(args.canvasId);if(!native.mentions?.elements)fail('CAPABILITY_UNAVAILABLE','当前版本没有 Element 查询接口。');const result=await native.mentions.elements(args);guard(args.canvasId);return {canvasId:args.canvasId,...result};}

  function toolsFor(b:any,nodeId:string){
    const found=new Map<string,any>(),seen=new Set();
    const walk=(v:any,depth=0)=>{if(!v||typeof v!=='object'||depth>7||seen.has(v))return;seen.add(v);if(typeof v.key==='string'&&typeof v.handle==='function')found.set(v.key,v);if(Array.isArray(v))for(const x of v)walk(x,depth+1);else for(const key of ['tools','menuItems','subActions'])walk(v[key],depth+1);};
    for(const f of b.all)if(f.memoizedProps?.nodeId===nodeId&&f.memoizedProps.tools)walk(f.memoizedProps.tools);
    return found;
  }
  async function selectImage(args:any){let b=bindings();writable(b);const n=node(b,args.nodeId);if(n.type!=='image'||!/^https?:\/\//.test(n.data?.src??''))fail('REFERENCE_NOT_READY','请选择有成果的图片节点。');idle(n);b=await changes(b,nodes(b).map((n:any)=>({type:'select',id:n.id,selected:n.id===args.nodeId})));native.selection?.getState?.().setSelectedNodes?.([node(b,args.nodeId)]);if(b.viewport)await b.viewport.fitView({nodes:[{id:args.nodeId}],padding:.4,duration:0});await pause(250);return bindings();}
  function descendants(owner:any){
    const result:any[]=[],stack=[owner],seen=new Set(),propsSeen=new Set();while(stack.length){const f=stack.pop();if(!f||seen.has(f))continue;seen.add(f);if(f.memoizedProps&&typeof f.memoizedProps==='object'&&!propsSeen.has(f.memoizedProps)){propsSeen.add(f.memoizedProps);result.push(f.memoizedProps);}if(f.child)stack.push(f.child);if(f!==owner&&f.sibling)stack.push(f.sibling);}return result;
  }
  function editorOwner(b:any,nodeId:string,operation:string){
    const marker=operation==='multi_angle'?'multiAngleRotation':'relightExport';
    const owners=b.all.filter((f:any)=>{const p=f.memoizedProps;if(p?.nodeId!==nodeId)return false;if(operation==='upscale')return p.visible===true&&typeof p.parentImage==='string';const fn=typeof f.type==='function'?f.type:f.type?.type??f.type?.render;return typeof fn==='function'&&'initialParams' in p&&typeof p.src==='string'&&Function.prototype.toString.call(fn).includes(marker);});
    // React memo wrappers can expose the same native component twice.
    return owners.length&&owners.every((f:any)=>f.memoizedProps===owners[0].memoizedProps)?owners[0]:undefined;
  }
  function editorState(b:any,nodeId:string,operation:string,output?:string){
    const owner=editorOwner(b,nodeId,operation);if(!owner)return {ready:false,fields:{},estimatedPrice:null};
    const props=descendants(owner),single=(filter:any)=>{const p=props.filter(filter);const callback=(v:any)=>v.onCheckedChange??v.onValueChange??v.onChange??v.onAngleChange??v.onSubmit??v.onClick;return p.length&&p.every(v=>callback(v)===callback(p[0]))?p[0]:undefined;};
    const price=single((p:any)=>typeof p.onClick==='function'&&'estimatedPrice' in p&&'isGenerating' in p&&'disabled' in p);
    const preview=single((p:any)=>p['data-testid']==='canvas-node-image-relight-export-btn'&&typeof p.onClick==='function');
    let fields:any={},controls:any={};
    if(operation==='upscale'){
      const form=single((p:any)=>typeof p.onScaleChange==='function'&&typeof p.onStyleChange==='function'&&typeof p.onSubmit==='function'&&'tapiesRequired' in p);
      if(form){fields={scale:form.scale,style:form.style};controls={scale:form.onScaleChange,style:form.onStyleChange};}
    }else if(operation==='multi_angle'){
      for(const [key,min,max]of [['rotation',-90,90],['tilt',-1,1],['zoom',0,10]] as any){const p=single((p:any)=>p.min===min&&p.max===max&&typeof p.onValueChange==='function'&&'locked' in p);if(p){fields[key]=p.value;controls[key]=p.onValueChange;}}
      const wide=single((p:any)=>'checked' in p&&typeof p.onCheckedChange==='function'&&Function.prototype.toString.call(p.onCheckedChange).includes('wide_angle_lens:'));if(wide){fields.wideAngleLens=wide.checked;controls.wideAngleLens=wide.onCheckedChange;}
    }else{
      const angle=single((p:any)=>typeof p.onAngleChange==='function'&&'azimuthDeg' in p&&'imageSrc' in p);
      if(angle){fields.azimuth=angle.azimuthDeg;fields.elevation=angle.elevationDeg;controls.angle=angle.onAngleChange;fields.rimEnabled=angle.rimEnabled;}
      for(const [key,suffix]of [['brightness','%'],['temperature','K']]){const p=single((p:any)=>p.suffix===suffix&&Array.isArray(p.stops)&&typeof p.onChange==='function');if(p){fields[key]=p.value;controls[key]=p.onChange;controls[key+'Values']=p.stops.map((x:any)=>x.value);}}
      const rim=single((p:any)=>'checked' in p&&typeof p.onCheckedChange==='function'&&Function.prototype.toString.call(p.onCheckedChange).includes('rimEnabled:'));if(rim)controls.rimEnabled=rim.onCheckedChange;
    }
    const button=output==='preview'?preview:price;
    const ready=!!button&&!button.disabled&&!button.priceLoading&&!button.sending&&!button.isGenerating&&(output==='preview'||button.estimatedPrice!=null&&button.estimatedPrice!=='-');
    return {ready,fields,controls,button,estimatedPrice:output==='preview'?0:price?.estimatedPrice??null,parametersLocked:owner.memoizedProps.parametersLocked===true};
  }
  async function configureEditor(args:any){
    const settings=args.settings??{};
    for(const [key,value]of Object.entries(settings)){
      guard(args.canvasId);const state=editorState(bindings(),args.nodeId,args.operation,args.output);
      if(state.parametersLocked)fail('POLICY_DENIED','应用锁定了图片工具参数。');
      if(key==='azimuth'||key==='elevation'){
        if(!state.controls?.angle)fail('CAPABILITY_UNAVAILABLE','当前面板没有可调灯光方向。');
        state.controls.angle(key==='azimuth'?value:state.fields.azimuth,key==='elevation'?value:state.fields.elevation);
      }else{
        if(typeof state.controls?.[key]!=='function')fail('INVALID_ARGUMENT','当前图片操作不支持该参数。',{key,ownerAvailable:!!editorOwner(bindings(),args.nodeId,args.operation),available:Object.keys(state.controls??{})});
        const choices=state.controls[key+'Values'];if(choices&&!choices.includes(value))fail('INVALID_ARGUMENT','参数必须使用原生面板提供的档位。',{key,choices});
        state.controls[key](value);
      }
      await pause(80);
      const actual=editorState(bindings(),args.nodeId,args.operation,args.output).fields[key];
      if(actual!==value)fail('EDIT_REJECTED','应用未接受图片工具参数。',{key,expected:value,actual});
    }
    return editorState(bindings(),args.nodeId,args.operation,args.output);
  }
  async function imageTools(args:any){
    guard(args.canvasId);let b=bindings();const source=node(b,args.nodeId);
    if(source.type!=='image')fail('UNSUPPORTED_NODE','此工具仅支持图片节点。');
    const local=['crop','resize','split'];
    if(args.phase==='inspect')return {canvasId:args.canvasId,nodeId:args.nodeId,localOperations:local,nativeOperations:[...toolsFor(b,args.nodeId)].filter(([key])=>['multi_angle','relight','enhance','cutout'].includes(key)).map(([key,t])=>({operation:key==='enhance'?'upscale':key,available:!t.disabled&&!t.invisible&&!t.lockedTooltip})),note:'prepare 会选中图片并打开原生面板；execute 才执行。生成操作必须明确允许扣费。'};
    if(local.includes(args.operation)){
      const plan=await rasterPlan(args,source);
      if(args.phase==='prepare')return {canvasId:args.canvasId,nodeId:args.nodeId,operation:args.operation,ready:true,paid:false,outputs:plan.rectangles.map((r:any)=>({width:r.outWidth,height:r.outHeight}))};
      writable(bindings(),'creatable');if(!native.upload)fail('CAPABILITY_UNAVAILABLE','当前没有原生上传器。');
      const results:any[]=[];
      for(let i=0;i<plan.rectangles.length;i++){
        guard(args.canvasId);const r=plan.rectangles[i],canvas=document.createElement('canvas');canvas.width=r.outWidth;canvas.height=r.outHeight;
        const context=canvas.getContext('2d');if(!context)fail('CAPABILITY_UNAVAILABLE','无法创建图片处理画布。');context!.drawImage(plan.image,r.x,r.y,r.width,r.height,0,0,r.outWidth,r.outHeight);
        const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(v=>v?resolve(v):reject(new Error('PNG export failed')),'image/png'));
        if(blob.size>50*1024*1024)fail('FILE_TOO_LARGE','处理后的单张图片超过 50 MiB。',{results});
        const uploaded=await native.upload(new File([blob],`${args.operation}-${i+1}.png`,{type:'image/png'}));guard(args.canvasId);
        const result=await runEdit({canvasId:args.canvasId,operations:[{op:'create',kind:'image',mode:'upload',data:{src:uploaded.url,title:(source.data.title??'Image')+' · '+args.operation+' '+(i+1)},position:{x:source.position.x+(source.width??400)+100+(i%(args.cols??1))*350,y:source.position.y+Math.floor(i/(args.cols??1))*350}}]});
        results.push(result);if(result.results.some((r:any)=>!r.ok))return {canvasId:args.canvasId,operation:args.operation,partial:true,results};
      }
      return {canvasId:args.canvasId,operation:args.operation,paid:false,results,persistence:await flush(args.canvasId)};
    }
    const key=({upscale:'enhance',multi_angle:'multi_angle',relight:'relight',cutout:'cutout'} as any)[args.operation];
    if(!key)fail('INVALID_ARGUMENT','未知图片操作。');
    if(args.operation!=='relight'&&args.output==='preview')fail('INVALID_ARGUMENT','只有打光支持预览导出。');
    if(args.operation==='cutout'){
      b=await selectImage(args);const tool=toolsFor(b,args.nodeId).get(key);
      if(!tool||tool.disabled||tool.invisible||tool.lockedTooltip)fail('CAPABILITY_UNAVAILABLE','当前图片的原生操作不可用或被应用策略限制。');
      if(args.phase==='prepare')return {canvasId:args.canvasId,nodeId:args.nodeId,operation:args.operation,ready:true,mayConsumeTapies:true,estimatedPrice:null,requiresPaidAuthorization:true};
      if(args.allowPaid!==true)fail('PAID_AUTHORIZATION_REQUIRED','抠图执行须先获得明确授权。');
      const prior=new Set(nodes(b).map((n:any)=>n.id));await tool.handle();await pause(300);guard(args.canvasId);
      return {canvasId:args.canvasId,nodeId:args.nodeId,operation:args.operation,dispatched:true,nodeIds:nodes(bindings()).filter((n:any)=>!prior.has(n.id)).map((n:any)=>n.id),persistence:await flush(args.canvasId)};
    }
    let targetId=args.nodeId,added:any[]=[];
    if(args.phase==='prepare'){
      if(args.operation==='upscale'&&source.data?.type==='upscale'){
        writable(b);idle(source);b=await changes(b,nodes(b).map((n:any)=>({type:'select',id:n.id,selected:n.id===args.nodeId})));native.selection?.getState?.().setSelectedNodes?.([node(b,args.nodeId)]);await pause(250);
      }else{
        b=await selectImage(args);const tool=toolsFor(b,args.nodeId).get(key);
        if(!tool||tool.disabled||tool.invisible||tool.lockedTooltip)fail('CAPABILITY_UNAVAILABLE','当前图片的原生操作不可用或被应用策略限制。');
        const prior=new Set(nodes(b).map((n:any)=>n.id));await tool.handle();await pause(250);guard(args.canvasId);b=bindings();added=nodes(b).filter((n:any)=>!prior.has(n.id));
        if(args.operation==='upscale'){if(added.length!==1||added[0].data?.type!=='upscale')fail('EDIT_REJECTED','未找到唯一的原生放大节点。',{nodeIds:added.map((n:any)=>n.id)});targetId=added[0].id;}
      }
      for(let i=0;i<20&&!editorOwner(bindings(),targetId,args.operation);i++)await pause(150);
    }else{
      writable(b);idle(source);
      if(args.operation==='upscale'?source.data?.type!=='upscale':source.data?.mode!==(args.operation==='multi_angle'?'multi-angle':'relight'))fail('GENERATION_NOT_READY','请先 prepare 并使用返回的 nodeId 执行。');
    }
    guard(args.canvasId);
    const state=await configureEditor({...args,nodeId:targetId});
    if(args.phase==='prepare')return {canvasId:args.canvasId,nodeId:targetId,sourceNodeId:args.nodeId,operation:args.operation,prepared:!!editorOwner(bindings(),targetId,args.operation),ready:state.ready,fields:state.fields,nodeIds:added.map((n:any)=>n.id),estimatedPrice:state.estimatedPrice,requiresPaidAuthorization:args.output!=='preview',persistence:await flush(args.canvasId)};
    if(args.output!=='preview'&&args.allowPaid!==true)fail('PAID_AUTHORIZATION_REQUIRED','图片生成执行须先获得明确授权。');
    if(!state.ready||!state.button||state.estimatedPrice==null||state.estimatedPrice==='-')fail('GENERATION_NOT_READY','原生面板未完成参数与价格准备，请先 prepare 并核对面板。');
    const prior=new Set(nodes(bindings()).map((n:any)=>n.id));
    await state.button.onClick({stopPropagation(){},preventDefault(){}});await pause(300);guard(args.canvasId);
    return {canvasId:args.canvasId,nodeId:args.nodeId,operation:args.operation,output:args.output??'generate',dispatched:true,nodeIds:nodes(bindings()).filter((n:any)=>!prior.has(n.id)).map((n:any)=>n.id),persistence:await flush(args.canvasId)};
  }

  async function rasterPlan(args:any,source:any){
    if(!/^https?:\/\//.test(source.data?.src??''))fail('REFERENCE_NOT_READY','图片尚无可用地址。');idle(source);
    // Fetch explicitly instead of relying on the image loader's shared remote cache.
    // A local object URL also keeps canvas readback origin-clean after CORS succeeds.
    const controller=new AbortController(),downloadTimer=setTimeout(()=>controller.abort(),15000),chunks:Uint8Array[]=[];
    let blob:Blob;
    try{
      const response=await fetch(source.data.src,{credentials:'omit',signal:controller.signal});
      if(!response.ok||!response.body)fail('IMAGE_DECODE_FAILED','图片下载失败。',{status:response.status});
      const mime=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if(!mime?.startsWith('image/'))fail('INVALID_IMAGE','源地址没有返回图片。');
      if(Number(response.headers.get('content-length'))>50*1024*1024)fail('FILE_TOO_LARGE','源图片超过 50 MiB。');
      const reader=response.body!.getReader();let size=0;
      try{for(;;){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>50*1024*1024)fail('FILE_TOO_LARGE','源图片超过 50 MiB。');chunks.push(result.value);}}finally{await reader.cancel().catch(()=>{});}
      blob=new Blob(chunks as BlobPart[],{type:mime});
    }catch(e:any){if(['FILE_TOO_LARGE','INVALID_IMAGE','IMAGE_DECODE_FAILED'].includes(e.code))throw e;fail('IMAGE_DECODE_FAILED','图片下载失败，请检查素材访问后重新准备。',{reason:String(e?.message??e)});}finally{clearTimeout(downloadTimer);controller.abort();}
    const image=new Image(),objectUrl=URL.createObjectURL(blob!);image.src=objectUrl;
    let timer:any;try{await Promise.race([image.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Image decode timed out')),15000);})]);}catch(e:any){fail('IMAGE_DECODE_FAILED','图片解码失败。',{reason:String(e?.message??e)});}finally{clearTimeout(timer);URL.revokeObjectURL(objectUrl);}
    guard(args.canvasId);const width=image.naturalWidth,height=image.naturalHeight;
    if(!width||!height||width*height>64*1024*1024)fail('INVALID_IMAGE','源图片尺寸无效或超过 64MP。');
    const rectangles:any[]=[];
    if(args.operation==='crop'){const r=args.rect;if(!r||![r.x,r.y,r.width,r.height].every(Number.isInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>width||r.y+r.height>height)fail('INVALID_ARGUMENT','裁剪区域必须在图片像素范围内。');rectangles.push({...r,outWidth:r.width,outHeight:r.height});}
    else if(args.operation==='resize'){if(![args.width,args.height].every(v=>Number.isInteger(v)&&v>0&&v<=8192)||args.width*args.height>64*1024*1024)fail('INVALID_ARGUMENT','输出尺寸必须为 1–8192 像素且不超过 64MP。');rectangles.push({x:0,y:0,width,height,outWidth:args.width,outHeight:args.height});}
    else {const rows=args.rows??2,cols=args.cols??2;if(![rows,cols].every(v=>Number.isInteger(v)&&v>=2&&v<=8)||cols>width||rows>height)fail('INVALID_ARGUMENT','分割行列必须为 2–8，且不超过图片尺寸。');for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const x=Math.floor(c*width/cols),y=Math.floor(r*height/rows),w=Math.floor((c+1)*width/cols)-x,h=Math.floor((r+1)*height/rows)-y;rectangles.push({x,y,width:w,height:h,outWidth:w,outHeight:h});}}
    return {image,rectangles};
  }
  async function taskControl(args:any){
    guard(args.canvasId);const b=bindings();
    const items=nodes(b).filter((n:any)=>!args.nodeId||n.id===args.nodeId).map((n:any)=>({nodeId:n.id,kind:n.type,title:n.data?.title,taskInfo:n.data?.taskInfo??null,generationPaused:n.data?.generationPaused??false}));
    if(args.action==='progress'||args.action==='list')return {canvasId:args.canvasId,items};
    const n=node(b,args.nodeId);writable(b);
    if(args.action==='retry_prepare') {if(!['failed','error','cancelled','stopped'].includes(n.data?.taskInfo?.status))fail('NOT_RETRYABLE','只有失败或停止的任务可以准备重试。');return prepareGeneration(args);}
    if(args.action!=='cancel')fail('INVALID_ARGUMENT','未知任务控制动作。');
    // Activity records expose their own stop action; never confuse voice/chat cancel buttons with a media task.
    const candidates=new Set<any>();
    for(const f of b.all){const v=f.memoizedProps?.value;if(v)candidates.add(v);let h=f.memoizedState,i=0;while(h&&i++<1000){if(Array.isArray(h.memoizedState))candidates.add(h.memoizedState[0]);h=h.next;}}
    const actions:any[]=[];
    for(const store of candidates){if(typeof Object.getOwnPropertyDescriptor(store??{},'getState')?.value!=='function')continue;const state=store.getState();if(!state?.recordsByNode||typeof state.setActions!=='function')continue;for(const record of Object.values(state.recordsByNode[args.nodeId]??{}) as any[])if(record.status==='running'&&typeof record.stop==='function'&&(!args.activityId||record.id===args.activityId))actions.push(record);}
    if(actions.length!==1)fail('CAPABILITY_UNAVAILABLE','该任务未暴露唯一的原生取消入口；未修改任务状态。');
    guard(args.canvasId);await actions[0].stop();return {canvasId:args.canvasId,nodeId:args.nodeId,activityId:actions[0].id,cancellationRequested:true};
  }
  return {historyRestore,canvasList,canvasGet,canvasCreate,pasteNodes,elements,imageTools,taskControl};
}
