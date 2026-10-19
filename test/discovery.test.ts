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
