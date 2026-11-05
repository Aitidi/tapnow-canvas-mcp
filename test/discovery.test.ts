import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { discoverNativeModules } from '../src/adapter/discovery.js';

test('保存只调用拥有当前画布的队列，不尝试旧队列，不在失败后重放',async()=>{
  const calls:string[]=[];
  const persistence=[{registered:(id:string)=>id==='old',flush:async()=>{calls.push('old');return 'saved'}},{registered:(id:string)=>id==='new',flush:async()=>{calls.push('new');return 'failed'}}];
  const sandbox:any={URL,__name:(x:any)=>x,location:{href:'tapnow://app/canvas/new'},document:{scripts:[],querySelectorAll:()=>[]},__tapnowCanvasMcpPersistence:persistence};
  const native=await runInNewContext(`(${discoverNativeModules.toString()})()`,sandbox);
  assert.deepEqual(calls,[]);assert.equal(await native.flush('new'),'failed');assert.deepEqual(calls,['new']);
  await assert.rejects(native.flush('missing'),(e:any)=>e.code==='SAVE_QUEUE_UNAVAILABLE');
  persistence.push({registered:id=>id==='new',flush:async()=>{throw Error('must not run')}});
  await assert.rejects(native.flush('new'),(e:any)=>e.code==='SAVE_QUEUE_UNAVAILABLE');assert.deepEqual(calls,['new']);
});

test('生成历史发现不调用接口；查询使用原生 send 并拒绝业务失败', async () => {
  const calls:any[]=[]; let code=0;
  const endpoint={GENERATION_HISTORY:()=>''};
  const api={getNodeGenerationHistory:(args:any)=>{ endpoint.GENERATION_HISTORY();calls.push(args);return {send:async()=>({code,data:{items:[],resource_total:0}})};}};
  const sandbox={URL,__name:(v:any)=>v,location:{href:'tapnow://app/canvas/test'},document:{scripts:[{src:'tapnow://app/assets/vendor-pkg-endpoints-AAAAAAAA.js'}],querySelectorAll:()=>[]},load:async()=>({api})};
  const native=await runInNewContext(`(${discoverNativeModules.toString().replace('await import(url)','await load(url)')})()`,sandbox);
  assert.deepEqual(calls,[]);
  assert.equal((await native.generationHistory('canvas','node',5)).resource_total,0);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{canvas_id:'canvas',node_id:'node',limit:5}]);
  code=403;await assert.rejects(native.generationHistory('canvas','node',5),(e:any)=>e.code==='HISTORY_ERROR');
});

test('新版上传器类在发现时不实例化，实际上传时复用原生实例并检查返回值', async () => {
  let constructions = 0, uploads = 0;
  class UploadManager {
    gcsUploader: any;
    constructor() { constructions++; this.gcsUploader = {}; }
    validateFile() {}
    legacyUpload() {}
    async upload(file: any) { this.validateFile(); if (file.fail) return { success: false, error: 'native failure' }; if (file.fallback) this.legacyUpload(); uploads++; return { success: true, fileInfo: { url: 'https://assets.example/test.png' } }; }
  }
  const sandbox = { URL, __name: (value: any) => value, location: {href:'tapnow://app/canvas/test'},
    document: {scripts:[{src:'tapnow://app/assets/vendor-pkg-endpoints-AAAAAAAA.js'}],querySelectorAll:()=>[]},
    load: async () => ({UploadManager}) };
  const native = await runInNewContext(`(${discoverNativeModules.toString().replace('await import(url)', 'await load(url)')})()`, sandbox);
  assert.equal(constructions, 0);
  assert.equal((await native.upload({})).url, 'https://assets.example/test.png');
  await native.upload({});
  assert.equal(constructions, 1); assert.equal(uploads, 2);
  await assert.rejects(native.upload({fail:true}), (e:any)=>e.code==='UPLOAD_FAILED');
});

test('网页原生发现仅加载已暴露的官方 CDN 能力包，排除跟踪脚本、相似域名和未知包', async () => {
  const base = 'https://fe-assets.tapnow.media/' + 'a'.repeat(40) + '/assets/';
  const allowed = [base + 'vendor-pkg-canvas-test1234.js', base + 'vendor-packages-test1234.js'];
  const imports: string[] = [];
  const sandbox = {
    URL, __name: (value: any) => value,
    location: { href: 'https://app.tapnow.ai/canvas/test' },
    document: { scripts: [...allowed, base + 'index-test.js', base + 'tracking-test.js',
      allowed[0].replace('.media/', '.media.evil/'), allowed[0] + '?other=1', base + 'vendor-pkg-canvas-world-test1234.js',
      'https://evil.example/assets/UnlimitedModeToggle-test.js'].map(src => ({ src })), querySelectorAll: () => [] },
    load: async (url: string) => { imports.push(url); return {}; },
  };
  const source = discoverNativeModules.toString().replace('await import(url)', 'await load(url)');
  const result = await runInNewContext(`(${source})()`, sandbox);
  assert.deepEqual(imports, allowed);
  assert.deepEqual(Array.from(result.moduleUrls), allowed);
  sandbox.location.href = 'https://evil.example/canvas/test';
  sandbox.document.scripts = allowed.map(src => ({ src }));
  imports.length = 0;
  await runInNewContext(`(${source})()`, sandbox);
  assert.deepEqual(imports, []);
});

test('0.4.15x 桌面端从入口脚本找到延迟加载的 canvas-v2 主包，只加载已知能力包', async () => {
  const assets = 'tapnow://app/assets/';
  const imports: string[] = [], fetched: string[] = [];
  const preloads = ['vendor-pkg-endpoints-AAAAAAAA.js', 'vendor-pkg-tap-models-BBBBBBBB.js', 'shell-canvas-CCCCCCCC.js',
    'vendor-pkg-canvas-v2-three-d-overlay-DDDDDDDD.js', 'vendor-pkg-canvas-v2-world-EEEEEEEE.js', 'vendor-lib-radix-ui-react-radio-group-FFFFFFFF.js'].map(name => assets + name);
  const sandbox = {
    URL, __name: (value: any) => value,
    location: { href: 'tapnow://app/p/11111111-2222-3333-4444-555555555555?c=e1bcdd91-a65f-4710-a3ea-08d98a4da442' },
    document: { scripts: [{ src: assets + 'main-GGGGGGGG.js' }], querySelectorAll: () => preloads.map(href => ({ href })) },
    fetch: async (url: string) => { fetched.push(url); return { text: async () => 'import("./vendor-pkg-canvas-v2-HHHHHHHH.js");import("./vendor-pkg-canvas-v2-world-EEEEEEEE.js")' }; },
    load: async (url: string) => { imports.push(url); return {}; },
  };
  const source = discoverNativeModules.toString().replace('await import(url)', 'await load(url)');
  const result = await runInNewContext(`(${source})()`, sandbox);
  assert.deepEqual(fetched, [assets + 'main-GGGGGGGG.js']);
  const expected = [assets + 'vendor-pkg-endpoints-AAAAAAAA.js', assets + 'vendor-pkg-tap-models-BBBBBBBB.js', assets + 'shell-canvas-CCCCCCCC.js', assets + 'vendor-pkg-canvas-v2-HHHHHHHH.js'];
  assert.deepEqual(imports, expected);
  assert.deepEqual(Array.from(result.moduleUrls), expected);
});
