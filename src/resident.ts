import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CdpConnection } from './cdp.js';
import { TapnowError } from './errors.js';
import { digest } from './journal.js';
import { serviceMethods, type CanvasService, type ServiceMethod } from './service.js';

export const residentProtocol = 1;
export interface ResidentRecord { protocol: number; pid: number; pipe: string; token: string; startedAt: string }
export interface ResidentConfig { id: string; directory: string; recordPath: string; logPath: string; pipe: string; stateDir: string }

export function residentConfig(): ResidentConfig {
  const endpoint = new CdpConnection().endpoint;
  const stateDir = resolve(process.env.TAPNOW_STATE_DIR ?? fileURLToPath(new URL('../.tapnow-mcp/', import.meta.url)));
  const id = digest([homedir(), stateDir, endpoint, process.env.TAPNOW_TARGET ?? 'desktop', process.env.TAPNOW_TARGET_ID ?? '', process.env.TAPNOW_CHROME_USER_DATA_DIR ?? '']).slice(0, 24);
  const directory = join(stateDir, 'resident');
  return { id, directory, stateDir, recordPath: join(directory, id + '.json'), logPath: join(directory, id + '.log'),
    pipe: process.platform === 'win32' ? '\\\\.\\pipe\\tapnow-canvas-' + id : join(tmpdir(), 'tapnow-canvas-' + id + '.sock') };
}

export async function readResidentRecord(config = residentConfig()): Promise<ResidentRecord | null> {
  let record: ResidentRecord;
  try { record = JSON.parse(await readFile(config.recordPath, 'utf8')); }
  catch (e: any) { if (e.code === 'ENOENT') return null; throw new TapnowError('RESIDENT_RECORD_INVALID', '常驻服务记录损坏，已停止连接。'); }
  if (record.protocol !== residentProtocol || record.pipe !== config.pipe || !Number.isInteger(record.pid) || record.pid <= 0 || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new TapnowError('RESIDENT_RECORD_INVALID', '常驻服务记录与当前配置不匹配。');
  }
  return record;
}

/** One authenticated request per local pipe; never retry an interrupted operation. */
export async function residentRequest(record: ResidentRecord, method: string, args: unknown = {}, timeout = 660000): Promise<any> {
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(record.pipe);
    let buffer = '', settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolveResult(value);
    };
    const timer = setTimeout(() => finish(new TapnowError('RESIDENT_TIMEOUT', '常驻服务调用超时，结果可能未知；请先读取画布，不要重复写入。')), timeout);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ token: record.token, method, args }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024 * 1024) return finish(new TapnowError('RESIDENT_PROTOCOL_ERROR', '常驻服务响应超过限制。'));
      const end = buffer.indexOf('\n'); if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response?.ok === true) finish(undefined, response.result);
        else finish(new TapnowError(response?.error?.code ?? 'RESIDENT_PROTOCOL_ERROR', response?.error?.message ?? '无效常驻服务响应。', response?.error?.details));
      } catch (e) { finish(new TapnowError('RESIDENT_PROTOCOL_ERROR', '无法解析常驻服务响应。')); }
    });
    socket.once('error', (e: any) => finish(new TapnowError(['ENOENT', 'ECONNREFUSED'].includes(e.code) ? 'RESIDENT_NOT_RUNNING' : 'RESIDENT_CONNECTION_LOST', '无法连接常驻服务；不会自动重放本次操作。')));
    socket.once('close', () => { if (!settled) finish(new TapnowError('RESIDENT_CONNECTION_LOST', '常驻服务连接中断，写入结果可能未知；请先检查画布。')); });
  });
}

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== 'ESRCH'; } }
const unavailable = (e: any) => ['RESIDENT_NOT_RUNNING', 'RESIDENT_CONNECTION_LOST', 'RESIDENT_TIMEOUT'].includes(e.code);

export async function residentStatus(config = residentConfig()) {
  const record = await readResidentRecord(config);
  if (!record) return { running: false, connected: false };
  try { return await residentRequest(record, 'status', {}, 2000); }
  catch (e) { if (!unavailable(e)) throw e; return { running: false, connected: false }; }
}

export async function ensureResident(config = residentConfig()): Promise<ResidentRecord> {
  const previous = await readResidentRecord(config);
  if (previous) {
    try { await residentRequest(previous, 'ping', {}, 1000); return previous; }
    catch (e) { if (!unavailable(e)) throw e; }
    if (alive(previous.pid)) throw new TapnowError('RESIDENT_UNRESPONSIVE', '已有常驻进程但无法响应，请检查后台日志，勿重复启动。');
    if (process.platform !== 'win32') await unlink(config.pipe).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
  }
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const log = openSync(config.logPath, 'a', 0o600);
  let spawnError: Error | undefined;
  try {
    const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './resident-worker.ts' : './resident-worker.js', import.meta.url));
    const child = spawn(process.execPath, [...import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [], worker], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), detached: true, windowsHide: true,
      env: { ...process.env, TAPNOW_STATE_DIR: config.stateDir }, stdio: ['ignore', log, log],
    });
    child.once('error', e => { spawnError = e; }); child.unref();
  } finally { closeSync(log); }
  // Concurrent starts compete for a single OS pipe. Only the listener writes
  // its record, and no worker connects to Chrome before receiving a tool call.
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (spawnError) throw new TapnowError('RESIDENT_START_FAILED', spawnError.message);
    const record = await readResidentRecord(config);
    if (record) {
      try { await residentRequest(record, 'ping', {}, 500); return record; }
      catch (e) { if (!unavailable(e)) throw e; }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new TapnowError('RESIDENT_START_FAILED', '常驻服务启动失败，请查看 ' + config.logPath);
}

export async function stopResident(config = residentConfig()) {
  const record = await readResidentRecord(config);
  if (!record) return { running: false, stopped: false };
  try {
    await residentRequest(record, 'shutdown');
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const current = await readResidentRecord(config);
      if (!current || current.token !== record.token) return { running: false, stopped: true };
      await new Promise(r => setTimeout(r, 50));
    }
    throw new TapnowError('RESIDENT_STOP_PENDING', '常驻服务正在结束，请稍后查询状态。');
  } catch (e) { if (!unavailable(e)) throw e; return { running: false, stopped: false }; }
}

export function createResidentService(): CanvasService {
  const service: any = { close: async () => {} };
  for (const method of serviceMethods) service[method] = async (args?: unknown) => {
    const record = await ensureResident();
    return residentRequest(record, method satisfies ServiceMethod, args ?? {});
  };
  return service as CanvasService;
}

export function newResidentRecord(config: ResidentConfig): ResidentRecord {
  return { protocol: residentProtocol, pid: process.pid, pipe: config.pipe, token: randomBytes(32).toString('hex'), startedAt: new Date().toISOString() };
}
