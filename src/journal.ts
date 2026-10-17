import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { TapnowError } from './errors.js';

function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export const digest = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');

/** Persist the intent before touching Tapnow; an unknown outcome is never retried automatically. */
export class RequestJournal {
  constructor(readonly directory: string, readonly endpoint: string) {}
  private path(canvasId: string, requestId: string) { return join(this.directory, digest([this.endpoint, canvasId, requestId]) + '.json'); }
  async lookup(canvasId: string, requestId: string) {
    try { return JSON.parse(await readFile(this.path(canvasId, requestId), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return null; throw new TapnowError('JOURNAL_ERROR', '无法读取请求记录，已停止写操作。'); }
  }
  async run(action: string, args: any, execute: () => Promise<any>) {
    await mkdir(this.directory, { recursive: true });
    const fingerprint = digest({ action, args });
    const existing = await this.lookup(args.canvasId, args.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new TapnowError('REQUEST_ID_CONFLICT', '同一 requestId 已用于不同的参数，请检查调用记录。');
      if (existing.state === 'done') return { ...existing.result, replayed: true };
      throw new TapnowError('REQUEST_OUTCOME_UNKNOWN', '该请求已开始执行，但没有完整结果。为避免重复操作，不会自动再次执行；请先读取画布或查询生成状态。', { requestId: args.requestId, action: existing.action, nodeId: existing.nodeId });
    }
    const path = this.path(args.canvasId, args.requestId);
    const pending = { action, fingerprint, canvasId: args.canvasId, requestId: args.requestId, nodeId: args.nodeId, state: 'pending', createdAt: new Date().toISOString() };
    try { await writeFile(path, JSON.stringify(pending), { flag: 'wx', mode: 0o600 }); }
    catch (e: any) { if (e.code === 'EEXIST') throw new TapnowError('REQUEST_IN_PROGRESS', '该请求正在另一个客户端执行。'); throw new TapnowError('JOURNAL_ERROR', '无法记录请求，已停止写操作。'); }
    const result = await execute();
    const temporary = path + '.' + process.pid + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ ...pending, state: 'done', completedAt: new Date().toISOString(), result }), { mode: 0o600 });
      await rename(temporary, path);
    } catch { throw new TapnowError('JOURNAL_ERROR', '操作可能已执行，但记录完成状态失败。请先检查实际画布，不要重新提交。', { requestId: args.requestId }); }
    return result;
  }
}
