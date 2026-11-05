import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {controlQueue,type QueueBridge} from '../src/generation-queue.js';

async function fixture(t:TestContext){
 const dir=await mkdtemp(join(tmpdir(),'tapnow-queue-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const nodes:any={a:{type:'image',data:{type:'generate',prompt:'a',params:{model:'native'}}},b:{type:'video',data:{type:'generate',prompt:'b'}}};
 let submitted=0,cancelled=0,status:any={taskInfo:{taskId:'task-1',status:'running'}};
 const bridge:QueueBridge={inspect:async id=>nodes[id],prepare:async()=>({ready:true}),submit:async()=>({taskId:'task-'+(++submitted)}),status:async()=>status,cancel:async()=>{cancelled++;}};
 const base={canvasId:'canvas',requestId:'queue-request',action:'enqueue',nodeIds:['a','b']};
 const run=(args:any)=>controlQueue({canvasId:'canvas',...args},dir,bridge);
 const q=await run(base);
 return {run,q,base,bridge,nodes,get submitted(){return submitted},get cancelled(){return cancelled},setStatus(v:any){status=v}};
}
test('入队不生成；持久化重放一致且不同输入冲突',async t=>{const f=await fixture(t);assert.equal(f.submitted,0);assert.equal((await f.run(f.base)).replayed,true);await assert.rejects(f.run({...f.base,nodeIds:['b']}),{code:'REQUEST_ID_CONFLICT'});});
test('队列只推进一项，匹配真实任务完成后才推进下一项',async t=>{const f=await fixture(t),args={action:'queue_advance',queueId:f.q.queueId,allowPaid:true};await f.run(args);assert.equal(f.submitted,1);assert.equal((await f.run(args)).blocked,'PREVIOUS_JOB_NOT_SETTLED');f.setStatus({taskInfo:{taskId:'different',status:'completed'}});assert.equal((await f.run(args)).blocked,'PREVIOUS_JOB_NOT_SETTLED');f.setStatus({taskInfo:{taskId:'task-1',status:'completed'}});const q=await f.run(args);assert.equal(q.jobs[0].state,'completed');assert.equal(f.submitted,2);});
test('推进需要授权，参数变化会阻止提交',async t=>{const f=await fixture(t);await assert.rejects(f.run({action:'queue_advance',queueId:f.q.queueId}),{code:'PAID_AUTHORIZATION_REQUIRED'});f.nodes.a.data.prompt='changed';await assert.rejects(f.run({action:'queue_advance',queueId:f.q.queueId,allowPaid:true}),{code:'QUEUE_INPUT_CHANGED'});assert.equal(f.submitted,0);});
test('未知提交结果持久化且禁止再次提交或伪造取消',async t=>{const f=await fixture(t);let attempts=0;f.bridge.submit=async()=>{attempts++;throw Error('connection lost')};const args={action:'queue_advance',queueId:f.q.queueId,allowPaid:true};assert.equal((await f.run(args)).jobs[0].state,'outcome_unknown');assert.equal((await f.run(args)).blocked,'PREVIOUS_JOB_NOT_SETTLED');await assert.rejects(f.run({action:'queue_cancel',queueId:f.q.queueId,jobId:0}),{code:'REQUEST_OUTCOME_UNKNOWN'});assert.equal(attempts,1);});
test('未提交任务可直接取消，运行任务仅请求原生取消',async t=>{const f=await fixture(t);await f.run({action:'queue_cancel',queueId:f.q.queueId,jobId:1});assert.equal(f.cancelled,0);await f.run({action:'queue_advance',queueId:f.q.queueId,allowPaid:true});const q=await f.run({action:'queue_cancel',queueId:f.q.queueId,jobId:0});assert.equal(q.jobs[0].state,'cancel_requested');assert.equal(f.cancelled,1);});
test('准备未就绪不提交，未知队列和路径穿越均拒绝',async t=>{const f=await fixture(t);f.bridge.prepare=async()=>({ready:false});assert.equal((await f.run({action:'queue_advance',queueId:f.q.queueId,allowPaid:true})).blocked,'GENERATION_NOT_READY');assert.equal(f.submitted,0);await assert.rejects(f.run({action:'queue_status',queueId:'../outside'}),{code:'INVALID_ARGUMENT'});await assert.rejects(f.run({action:'queue_status',queueId:'0'.repeat(32)}),{code:'QUEUE_NOT_FOUND'});});
