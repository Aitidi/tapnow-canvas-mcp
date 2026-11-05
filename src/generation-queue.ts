import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from './journal.js';
import {TapnowError} from './errors.js';

export type QueueBridge={inspect:(nodeId:string)=>Promise<any>;prepare:(nodeId:string)=>Promise<any>;submit:(nodeId:string,requestId:string)=>Promise<any>;status:(nodeId:string)=>Promise<any>;cancel:(nodeId:string)=>Promise<any>};
const fail=(code:string,message:string):never=>{throw new TapnowError(code,message);};
const inputHash=(n:any)=>digest({type:n.type,mode:n.data?.type,prompt:n.data?.prompt,params:n.data?.params});

/** Persistent, explicitly advanced queue. No timer submits jobs in the background. */
export async function controlQueue(args:any,directory:string,bridge:QueueBridge){
  await mkdir(directory,{recursive:true});
  const queueId=args.action==='enqueue'?digest([args.canvasId,args.requestId]).slice(0,32):args.queueId;
  if(!/^[a-f0-9]{32}$/.test(queueId??''))fail('INVALID_ARGUMENT','queueId 必须来自 enqueue 返回值。');
  const path=join(directory,queueId+'.json');
  const load=async()=>{try{const q=JSON.parse(await readFile(path,'utf8'));if(q.version!==1||q.queueId!==queueId||q.canvasId!==args.canvasId||!Array.isArray(q.jobs))fail('QUEUE_INVALID','队列记录不匹配。');return q;}catch(e:any){if(e.code==='ENOENT')return null;throw e;}};
  const save=async(q:any)=>{const tmp=path+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(q),{flag:'wx'});await rename(tmp,path);}finally{await unlink(tmp).catch(()=>{});}};
  let queue=await load();
  if(args.action==='enqueue'){
    const nodeIds=[...new Set<string>(args.nodeIds??[])];
    if(!nodeIds.length||nodeIds.length>32||!args.requestId)fail('INVALID_ARGUMENT','入队需要 requestId 和 1–32 个节点。');
    if(queue){if(digest(queue.jobs.map((j:any)=>j.nodeId))!==digest(nodeIds))fail('REQUEST_ID_CONFLICT','同一请求不能替换队列节点。');return {ok:true,...queue,replayed:true};}
    const jobs=[];
    for(const nodeId of nodeIds){const n=await bridge.inspect(nodeId);if(!['text','image','video','audio'].includes(n.type)||['pure','upload'].includes(n.data?.type))fail('NOT_GENERATION_NODE','队列仅接受生成节点。');jobs.push({id:jobs.length,nodeId,inputHash:inputHash(n),state:'queued',requestId:'queue-'+queueId+'-'+jobs.length});}
    queue={version:1,queueId,canvasId:args.canvasId,createdAt:new Date().toISOString(),jobs};await save(queue);return {ok:true,...queue};
  }
  if(!queue)fail('QUEUE_NOT_FOUND','队列不存在。');
  for(const job of queue.jobs.filter((j:any)=>['submitting','running','cancel_requested','outcome_unknown'].includes(j.state))){
    try{const status=await bridge.status(job.nodeId),info=status.taskInfo;
      if(job.taskId&&info?.taskId===job.taskId){if(['completed','success'].includes(info.status))job.state='completed';else if(['failed','error'].includes(info.status))job.state='failed';else if(['cancelled','stopped'].includes(info.status))job.state='cancelled';job.taskInfo=info;}
    }catch(e:any){job.lastStatusError={code:e.code,message:e.message};}
  }
  if(args.action==='queue_cancel'){
    const job=queue.jobs.find((j:any)=>j.id===args.jobId);if(!job)fail('JOB_NOT_FOUND','队列任务不存在。');
    if(job.state==='queued')job.state='cancelled';
    else if(['running','cancel_requested'].includes(job.state)){await bridge.cancel(job.nodeId);job.state='cancel_requested';}
    else if(['submitting','outcome_unknown'].includes(job.state))fail('REQUEST_OUTCOME_UNKNOWN','提交结果未知，不能伪造取消成功。');
  }else if(args.action==='queue_advance'){
    if(args.allowPaid!==true)fail('PAID_AUTHORIZATION_REQUIRED','队列推进会提交下一条生成，须先获得明确授权。');
    if(queue.jobs.some((j:any)=>['submitting','running','cancel_requested','outcome_unknown'].includes(j.state))){await save(queue);return {ok:true,...queue,blocked:'PREVIOUS_JOB_NOT_SETTLED'};}
    const job=queue.jobs.find((j:any)=>j.state==='queued');
    if(job){const n=await bridge.inspect(job.nodeId);if(inputHash(n)!==job.inputHash)fail('QUEUE_INPUT_CHANGED','入队后节点参数已变化，请重新核对并建立新队列。');
      const prepared=await bridge.prepare(job.nodeId);if(!prepared.ready){await save(queue);return {ok:true,...queue,blocked:'GENERATION_NOT_READY',prepared};}
      job.state='submitting';await save(queue);
      try{const result=await bridge.submit(job.nodeId,job.requestId);job.result=result;job.taskId=result.taskId??null;job.state=result.taskId?'running':result.state==='failed'?'failed':'outcome_unknown';}
      catch(e:any){job.state='outcome_unknown';job.error={code:e.code,message:e.message};}
    }
  }else if(args.action!=='queue_status')fail('INVALID_ARGUMENT','未知队列动作。');
  await save(queue);return {ok:true,...queue};
}
