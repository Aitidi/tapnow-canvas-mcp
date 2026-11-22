import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {findCanvasBundles,collectModuleHints} from '../src/adapter/bundle-lookup.js';

const origin='https://app.tapnow.ai',prefix='vendor-pkg-canvas',core=origin+'/assets/'+prefix+'-v2-ABCDEFGH.js',companion=origin+'/assets/'+prefix+'-v2-three-d-overlay-12345678.js';
function fixture(values:string[],scripts:string[]=[],texts:Record<string,string>={}){
 const calls:string[]=[];const sandbox:any={URL,__name:(v:any)=>v,location:{origin,protocol:'https:',host:'app.tapnow.ai',href:origin+'/p/project?c=canvas'},document:{scripts:scripts.map(src=>({src})),querySelectorAll:()=>values.map(href=>({href}))},performance:{getEntriesByType:()=>[]},fetch:async(url:string)=>{calls.push(url);if(!(url in texts))throw Error('Unexpected fetch: '+url);return{ok:true,text:async()=>texts[url]}}};
 const run=(legacy=false)=>runInNewContext(`(${findCanvasBundles.toString()})(${legacy})`,sandbox);
 return {sandbox,calls,run};
}
test('loaded core avoids source fetches and ignores companion UI bundles',async()=>{
 const f=fixture([core,companion],[origin+'/assets/index-87654321.js']);assert.deepEqual(Array.from(await f.run()),[core]);assert.deepEqual(f.calls,[]);
});
test('late web attachment discovers missing core from a loaded companion static import without executing it',async()=>{
 const f=fixture([companion],[],{[companion]:`import{n}from"./${prefix}-v2-ABCDEFGH.js";throw Error('must never execute companion');`});
 assert.deepEqual(Array.from(await f.run()),[core]);assert.deepEqual(f.calls,[companion]);
});
test('companion discovery rejects other origins, credentials, query strings and guessed UI packages',async()=>{
 const f=fixture([companion.replace(origin,'https://evil.example'),companion.replace('https://','https://user:password@'),companion+'?x=1',origin+'/assets/'+prefix+'-v2-world-12345678.js']);
 assert.deepEqual(Array.from(await f.run()),[]);assert.deepEqual(f.calls,[]);
});
test('web index import maps identify only known core bundles',async()=>{
 const entry=origin+'/assets/index-87654321.js',f=fixture([],[entry],{[entry]:`import('./${prefix}-v2-ABCDEFGH.js');import('./unrelated-12345678.js');`});
 assert.deepEqual(Array.from(await f.run()),[core]);assert.deepEqual(f.calls,[entry]);
});
test('failed companion lookup is bounded and never guesses a hash or follows unrelated imports',async()=>{
 const second=companion.replace('12345678','23456789'),third=companion.replace('12345678','34567890'),f=fixture([companion,second,third],[],{[companion]:`import './unknown-ABCDEFGH.js'`,[second]:`import 'https://evil.example/assets/${prefix}-v2-ABCDEFGH.js'`});
 assert.deepEqual(Array.from(await f.run()),[]);assert.deepEqual(f.calls,[companion,second]);
});
test('module hints include resolved core even when CDP resource tree omits scripts',async()=>{
 const f=fixture([companion],[],{[companion]:`import './${prefix}-v2-ABCDEFGH.js'`});
 const cdp:any={send:async()=>({frameTree:{frame:{url:origin+'/p/project?c=canvas'},resources:[]}}),evaluate:(expression:string)=>runInNewContext(expression,f.sandbox)};
 assert.equal(await collectModuleHints(cdp),1);assert.deepEqual(Array.from(f.sandbox.__tapnowCanvasMcpModuleHints),[core]);
});
