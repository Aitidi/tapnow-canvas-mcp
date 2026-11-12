import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectScopedNative, isScopedNativeFunction } from '../src/adapter/scoped-native.js';
import { runInNewContext } from 'node:vm';

test('新版模块首项为重导出包装器时优先选择已识别的本模块函数作为作用域锚点', async () => {
  const nativeText = (data:any={}) => { const type={PURE:'pure'}; return {id:'text-id',position:{x:0,y:0},data:{title:'Text',type:type.PURE,...data}}; };
  const wrapper = ()=>null;
  const cdp:any={evaluate:async()=>{},send:async(method:string,args:any)=>{
    if(method==='Runtime.evaluate') {
      const expression=args.expression.replace('await import(names[0])','await load(names[0])');
      const result=await runInNewContext(expression,{URL,location:{protocol:'tapnow:',host:'app',href:'tapnow://app/p/x',origin:'null'},document:{scripts:[{src:'tapnow://app/assets/main-AAAAAAAA.js'}],querySelectorAll:()=>[]},fetch:async()=>({text:async()=> 'import("./vendor-pkg-canvas-v2-BBBBBBBB.js")'}),load:async(url:string)=>{assert.equal(url,'tapnow://app/assets/vendor-pkg-canvas-v2-BBBBBBBB.js');return {first:wrapper,nativeText};}});
      assert.equal(result,nativeText);
    }
    return {result:{}};
  }};
  await collectScopedNative(cdp);
});

test('网页端同源 Vite 构建从已加载资源中找到画布包，忽略 three-d 附加包与外域', async () => {
  const nativeText = (data:any={}) => { const type={PURE:'pure'}; return {id:'text-id',position:{x:0,y:0},data:{title:'Text',type:type.PURE,...data}}; };
  let loaded = '';
  const cdp:any={evaluate:async()=>{},send:async(method:string,args:any)=>{
    if(method==='Runtime.evaluate') {
      const expression=args.expression.replace('await import(names[0])','await load(names[0])');
      const result=await runInNewContext(expression,{URL,
        location:{protocol:'https:',host:'app.tapnow.ai',origin:'https://app.tapnow.ai',href:'https://app.tapnow.ai/p/bb926a8f-55b4-4bcb-a15b-dab890206062?c=c00b6fe3-09d8-4cf4-b0de-dea5911556f4'},
        __tapnowCanvasMcpModuleHints:['https://app.tapnow.ai/assets/vendor-pkg-canvas-v2-three-d-overlay-BTImtTQ7.js','https://evil.example/assets/vendor-pkg-canvas-v2-CCCCCCCC.js'],
        performance:{getEntriesByType:()=>[{name:'https://app.tapnow.ai/assets/vendor-pkg-canvas-v2-BRj_eiWF.js'}]},
        document:{scripts:[{src:'https://app.tapnow.ai/assets/index-BqrQuwYV.js'}],querySelectorAll:()=>[]},
        load:async(url:string)=>{loaded=url;return {nativeText};}});
      assert.equal(result,nativeText);
    }
    return {result:{}};
  }};
  await collectScopedNative(cdp);
  assert.equal(loaded,'https://app.tapnow.ai/assets/vendor-pkg-canvas-v2-BRj_eiWF.js');
});

test('作用域发现接受 0.4.25x 本地化标题的文字和音频工厂，不接受其他本地化标题', () => {
  assert.equal(isScopedNativeFunction('(e={},t)=>{const r={type:lb.PURE,title:yi("text"),...e};return{id:s,data:r,position:{x:0,y:0},...t}}'), true);
  assert.equal(isScopedNativeFunction('(e,t,n)=>{return{id:s,type:te.AUDIO,position:t,data:{title:yi("audio"),...e}}}'), true);
  assert.equal(isScopedNativeFunction('(e={},t)=>{const r={type:Hr.EDIT,title:yi("timeline"),...e};return{id:s,data:r,position:{x:0,y:0},...t}}'), false);
  // Newer builds minify string literals to template literals.
  assert.equal(isScopedNativeFunction('(e={},t,n=null)=>{let r=`${$.TEXT}-${rt()}`,i={type:Xu.PURE,title:RS(`text`),text:``,...e};return{id:r,type:$.TEXT,data:i,position:{x:0,y:0},...t}}'), true);
});

const parser = 'function parse(e){const a=e.assetId,n=e.nodeId,t=e.nodeType;if(!a)return null;return{nodeName:e.nodeName,mediaSrc:e.mediaSrc,nodeId:n,nodeType:t}}';

test('私有模块发现只转移 Module 中已识别函数，跳过 Global、Closure 与普通状态', async () => {
  const calls: any[] = [];
  const cdp: any = {
    evaluate: async (source: string) => { calls.push({ evaluate: source }); },
    send: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { objectId: 'function' } };
      if (method === 'Runtime.getProperties') {
        if (params.objectId === 'function') return { internalProperties: [{ name: '[[Scopes]]', value: { objectId: 'scopes' } }] };
        if (params.objectId === 'scopes') return { result: [
          { value: { description: 'Module', objectId: 'module' } },
          { value: { description: 'Global', objectId: 'global' } },
          { value: { description: 'Closure', objectId: 'closure' } },
        ] };
        assert.equal(params.objectId, 'module');
        return { result: [
          { value: { type: 'function', objectId: 'parser', description: parser } },
          { value: { type: 'function', objectId: 'unrelated', description: '()=>fetch("/unrelated")' } },
          { value: { type: 'object', objectId: 'state', description: 'Object' } },
        ] };
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: 1 } };
      return {};
    },
  };
  assert.deepEqual(await collectScopedNative(cdp), { available: true, functions: 1 });
  assert.deepEqual(calls.find(c => c.method === 'Runtime.callFunctionOn').params.arguments, [{ objectId: 'parser' }]);
  assert.equal(calls.at(-1).method, 'Runtime.releaseObjectGroup');
});

test('非网页或缺失 Module 调试引用时不转移任何函数，并释放调试句柄', async () => {
  const methods: string[] = [];
  const cdp: any = { evaluate: async () => {}, send: async (method: string) => { methods.push(method); return { result: { type: 'object', subtype: 'null' } }; } };
  assert.deepEqual(await collectScopedNative(cdp), { available: false, functions: 0 });
  assert.deepEqual(methods, ['Runtime.evaluate', 'Runtime.releaseObjectGroup']);
});

test('素材归一化识别必须保留原始 ID，不能把关系 schema 解析器当素材实体解析器', () => {
  assert.equal(isScopedNativeFunction('function n(e){const a=e.asset_type,b=e.compliance_status;return{...e,asset_type:a,compliance_status:b}}'), true);
  assert.equal(isScopedNativeFunction('function n(e){return{asset_id:e.asset_id,asset_type:e.asset_type,compliance_status:e.compliance_status}}'), false);
});
