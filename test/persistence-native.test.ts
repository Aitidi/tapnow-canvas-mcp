import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectPersistenceNative} from '../src/adapter/persistence-native.js';

test('保存发现只检查已识别函数引用的 Module Map，不读取队列条目或调用保存',async()=>{
  const calls:any[]=[];
  const cdp:any={evaluate:async()=>{},send:async(method:string,p:any)=>{
    calls.push({method,p});
    if(method==='Runtime.evaluate')return{result:{objectId:'functions'}};
    if(method==='Runtime.getProperties'){
      if(p.objectId==='functions')return{result:[{value:{type:'function',objectId:'flush',description:'e=>queue.get(e)?.flush()??Promise.resolve("failed")'}}]};
      if(p.objectId==='flush')return{internalProperties:[{name:'[[Scopes]]',value:{objectId:'scopes'}}]};
      if(p.objectId==='scopes')return{result:[{value:{description:'Global',objectId:'global'}},{value:{description:'Closure',objectId:'closure'}},{value:{description:'Module',objectId:'module'}}]};
      assert.equal(p.objectId,'module');
      return{result:[{name:'queue',value:{subtype:'map',objectId:'queue'}},{name:'unrelated',value:{subtype:'map',objectId:'other'}}]};
    }
    if(method==='Runtime.callFunctionOn'){assert.deepEqual(p.arguments,[{objectId:'queue'}]);return{result:{value:true}};}
    return{};
  }};
  assert.deepEqual(await collectPersistenceNative(cdp),{functions:1});
  assert.ok(!calls.some(c=>c.method==='Runtime.getProperties'&&['queue','other','global','closure'].includes(c.p.objectId)));
  assert.equal(calls.at(-1).method,'Runtime.releaseObjectGroup');
});

test('持久化发现失败时释放所有调试句柄',async()=>{
  const methods:string[]=[];
  const cdp:any={evaluate:async()=>{},send:async(method:string)=>{methods.push(method);if(method==='Runtime.evaluate')throw Error('disconnected');return{}}};
  await assert.rejects(collectPersistenceNative(cdp),/disconnected/);assert.equal(methods.at(-1),'Runtime.releaseObjectGroup');
});
