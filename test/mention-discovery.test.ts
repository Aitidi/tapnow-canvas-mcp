import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { discoverMentionNative } from '../src/adapter/mention-discovery.js';

type FixtureOptions = {
  webSplit?: boolean;
  webScoped?: boolean;
  personal?: number;
  team?: number;
  invalidPersonal?: number[];
  metadataTotals?: [number, number];
  mutatePage?: (group: any, space: number) => void;
};

async function fixture(options: FixtureOptions = {}) {
  const calls: any[] = [];
  const groups = [options.personal ?? 250, options.team ?? 130].map((count, space) => Array.from({ length: count }, (_, index) => ({ asset: {
    id: (space ? 'team-' : 'personal-') + index,
    name: '素材 ' + index,
    asset_type: space === 0 && options.invalidPersonal?.includes(index) ? 99 : 1,
    source_url: 'https://assets.example/' + space + '/' + index + '.png',
  } })));
  const group = (space: number, page: number, size: number) => {
    const value = { items: groups[space].slice((page - 1) * size, page * size), pagination: {
      total: size === 1 && options.metadataTotals ? options.metadataTotals[space] : groups[space].length,
      page, page_size: size,
    } };
    if (size === 100) options.mutatePage?.(value, space);
    return value;
  };
  const handler = async (endpoint: string, args: any) => {
    calls.push({ endpoint, args: JSON.parse(JSON.stringify(args)) });
    if (endpoint === 'search') return { data: group(args.space_type - 1, args.page, args.page_size) };
    if (endpoint === 'list') return { data: {
      private_group: group(0, args.private_page, args.private_page_size),
      team_group: group(1, args.team_page, args.team_page_size),
    } };
    throw new Error('Unexpected fixture API call: ' + endpoint);
  };
  const sandbox: any = {
    URL, console, __name: (fn: any) => fn, handler,
    location: { href: 'https://app.example/canvas/test' },
    document: { scripts: [{ src: 'https://app.example/assets/UnlimitedModeToggle-test.js' }], querySelectorAll: () => [] },
  };
  if (options.webSplit || options.webScoped) {
    sandbox.location.href = 'https://app.tapnow.ai/canvas/test';
    sandbox.document.scripts = ['vendor-pkg-canvas-test1234.js', 'vendor-packages-test1234.js'].map(name => ({ src: 'https://fe-assets.tapnow.media/' + 'a'.repeat(40) + '/assets/' + name }));
  }
  // Source signatures intentionally model the production export recognizers.
  // Only module loading is substituted; discovery and pagination run unchanged.
  runInNewContext(`
    const endpoints={SEARCH_ASSETS:'search',GET_ASSET_DETAIL:'get',LIST_ASSETS_FOR_MENTION:'list'};
    function parser(text){const a=JSON.parse(text.slice(6));if(!a.nodeType||!a.nodeId||!a.assetId)return null;return {nodeName:a.nodeName,mediaSrc:a.mediaSrc,previewImage:a.previewImage,durationMs:a.durationMs,official:a.official};}
    function tokenParser(prompt){if(!prompt)return[];const result=[];const index=prompt.indexOf('{{Asset:');if(index>=0){const item={endIndex:index+1,content:prompt};result.push(item);item.endIndex;item.content;}return result;}
    function expander(prompt,options){const allowedNodeTypes=options.allowedNodeTypes,allowLegacyNodePayload=options.allowLegacyNodePayload;const index=prompt.indexOf('{{Asset:');const a=options.mediaSrc;return {images:[],videos:[],audios:[],allowedNodeTypes,allowLegacyNodePayload,index,a};}
    function normalize(a){return {...a,asset_type:a.asset_type,compliance_status:a.compliance_status};}
    function textContent(a){if(typeof a.content==='string')return a.content;return a.metadata?.fields?.[0]?.source_url??a.thumbnail_url??a.name;}
    const api={searchAssets:async function(args){return handler(endpoints.SEARCH_ASSETS,args)},getAssetDetail:async function(args){return handler(endpoints.GET_ASSET_DETAIL,args)},listAssetsForMention:async function(args){return handler(endpoints.LIST_ASSETS_FOR_MENTION,args)}};
    function relationSchema(a){return {asset_id:a.asset_id,asset_type:a.asset_type,compliance_status:a.compliance_status};}
    globalThis.nativeModule={relationSchema,parser,tokenParser,expander,normalize,textContent,api};
  `, sandbox);
  if (options.webScoped) sandbox.__tapnowCanvasMcpScopedNative = Object.values(sandbox.nativeModule).filter(value => typeof value === 'function');
  sandbox.load = async (url: string) => options.webScoped ? { relationSchema: sandbox.nativeModule.relationSchema, api: sandbox.nativeModule.api } : options.webSplit
    ? Object.fromEntries(Object.entries(sandbox.nativeModule).filter(([key]) => url.includes('vendor-pkg-canvas-') ? ['parser', 'tokenParser', 'expander'].includes(key) : ['normalize', 'textContent', 'api'].includes(key)))
    : sandbox.nativeModule;
  const source = discoverMentionNative.toString();
  assert.equal(source.split('await import(moduleUrl)').length, 2, '测试仅替换唯一原生模块加载位置');
  const api = await runInNewContext(`(${source.replace('await import(moduleUrl)', 'await load(moduleUrl)')})()`, sandbox);
  return { list: async (args: any = {}) => JSON.parse(JSON.stringify(await api.library.list(args))), calls };
}

test('网页 @素材发现跨两个官方 CDN 包组合原生解析与素材库，发现阶段不发起素材请求', async () => {
  const f = await fixture({ webSplit: true, personal: 2, team: 0 });
  assert.deepEqual(f.calls, []);
  const result = await f.list({ limit: 2 });
  assert.deepEqual(result.items.map((item: any) => item.assetId), ['personal-0', 'personal-1']);
});

test('网页私有作用域提供真实解析器，素材实体归一化保留 ID 并忽略关系 schema', async () => {
  const f = await fixture({ webScoped: true, personal: 2, team: 0 });
  assert.deepEqual(f.calls, []);
  const result = await f.list({ limit: 2 });
  assert.deepEqual(result.items.map((item: any) => item.assetId), ['personal-0', 'personal-1']);
});

test('@素材库原生发现不请求网络，个人库超过前200项仍可分页', async () => {
  const f = await fixture({ personal: 350, team: 20 });
  assert.deepEqual(f.calls, []);
  const result = await f.list({ offset: 220, limit: 5 });
  assert.deepEqual(result.items.map((item: any) => item.assetId), ['personal-220', 'personal-221', 'personal-222', 'personal-223', 'personal-224']);
  assert.equal(result.items.every((item: any) => item.space === 'personal'), true);
  assert.equal(result.nextOffset, 225);
  assert.equal(result.hasMore, true);
  assert.deepEqual(f.calls.map(call => call.args), [
    { private_page: 1, private_page_size: 1, team_page: 1, team_page_size: 1 },
    { private_page: 3, private_page_size: 100, team_page: 1, team_page_size: 1 },
  ]);
});

test('@素材库跨个人分页边界精确衔接，最多读取相邻两页', async () => {
  const f = await fixture();
  const result = await f.list({ offset: 95, limit: 10 });
  assert.deepEqual(result.items.map((item: any) => item.assetId), Array.from({ length: 10 }, (_, i) => 'personal-' + (95 + i)));
  assert.equal(result.nextOffset, 105);
  assert.deepEqual(f.calls.map(call => call.args.private_page), [1, 1, 2]);
  assert.deepEqual(f.calls.map(call => call.args.private_page_size), [1, 100, 100]);
});

test('@素材库合并游标按个人后团队排序，跨库时不漏项或重复', async () => {
  const f = await fixture({ personal: 105, team: 103 });
  const first = await f.list({ offset: 100, limit: 10 });
  assert.deepEqual(first.items.map((item: any) => item.assetId), [...Array.from({ length: 5 }, (_, i) => 'personal-' + (100 + i)), ...Array.from({ length: 5 }, (_, i) => 'team-' + i)]);
  assert.deepEqual(first.items.map((item: any) => item.space), [...Array(5).fill('personal'), ...Array(5).fill('team')]);
  assert.equal(first.nextOffset, 110);
  const second = await f.list({ offset: first.nextOffset, limit: 10 });
  assert.deepEqual(second.items.map((item: any) => item.assetId), Array.from({ length: 10 }, (_, i) => 'team-' + (5 + i)));
  const last = await f.list({ offset: 200, limit: 10 });
  assert.deepEqual(last.items.map((item: any) => item.assetId), Array.from({ length: 8 }, (_, i) => 'team-' + (95 + i)));
  assert.equal(last.hasMore, false);
  assert.equal(last.nextOffset, undefined);
});

test('@素材库过滤不支持类型后仍按原始扫描位置推进游标', async () => {
  const f = await fixture({ personal: 12, team: 0, invalidPersonal: [3, 4, 5, 6, 7] });
  const filtered = await f.list({ offset: 3, limit: 5 });
  assert.deepEqual(filtered.items, []);
  assert.equal(filtered.hasMore, true);
  assert.equal(filtered.nextOffset, 8);
  const next = await f.list({ offset: filtered.nextOffset, limit: 5 });
  assert.deepEqual(next.items.map((item: any) => item.assetId), ['personal-8', 'personal-9', 'personal-10', 'personal-11']);
  assert.equal(next.hasMore, false);
});

test('@素材库搜索复用相同合并分页规则并传入正确space_type', async () => {
  const f = await fixture({ personal: 101, team: 10 });
  const result = await f.list({ query: '  角色  ', offset: 99, limit: 5 });
  assert.deepEqual(result.items.map((item: any) => item.assetId), ['personal-99', 'personal-100', 'team-0', 'team-1', 'team-2']);
  assert.equal(result.nextOffset, 104);
  assert.equal(f.calls.every(call => call.endpoint === 'search' && call.args.keyword === '角色'), true);
  assert.deepEqual(f.calls.slice(0, 2).map(call => call.args), [
    { space_type: 1, keyword: '角色', page: 1, page_size: 1 },
    { space_type: 2, keyword: '角色', page: 1, page_size: 1 },
  ]);
  assert.equal(f.calls.some(call => call.args.space_type === 1 && call.args.page === 2 && call.args.page_size === 100), true);
});

test('@素材库offset越界及空库仅读取总数，不请求内容页', async () => {
  for (const entry of [{ personal: 3, team: 2, offset: 5 }, { personal: 3, team: 2, offset: 999 }, { personal: 0, team: 0, offset: 0 }]) {
    const f = await fixture(entry);
    assert.deepEqual(await f.list({ offset: entry.offset, limit: 5 }), { items: [], hasMore: false });
    assert.equal(f.calls.length, 1);
  }
});

test('@素材库拒绝无效总数和总数溢出，禁止继续读取内容页', async () => {
  for (const totals of [[-1, 1], [1.5, 1], [Number.MAX_SAFE_INTEGER + 1, 1], [Number.MAX_SAFE_INTEGER, 1]]) {
    const f = await fixture({ metadataTotals: totals as [number, number] });
    await assert.rejects(f.list(), (error: any) => error.code === 'LIBRARY_ERROR');
    assert.equal(f.calls.length, 1);
  }
});

test('@素材库内容分页总数、页码、页大小或记录数量变化时明确失败', async () => {
  for (const mutatePage of [
    (group: any) => { group.pagination.total++; },
    (group: any) => { group.pagination.page++; },
    (group: any) => { group.pagination.page_size = 99; },
    (group: any) => { group.items = group.items.slice(0, 1); },
    (group: any) => { group.items = [...group.items, group.items[0]]; },
  ]) {
    const f = await fixture({ mutatePage });
    await assert.rejects(f.list({ offset: 90, limit: 10 }), (error: any) => error.code === 'LIBRARY_ERROR');
  }
});

test('@素材库分页参数无效时不调用原生API', async () => {
  const f = await fixture();
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER, limit: 2 }]) {
    await assert.rejects(f.list(args), (error: any) => error.code === 'LIBRARY_ERROR');
  }
  assert.deepEqual(f.calls, []);
});
