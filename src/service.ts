import { mkdir, readFile, stat, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpConnection } from './cdp.js';
import { TapnowError } from './errors.js';
import { RequestJournal, digest } from './journal.js';
import { discoverNativeModules } from './adapter/discovery.js';
import { installRuntime } from './adapter/runtime.js';
import { discoverMentionNative } from './adapter/mention-discovery.js';

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
  private readonly runtimeFingerprint = digest([discoverNativeModules.toString(), discoverMentionNative.toString(), installRuntime.toString()]);

  constructor(options: { endpoint?: string; stateDir?: string } = {}) {
    this.cdp = new CdpConnection(options.endpoint);
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
    const moduleSignature = `JSON.stringify([...new Set([...document.scripts].map(s=>s.src).concat([...document.querySelectorAll('link[rel="modulepreload"]')].map(l=>l.href)))].filter(u=>/\\/assets\\/(?:index|UnlimitedModeToggle|course-api-base-url|group)-[^/]+\\.js$/.test(u)).sort())`;
    const same = await this.cdp.evaluate(`globalThis.__tapnowCanvasMcp?.fingerprint === ${JSON.stringify(this.runtimeFingerprint)} && globalThis.__tapnowCanvasMcp?.moduleSignature === ${moduleSignature}`);
    if (!same) {
      await this.cdp.evaluate(`(async()=>{ const __name=(value)=>value; const native=await (${discoverNativeModules.toString()})(); try { native.mentions=await (${discoverMentionNative.toString()})(); } catch(e) { native.mentionError={code:e.code??'UNSUPPORTED_VERSION',message:e.message}; } delete globalThis.__tapnowCanvasMcp; (${installRuntime.toString()})(native); globalThis.__tapnowCanvasMcp.fingerprint=${JSON.stringify(this.runtimeFingerprint)}; globalThis.__tapnowCanvasMcp.moduleSignature=${moduleSignature}; return true; })()`);
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
        if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new TapnowError('FILE_TOO_LARGE', '首版支持不超过 50 MiB 的普通媒体文件。');
        if (!mimeType || !mimeType.startsWith(kind! + '/')) throw new TapnowError('UNSUPPORTED_MEDIA', '本地文件扩展名与指定媒体类型不匹配。');
        const bytes = await readFile(args.path);
        if (bytes.length > 50 * 1024 * 1024) throw new TapnowError('FILE_TOO_LARGE', '文件读取期间增长，已停止上传。');
        file = { name: basename(args.path), mimeType, base64: bytes.toString('base64') };
      }
      const payload = { ...args, kind, ...(file ? { file } : {}), ...(args.url ? { url: mediaUrl(args.url) } : {}) };
      return this.journal.run('importAsset', { ...args, kind, ...(file ? { fileHash: digest(file.base64) } : {}) }, () => this.invoke('importAsset', payload, 120000));
    }));
  }
  generationCapabilities() { return this.read('capabilities'); }
  promptReferences(args: { canvasId: string; nodeId?: string; source?: 'canvas' | 'library'; query?: string; limit?: number; offset?: number }) {
    return this.read('promptReferences', args);
  }
  promptSet(args: { canvasId: string; nodeId: string; requestId: string; segments: Array<{ type: 'text'; text: string } | { type: 'reference'; source: 'canvas'; nodeId: string } | { type: 'reference'; source: 'library'; assetId: string }> }) {
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
