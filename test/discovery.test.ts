import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { discoverNativeModules } from '../src/adapter/discovery.js';

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
