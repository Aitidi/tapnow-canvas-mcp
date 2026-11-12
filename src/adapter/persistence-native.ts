import type { CdpConnection } from '../cdp.js';
import { findCanvasBundles } from './bundle-lookup.js';

/** Inspect only the Map named by a recognized official per-canvas flush function.
 * Never read queue entries, transfer state, flush every canvas, or retry a failed save.
 */
export async function collectPersistenceNative(cdp: CdpConnection) {
  const group = 'tapnow-persistence-discovery';
  const signature = '^([\\w$]+)\\s*=>\\s*([\\w$]+)\\.get\\(\\1\\)\\?\\.flush\\(\\)\\?\\?Promise\\.resolve\\(["\u0027\u0060]failed["\u0027\u0060]\\)$';
  await cdp.evaluate('delete globalThis.__tapnowCanvasMcpPersistence');
  try {
    const reply = await cdp.send('Runtime.evaluate', {
      expression: `(async()=>{const __name=(value)=>value;const names=await (${findCanvasBundles.toString()})(true);const found=[];for(const name of names){const m=await import(name);for(const value of Object.values(m))if(typeof value==='function'&&new RegExp(${JSON.stringify(signature)}).test(Function.prototype.toString.call(value)))found.push(value);}return [...new Set(found)];})()`,
      awaitPromise: true, objectGroup: group,
    });
    if (reply.exceptionDetails || !reply.result?.objectId) return { functions: 0 };
    const functions = await cdp.send('Runtime.getProperties', {objectId:reply.result.objectId,ownProperties:true});
    let count = 0;
    for (const item of functions.result ?? []) {
      const fn = item.value;
      if (fn?.type !== 'function' || !fn.objectId || typeof fn.description !== 'string') continue;
      const match = new RegExp(signature).exec(fn.description);
      if (!match) continue;
      const properties = await cdp.send('Runtime.getProperties',{objectId:fn.objectId,ownProperties:false});
      const scopeId = properties.internalProperties?.find((p:any)=>p.name==='[[Scopes]]')?.value?.objectId;
      if (!scopeId) continue;
      const scopes = await cdp.send('Runtime.getProperties',{objectId:scopeId,ownProperties:true});
      for (const scope of scopes.result ?? []) {
        if (scope.value?.description !== 'Module' || !scope.value.objectId) continue;
        const refs = await cdp.send('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true});
        const registry = refs.result?.find((p:any)=>p.name===match[2])?.value;
        if (registry?.subtype !== 'map' || !registry.objectId) continue;
        const transferred = await cdp.send('Runtime.callFunctionOn', {
          objectId:fn.objectId,
          functionDeclaration:'function(registry){const flush=this;(globalThis.__tapnowCanvasMcpPersistence??=[]).push({registered:id=>Map.prototype.has.call(registry,id),flush:id=>flush(id)});return true;}',
          arguments:[{objectId:registry.objectId}],returnByValue:true,
        });
        if (!transferred.exceptionDetails && transferred.result?.value===true) count++;
        break;
      }
    }
    return {functions:count};
  } finally { await cdp.send('Runtime.releaseObjectGroup',{objectGroup:group}); }
}
