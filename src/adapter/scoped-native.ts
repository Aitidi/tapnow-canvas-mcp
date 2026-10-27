import type { CdpConnection } from '../cdp.js';

/** Only native constructors and mention helpers; never transfer arbitrary scope state. */
export function isScopedNativeFunction(source: string) {
  const factory = /return\s*\{id:/.test(source) && /position:/.test(source) &&
    /title:["'](?:Text|Audio|Upload Audio)["']/.test(source) && /\.(?:PURE|GENERATE|AUDIO|UPLOAD)/.test(source);
  const parser = /\.nodeType/.test(source) && /\.nodeId/.test(source) && /\.assetId/.test(source) && /nodeName:/.test(source) && /mediaSrc:/.test(source) && /return null/.test(source);
  const tokens = /\.indexOf\(["']\{\{Asset:/.test(source) && /\.endIndex/.test(source) && /\.content/.test(source) && /\.push\(/.test(source) && /return\[\]/.test(source) && !/images:|videos:|audios:/.test(source);
  const expand = /allowedNodeTypes/.test(source) && /allowLegacyNodePayload/.test(source) && /\.indexOf\(["']\{\{Asset:/.test(source) && /images:/.test(source) && /videos:/.test(source) && /audios:/.test(source);
  const normalize = /\.asset_type/.test(source) && /\.compliance_status/.test(source) && /\.\.\.[\w$]+,asset_type:/.test(source) && /compliance_status:/.test(source) && !/metadata|\.asset\b/.test(source);
  const text = /typeof [\w$]+\.content={2,3}["']string["']/.test(source) && /\.metadata/.test(source) && /\.fields/.test(source) && /\.source_url/.test(source) && /\.thumbnail_url/.test(source) && /\.name/.test(source);
  return factory || parser || tokens || expand || normalize || text;
}

/**
 * Web builds retain some native functions in their module scope instead of exports.
 * Inspect only the observed official canvas bundle's Module scope (never Global or
 * Closure). Transfer a small set of recognized function references, not source code
 * or state. The normal renderer recognizers validate each capability again.
 */
export async function collectScopedNative(cdp: CdpConnection) {
  const group = 'tapnow-native-discovery';
  await cdp.evaluate('delete globalThis.__tapnowCanvasMcpScopedNative');
  try {
    const functionReply = await cdp.send('Runtime.evaluate', {
      expression: `(async()=>{if(location.protocol==='tapnow:'&&location.host==='app'){const entry=[...document.scripts].map(s=>s.src).find(value=>{try{const u=new URL(value);return u.protocol==='tapnow:'&&u.host==='app'&&!u.search&&!u.hash&&/^\\/assets\\/main-[A-Za-z0-9_-]{8}\\.js$/.test(u.pathname);}catch{return false;}});if(!entry)return null;const names=[...new Set((await (await fetch(entry)).text()).match(/\\.\\/vendor-pkg-canvas-v2-[A-Za-z0-9_-]{8}\\.js/g)??[])];if(names.length!==1)return null;const module=await import(new URL(names[0],entry).href);return Object.values(module).find(value=>typeof value==='function')??null;}if(location.origin!=='https://app.tapnow.ai')return null;const urls=[...document.scripts].map(s=>s.src).concat([...document.querySelectorAll('link[rel="modulepreload"]')].map(l=>l.href));const url=urls.find(value=>{try{const u=new URL(value);return u.origin==='https://fe-assets.tapnow.media'&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\\/[a-f0-9]{40}\\/assets\\/vendor-pkg-canvas-[A-Za-z0-9_-]{8}\\.js$/.test(u.pathname);}catch{return false;}});if(!url)return null;const module=await import(url);return Object.values(module).find(value=>typeof value==='function')??null;})()`,
      awaitPromise: true, objectGroup: group,
    });
    if (!functionReply.result?.objectId || functionReply.exceptionDetails) return { available: false, functions: 0 };
    const fn = await cdp.send('Runtime.getProperties', { objectId: functionReply.result.objectId, ownProperties: false });
    const scopes = fn.internalProperties?.find((property: any) => property.name === '[[Scopes]]')?.value?.objectId;
    if (!scopes) return { available: false, functions: 0 };
    const list = await cdp.send('Runtime.getProperties', { objectId: scopes, ownProperties: true });
    const references: string[] = [];
    for (const scope of list.result ?? []) {
      if (scope.value?.description !== 'Module' || !scope.value.objectId) continue;
      const properties = await cdp.send('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
      for (const property of properties.result ?? []) {
        const value = property.value;
        if (value?.type === 'function' && value.objectId && typeof value.description === 'string' && isScopedNativeFunction(value.description)) references.push(value.objectId);
      }
    }
    if (!references.length || references.length > 32) return { available: false, functions: 0 };
    const transferred = await cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: 'function(...functions){globalThis.__tapnowCanvasMcpScopedNative=functions;return functions.length;}',
      objectId: functionReply.result.objectId, arguments: references.map(objectId => ({ objectId })), returnByValue: true,
    });
    if (transferred.exceptionDetails) return { available: false, functions: 0 };
    return { available: true, functions: transferred.result?.value ?? 0 };
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: group });
  }
}
