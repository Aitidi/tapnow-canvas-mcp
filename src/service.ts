import { mkdir, open, readFile, stat, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpConnection } from './cdp.js';
import { TapnowError } from './errors.js';
import { RequestJournal, digest } from './journal.js';
import { discoverNativeModules } from './adapter/discovery.js';
import { installRuntime } from './adapter/runtime.js';
import { discoverMentionNative } from './adapter/mention-discovery.js';
import { collectScopedNative, isScopedNativeFunction } from './adapter/scoped-native.js';
import { downloadNodes } from './download.js';
import { collectPersistenceNative } from './adapter/persistence-native.js';
import { createAdvancedHandlers } from './adapter/advanced.js';
import {controlQueue} from './generation-queue.js';

export const serviceMethods = ['diagnose', 'inspect', 'edit', 'view', 'importAsset', 'generationCapabilities', 'promptReferences', 'promptSet', 'generationPrepare', 'generationSubmit', 'generationStatus', 'generationHistory', 'libraryManage', 'assetDownload', 'historyRestore', 'imageTools','canvasManage','elements','generationControl','history', 'save', 'screenshot'] as const;
export type ServiceMethod = typeof serviceMethods[number];
export type CanvasService = Pick<TapnowService, ServiceMethod | 'close'>;

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function safeData(value: any) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TapnowError('INVALID_ARGUMENT', '参数包含不允许的属性名称。');
    safeData(value[key]);
  }
}
function mediaUrl(value: string) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new TapnowError('INVALID_ASSET_URL', '素材 URL 必须为不带凭据的 HTTP(S) 地址。');
  return u.href;
}

export class TapnowService {
  readonly cdp: CdpConnection;
  readonly stateDir: string;
  readonly journal: RequestJournal;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly savePolicy: 'native' | 'disabled';
  private readonly runtimeFingerprint: string;

  constructor(options: { endpoint?: string; stateDir?: string; mode?: 'desktop' | 'web'; targetId?: string; savePolicy?: 'native' | 'disabled' } = {}) {
    const savePolicy = options.savePolicy ?? process.env.TAPNOW_SAVE_POLICY ?? 'native';
    if (!['native', 'disabled'].includes(savePolicy)) throw new TapnowError('INVALID_ARGUMENT', 'TAPNOW_SAVE_POLICY 必须为 native 或 disabled。');
    this.savePolicy = savePolicy as 'native' | 'disabled';
    this.runtimeFingerprint = digest([discoverNativeModules.toString(), discoverMentionNative.toString(), installRuntime.toString(), createAdvancedHandlers.toString(), collectScopedNative.toString(), isScopedNativeFunction.toString(), collectPersistenceNative.toString(), this.savePolicy]);
    this.cdp = new CdpConnection(options.endpoint, options);
    this.stateDir = options.stateDir ?? process.env.TAPNOW_STATE_DIR ?? fileURLToPath(new URL('../.tapnow-mcp/', import.meta.url));
    this.journal = new RequestJournal(join(this.stateDir, 'requests'), this.cdp.endpoint);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.closed) throw new TapnowError('SERVICE_CLOSED', '服务已关闭。');
      return fn();
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private async ready() {
    await this.cdp.connect();
    const moduleSignature = `JSON.stringify([...new Set([...document.scripts].map(s=>s.src).concat([...document.querySelectorAll('link[rel="modulepreload"]')].map(l=>l.href)))].filter(u=>/\\/assets\\/(?:index|main|UnlimitedModeToggle|course-api-base-url|group|vendor-pkg-canvas|vendor-packages)-[^/]+\\.js$/.test(u)).sort())`;
    const same = await this.cdp.evaluate(`globalThis.__tapnowCanvasMcp?.fingerprint === ${JSON.stringify(this.runtimeFingerprint)} && globalThis.__tapnowCanvasMcp?.moduleSignature === ${moduleSignature}`);
    if (!same) {
      await collectScopedNative(this.cdp);
      try {
        await collectPersistenceNative(this.cdp);
        await this.cdp.evaluate(`(async()=>{ const __name=(value)=>value; const native=await (${discoverNativeModules.toString()})(); native.savePolicy=${JSON.stringify(this.savePolicy)}; try { native.mentions=await (${discoverMentionNative.toString()})(native.moduleUrls); } catch(e) { native.mentionError={code:e.code??'UNSUPPORTED_VERSION',message:e.message}; } delete globalThis.__tapnowCanvasMcp; (${installRuntime.toString()})(native,(${createAdvancedHandlers.toString()})); globalThis.__tapnowCanvasMcp.fingerprint=${JSON.stringify(this.runtimeFingerprint)}; globalThis.__tapnowCanvasMcp.moduleSignature=${moduleSignature}; return true; })()`);
      } finally { await this.cdp.evaluate('delete globalThis.__tapnowCanvasMcpScopedNative; delete globalThis.__tapnowCanvasMcpPersistence').catch(() => {}); }
    }
  }
  private async invoke(action: string, args: any = {}, timeout = 20000): Promise<any> {
    const result = await this.cdp.evaluate(`globalThis.__tapnowCanvasMcp.dispatch(${JSON.stringify(action)},${JSON.stringify(args)})`, timeout);
    if (!result || result.ok !== true) throw new TapnowError(result?.error?.code ?? 'ADAPTER_ERROR', result?.error?.message ?? '画布适配层没有返回有效结果。', result?.error?.details);
    return result;
  }
  private validate(args: any) {
    safeData(args);
    if (args.canvasId !== undefined && !/^[0-9a-f-]{36}$/i.test(args.canvasId)) throw new TapnowError('INVALID_ARGUMENT', 'canvasId 必须来自画布读取结果。');
    if (args.requestId !== undefined && (typeof args.requestId !== 'string' || args.requestId.length < 8 || args.requestId.length > 128)) throw new TapnowError('INVALID_ARGUMENT', 'requestId 长度必须为 8–128。');
  }
  /** The same directory is shared by local clients to serialize edits across MCP processes. */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.stateDir, { recursive: true });
    const lock = join(this.stateDir, 'connection-' + digest(this.cdp.endpoint).slice(0, 16) + '.lock');
    const release = async () => {
      await unlink(join(lock, 'owner.json')).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
      // Never recursively remove a configured directory or an unexpected file.
      await rmdir(lock).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
    };
    const start = Date.now();
    for (;;) {
      try {
        await mkdir(lock);
        await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
        break;
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        let alive = true;
        try {
          const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
          try { process.kill(owner.pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; }
        } catch { const info = await stat(lock).catch(() => null); if (info && Date.now() - info.mtimeMs > 120000) alive = false; }
        if (!alive) { await release(); continue; }
        if (Date.now() - start > 20000) throw new TapnowError('BUSY', '另一个本机客户端正在操作 Tapnow，请稍后重试。');
        await pause(100);
      }
    }
    try { return await fn(); }
    finally { await release(); }
  }
  private read(action: string, args: any = {}) {
    this.validate(args);
    return this.serial(async () => { await this.ready(); return this.invoke(action, args); });
  }
  private write(action: string, args: any, timeout = 20000) {
    this.validate(args);
    return this.serial(() => this.locked(async () => {
      await this.ready();
      await this.invoke('guard', args);
      const execute = () => this.invoke(action, args, timeout);
      return args.requestId ? this.journal.run(action, args, execute) : execute();
    }));
  }
  diagnose() { return this.read('diagnose'); }
  inspect(args: { includeData?: boolean; nodeIds?: string[] } = {}) { return this.read('inspect', args); }
  edit(args: { canvasId: string; requestId: string; operations: any[] }) {
    if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 100) throw new TapnowError('INVALID_ARGUMENT', '一次批量编辑需要 1–100 个操作。');
    for (const op of args.operations) if (op.data?.src) mediaUrl(op.data.src);
    return this.write('edit', args, 60000);
  }
  view(args: { canvasId: string; action: 'fit' | 'focus' | 'set'; nodeIds?: string[]; viewport?: { x: number; y: number; zoom: number } }) {
    if (args.action === 'set' && !args.viewport || args.action === 'focus' && !args.nodeIds?.length) throw new TapnowError('INVALID_ARGUMENT', 'set 需要 viewport；focus 需要 nodeIds。');
    return this.write('view', args);
  }
  async importAsset(args: { canvasId: string; requestId: string; path?: string; url?: string; kind?: 'image' | 'video' | 'audio'; position?: { x: number; y: number } }) {
    this.validate(args);
    if (!!args.path === !!args.url) throw new TapnowError('INVALID_ARGUMENT', 'path 与 url 必须且只能提供一个。');
    if (args.url) mediaUrl(args.url);
    const extension = extname(args.path ?? new URL(args.url!).pathname).toLowerCase();
    const mimeType = MIME[extension];
    const kind = args.kind ?? mimeType?.split('/')[0];
    if (!['image', 'video', 'audio'].includes(kind ?? '')) throw new TapnowError('UNSUPPORTED_MEDIA', '无法识别素材类型，请指定 image、video 或 audio。');
    if (args.path && !isAbsolute(args.path)) throw new TapnowError('INVALID_ARGUMENT', '本地素材必须使用绝对路径。');
    return this.serial(() => this.locked(async () => {
      await this.ready(); await this.invoke('guard', args);
      // Fingerprint local content so changing a file cannot reuse an old upload request.
      let file: any;
      if (args.path) {
        const info = await stat(args.path);
        const limit = (kind === 'video' ? 500 : 50) * 1024 * 1024;
        if (!info.isFile() || info.size > limit) throw new TapnowError('FILE_TOO_LARGE', `本地视频最大 500 MiB，其他媒体最大 50 MiB；应用自身限制仍适用。`);
        if (!mimeType || !mimeType.startsWith(kind! + '/')) throw new TapnowError('UNSUPPORTED_MEDIA', '本地文件扩展名与指定媒体类型不匹配。');
        if (info.size > 50 * 1024 * 1024) return this.importLargeVideo({ ...args, kind }, mimeType);
        const bytes = await readFile(args.path);
        if (bytes.length > 50 * 1024 * 1024) throw new TapnowError('FILE_TOO_LARGE', '文件读取期间增长，已停止上传。');
        file = { name: basename(args.path), mimeType, base64: bytes.toString('base64') };
      }
      const payload = { ...args, kind, ...(file ? { file } : {}), ...(args.url ? { url: mediaUrl(args.url) } : {}) };
      return this.journal.run('importAsset', { ...args, kind, ...(file ? { fileHash: digest(file.base64) } : {}) }, () => this.invoke('importAsset', payload, 120000));
    }));
  }
  /** Transfer large videos in bounded CDP messages, then use the native uploader once. */
  private async importLargeVideo(args: any, mimeType: string) {
    const handle = await open(args.path, 'r');
    const limit = 500 * 1024 * 1024, chunkSize = 2 * 1024 * 1024;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) throw new TapnowError('FILE_TOO_LARGE', '本地视频最大 500 MiB。');
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, highWaterMark: chunkSize })) {
        size += chunk.length;
        if (size > limit) throw new TapnowError('FILE_TOO_LARGE', '文件读取期间增长，已停止上传。');
        hash.update(chunk);
      }
      if (size !== info.size) throw new TapnowError('FILE_CHANGED', '文件读取期间发生变化，请待文件稳定后重试。');
      const fileHash = hash.digest('hex');
      return await this.journal.run('importAsset', { ...args, fileHash: 'sha256:' + fileHash }, async () => {
        const transferId = randomUUID();
        try {
          await this.invoke('importFileBegin', { canvasId: args.canvasId, transferId, size, name: basename(args.path), mimeType });
          const sentHash = createHash('sha256'); let offset = 0;
          for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, highWaterMark: chunkSize })) {
            if (offset + chunk.length > size) throw new TapnowError('FILE_CHANGED', '文件传输期间发生变化，已停止上传。');
            sentHash.update(chunk);
            await this.invoke('importFileChunk', { canvasId: args.canvasId, transferId, offset, base64: chunk.toString('base64') });
            offset += chunk.length;
          }
          if (offset !== size || sentHash.digest('hex') !== fileHash) throw new TapnowError('FILE_CHANGED', '文件传输期间发生变化，已停止上传。');
          return await this.invoke('importAsset', { ...args, file: { transferId } }, 600000);
        } finally {
          await this.invoke('importFileAbort', { canvasId: args.canvasId, transferId }).catch(() => {});
        }
      });
    } finally { await handle.close(); }
  }
  generationCapabilities() { return this.read('capabilities'); }
  historyRestore(args:any){return this.write('historyRestore',args,60000);}
  imageTools(args:any){return args.phase==='inspect'?this.read('imageTools',args):this.write('imageTools',args,600000);}
  elements(args:any){return this.read('elements',args);}
  async generationControl(args:any):Promise<any>{
    if(['list','progress'].includes(args.action))return this.read('taskControl',args);
    if(['cancel','retry_prepare'].includes(args.action))return this.write('taskControl',args,60000);
    if(args.action==='retry'){
      if(args.allowPaid!==true)throw new TapnowError('PAID_AUTHORIZATION_REQUIRED','重试生成必须先获得明确授权。');
      this.validate(args);
      return this.serial(()=>this.locked(async()=>{await this.ready();return this.journal.run('generationRetry',args,async()=>{await this.invoke('taskControl',{...args,action:'retry_prepare'});return this.invoke('submitGeneration',args,30000);});}));
    }
    this.validate(args);
    return this.serial(()=>this.locked(async()=>{await this.ready();await this.invoke('guard',args);
      const inspect=async(nodeId:string)=>{const snapshot=await this.invoke('inspect',{nodeIds:[nodeId],includeData:true});await this.invoke('guard',args);return snapshot.nodes.find((n:any)=>n.id===nodeId)??(()=>{throw new TapnowError('NODE_NOT_FOUND','队列节点已不存在。')})();};
      const execute=()=>controlQueue(args,join(this.stateDir,'queues'),{inspect,prepare:nodeId=>this.invoke('prepareGeneration',{canvasId:args.canvasId,nodeId}),submit:(nodeId,requestId)=>{const parameters={canvasId:args.canvasId,nodeId,requestId};return this.journal.run('submitGeneration',parameters,()=>this.invoke('submitGeneration',parameters,30000));},status:nodeId=>this.invoke('generationStatus',{canvasId:args.canvasId,nodeId}),cancel:nodeId=>this.invoke('taskControl',{canvasId:args.canvasId,nodeId,action:'cancel'})});
      return args.action==='queue_status'?execute():this.journal.run('generationControl',args,execute);
    }));
  }
  private async openCanvas(destinationCanvasId:string,sourceCanvasId:string){
    await this.invoke('guard',{canvasId:sourceCanvasId});
    const destination=await this.invoke('canvasGet',{destinationCanvasId});
    if((destination.canvas?.id??destination.id)!==destinationCanvasId)throw new TapnowError('CANVAS_NOT_FOUND','目标画布不存在或无法读取。');
    const saved=await this.invoke('save',{canvasId:sourceCanvasId});
    if(saved.persistence?.confirmed!==true)throw new TapnowError('SAVE_NOT_CONFIRMED','源画布未确认保存，停止切换。');
    const current=await this.cdp.evaluate('location.href');const origin=new URL(current);
    const url=origin.protocol==='tapnow:'?'tapnow://app/canvas/'+destinationCanvasId:origin.origin+'/canvas/'+destinationCanvasId;
    await this.cdp.send('Page.navigate',{url});
    const started=Date.now();let last:any;
    while(Date.now()-started<20000){try{await this.ready();const state=await this.invoke('inspect',{includeData:false});if(state.canvasId===destinationCanvasId)return state;}catch(e){last=e;}await pause(200);}
    throw new TapnowError('CANVAS_OPEN_TIMEOUT','目标画布加载未确认，请先读取当前状态。',{cause:last?.code});
  }
  canvasManage(args:any):Promise<any>{
    if(args.action==='list')return this.read('canvasList',args);
    if(args.action==='create')return this.write('canvasCreate',args,60000);
    this.validate(args);
    if(!/^[0-9a-f-]{36}$/i.test(args.destinationCanvasId??''))throw new TapnowError('INVALID_ARGUMENT','目标画布 ID 必须来自查询或创建结果。');
    return this.serial(()=>this.locked(async()=>{await this.ready();
      const execute=async()=>{
        await this.invoke('guard',{canvasId:args.canvasId});
        if(args.action==='open')return this.openCanvas(args.destinationCanvasId,args.canvasId);
        if(args.action!=='copy_nodes')throw new TapnowError('INVALID_ARGUMENT','未知跨画布动作。');
        const source=await this.invoke('inspect',{includeData:true});await this.invoke('guard',{canvasId:args.canvasId});
        const selected=new Set<string>(args.nodeIds),byId=new Map<string,any>(source.nodes.map((n:any)=>[n.id,n]));
        for(const id of selected)if(!byId.has(id))throw new TapnowError('NODE_NOT_FOUND','复制来源节点不存在。',{nodeId:id});
        for(let count=0;count<source.nodes.length;count++){let added=false;for(const n of source.nodes)if(n.parentId&&selected.has(n.parentId)&&!selected.has(n.id)){selected.add(n.id);added=true;}if(!added)break;}
        if(!selected.size||selected.size>100)throw new TapnowError('INVALID_ARGUMENT','复制（含分组后代）需要 1–100 个节点。');
        const absolute=(n:any,seen=new Set<string>()):any=>{if(seen.has(n.id))throw new TapnowError('INVALID_GROUP','来源分组存在循环。');seen.add(n.id);const parent=byId.get(n.parentId);if(!parent)return n.position;const p=absolute(parent,seen);return {x:p.x+n.position.x,y:p.y+n.position.y};};
        const copied=[...selected].map(id=>{const n=byId.get(id);if(!['text','image','video','audio','group'].includes(n.type)||['pending','running','processing'].includes(n.data?.taskInfo?.status))throw new TapnowError('UNSUPPORTED_NODE','只能复制支持且未在生成中的节点。');const position=absolute(n);return {...n,position:n.parentId&&selected.has(n.parentId)?n.position:position};});
        await this.openCanvas(args.destinationCanvasId,args.canvasId);
        return this.invoke('pasteNodes',{canvasId:args.destinationCanvasId,nodes:copied,edges:source.edges,position:args.position},60000);
      };
      return args.requestId?this.journal.run('canvasManage',args,execute):execute();
    }));
  }
  generationHistory(args: {canvasId:string;nodeId:string;limit?:number}) { return this.read('generationHistory',args); }
  libraryManage(args: {canvasId:string;action:'folders'|'create_folder'|'rename_asset'|'move_asset'|'save_nodes';requestId?:string;space?:'personal'|'team';parentId?:string;folderId?:string;assetId?:string;name?:string;nodeIds?:string[]}) {
    if(args.action==='folders') return this.read('libraryManage',args);
    if(!args.requestId) throw new TapnowError('INVALID_ARGUMENT','修改素材库必须提供 requestId。');
    return this.write('libraryManage',args,60000);
  }
  assetDownload(args: {canvasId:string;nodeIds:string[];directory:string;requestId:string}) {
    this.validate(args);
    if(!isAbsolute(args.directory) || !Array.isArray(args.nodeIds) || !args.nodeIds.length || args.nodeIds.length>100) throw new TapnowError('INVALID_ARGUMENT','请提供绝对下载目录及 1–100 个节点。');
    return this.serial(()=>this.locked(async()=>{
      await this.ready();await this.invoke('guard',args);
      const snapshot=await this.invoke('inspect',{nodeIds:args.nodeIds,includeData:true});
      if(snapshot.canvasId!==args.canvasId) throw new TapnowError('CANVAS_CHANGED','读取下载来源时画布已切换。');
      const selected=[...new Set(args.nodeIds)].map(id=>snapshot.nodes.find((n:any)=>n.id===id)??(()=>{throw new TapnowError('NODE_NOT_FOUND','节点已不存在。',{nodeId:id});})());
      return this.journal.run('assetDownload',{...args,sourceHash:digest(selected.map(n=>({id:n.id,type:n.type,data:n.data})))},()=>downloadNodes(selected,args.directory));
    }));
  }
  promptReferences(args: { canvasId: string; nodeId?: string; source?: 'canvas' | 'library'; query?: string; limit?: number; offset?: number }) {
    return this.read('promptReferences', args);
  }
  promptSet(args: { canvasId: string; nodeId: string; requestId: string; segments: Array<{ type: 'text'; text: string } | { type: 'reference'; source: 'canvas'; nodeId: string } | { type: 'reference'; source: 'library'; assetId: string }|{type:'reference';source:'element';elementId:string}> }) {
    return this.write('promptSet', args, 30000);
  }
  generationPrepare(args: { canvasId: string; nodeId: string }) { return this.write('prepareGeneration', args); }
  generationSubmit(args: { canvasId: string; nodeId: string; requestId: string }) { return this.write('submitGeneration', args, 30000); }
  async generationStatus(args: { canvasId: string; nodeId: string; requestId?: string }) {
    return this.serial(async () => {
      this.validate(args); await this.ready();
      const result = await this.invoke('generationStatus', args);
      if (args.requestId) {
        const record = await this.journal.lookup(args.canvasId, args.requestId);
        result.request = record ? { state: record.state, action: record.action, createdAt: record.createdAt, completedAt: record.completedAt, result: record.result } : null;
      }
      return result;
    });
  }
  history(args: { canvasId: string; action: 'undo' | 'redo' }) {
    return this.write('history', args);
  }
  save(args: { canvasId: string }) { return this.write('save', args); }
  screenshot(args: { canvasId: string }) {
    this.validate(args);
    return this.serial(async () => {
      await this.ready(); await this.invoke('guard', args);
      const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await this.invoke('guard', args);
      return { ok: true, canvasId: args.canvasId, data: shot.data as string, mimeType: 'image/png' };
    });
  }
  async close() { await this.tail; this.closed = true; this.cdp.close(); }
}
