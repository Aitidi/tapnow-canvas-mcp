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

const discover = (exports: any, href = 'tapnow://app/canvas/test') => runInNewContext(
  `(${discoverNativeModules.toString().replace('await import(url)', 'await load(url)')})()`,
  { URL, __name: (value: any) => value, location: { href },
    document: { scripts: [{ src: 'tapnow://app/assets/vendor-pkg-endpoints-AAAAAAAA.js' }], querySelectorAll: () => [] },
    load: async () => exports });

test('0.4.25x 本地化标题的原生工厂可被识别，编辑/放大等其他工厂不会被误认', async () => {
  // Evaluated as source so the shapes stay exactly as in the shipped minified bundle.
  const exports = runInNewContext(`const yi=k=>k,te={TEXT:'text',IMAGE:'image',VIDEO:'video',AUDIO:'audio'},lb={PURE:'pure',GENERATE:'generate'},Hr={GENERATE:'generate',UPLOAD:'upload',EDIT:'edit'},qi={GENERATE:'generate',UPLOAD:'upload'},wp={DEFAULT:'default'};({
    edit:(e={},t)=>{const r={title:yi("editImage"),type:Hr.EDIT,...e};return{id:'edit',type:te.IMAGE,data:r,position:{x:0,y:0},...t}},
    text:(e={},t)=>{const r={type:lb.PURE,title:yi("text"),text:"",...e};return{id:'text',type:te.TEXT,data:r,position:{x:0,y:0},...t}},
    textGenerate:(e={},t)=>{const y={type:lb.GENERATE,title:yi("text"),text:"",...e};return{id:'tg',type:te.TEXT,data:y,position:{x:0,y:0},...t}},
    image:(e={},t)=>{const r={src:"",title:yi("image"),type:Hr.GENERATE,...e};return{id:'img',type:te.IMAGE,data:r,position:{x:0,y:0},...t}},
    imageUpload:(e={},t)=>{const r={src:"",title:yi("uploadImage"),type:Hr.UPLOAD,...e};return{id:'iu',type:te.IMAGE,data:r,position:{x:0,y:0},...t}},
    video:(e={},t)=>{const r={src:"",title:yi("video"),type:qi.GENERATE,...e};return{id:'vid',type:te.VIDEO,data:r,position:{x:0,y:0},...t}},
    videoUpload:(e={},t)=>{const r={src:"",title:yi("uploadVideo"),type:qi.UPLOAD,...e};return{id:'vu',type:te.VIDEO,data:r,position:{x:0,y:0},...t}},
    audio:(e,t,n)=>{return{id:'aud',type:te.AUDIO,position:t||{x:0,y:0},data:{type:wp.DEFAULT,title:yi("audio"),...e},selected:n}},
  })`);
  const { factories } = await discover(exports);
  assert.deepEqual(Object.keys(factories).sort(), ['audio', 'image', 'imageUpload', 'text', 'textGenerate', 'video', 'videoUpload']);
  assert.equal(factories.image({}, {}).id, 'img');
  assert.equal(factories.audio({}, { position: { x: 1, y: 2 } }).position.x, 1);
});

test('旧版字面量标题的原生工厂仍可被识别', async () => {
  const exports = runInNewContext(`const lb={PURE:'pure'};({text:(e={},t)=>{return{id:'text',position:{x:0,y:0},data:{title:"Text",type:lb.PURE,...e},...t}}})`);
  assert.deepEqual(Object.keys((await discover(exports)).factories), ['text']);
});

// Serves `total` canvases per scope, honouring offset/limit; total is a string as the real API returns it.
const listApi = (totals: Record<string, number>) => {
  const calls: any[] = [];
  // Discovery only accepts a getAllCanvas whose source names the endpoint constant.
  const exports = runInNewContext(`const e={GET_ALL_CANVAS:''};({api:{getAllCanvas(a){e.GET_ALL_CANVAS;return{send:async()=>({code:0,data:respond(a)})}},getCanvas(){},createCanvas(){}}})`, {
    respond: (a: any) => { calls.push(a); const total = totals[a.scope]; return { total: String(total), canvases: Array.from({ length: Math.max(0, Math.min(a.limit, total - a.offset)) }, (_, i) => ({ id: `${a.scope}-${a.offset + i}` })) }; },
  });
  return { calls, list: async (args: any) => (await discover(exports)).canvasApi.list(args) };
};

test('画布列表单一范围映射到原生 scope 并请求数字总数', async () => {
  const { calls, list } = listApi({ personal: 1, team_shared: 66 });
  const team = await list({ scope: 'team', limit: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'team_shared'); assert.equal(calls[0].with_total, true);
  assert.equal(team.total, 66); assert.equal(team.canvases.length, 5);
  assert.equal((await list({ scope: 'personal' })).total, 1);
});

test('画布列表默认合并个人与团队，跨范围连续分页且总数正确', async () => {
  const ids = async (args: any) => { const { list } = listApi({ personal: 3, team_shared: 4 }); const r = await list(args); assert.equal(r.total, 7); return Array.from(r.canvases, (c: any) => c.id); };
  assert.deepEqual(await ids({ limit: 2 }), ['personal-0', 'personal-1']);
  assert.deepEqual(await ids({ offset: 2, limit: 3 }), ['personal-2', 'team_shared-0', 'team_shared-1']);
  assert.deepEqual(await ids({ offset: 5, limit: 3 }), ['team_shared-2', 'team_shared-3']);
  assert.deepEqual(await ids({ offset: 9, limit: 3 }), []);
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
