import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TapnowError } from './errors.js';

export interface Target { id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }

export function isTapnowTarget(value: string, mode: 'desktop' | 'web') {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return mode === 'desktop' ? url.protocol === 'tapnow:' && url.host === 'app'
      : url.origin === 'https://app.tapnow.ai' && /^\/canvas\/[0-9a-f-]{36}\/?$/i.test(url.pathname);
  } catch { return false; }
}

function localBrowserSocket(endpoint: string) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash ||
    !/^\/devtools\/browser(?:\/[\w-]+)?$/.test(url.pathname)) {
    throw new TapnowError('INVALID_ENDPOINT', '浏览器调试地址必须是本机 ws://127.0.0.1:端口/devtools/browser[/ID]。');
  }
  return url.href;
}

export class CdpConnection {
  private socket?: WebSocket;
  private targetId?: string;
  private sessionId?: string;
  private readonly mode: 'desktop' | 'web';
  private readonly requestedTargetId?: string;
  private readonly browserMode: boolean;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly endpoint: string;

  get status() {
    return { connected: this.socket?.readyState === WebSocket.OPEN && !!this.targetId, targetId: this.targetId ?? null, endpoint: this.endpoint, mode: this.mode };
  }

  constructor(endpoint = process.env.TAPNOW_CDP_URL ?? 'http://127.0.0.1:9222', options: { mode?: 'desktop' | 'web'; targetId?: string } = {}) {
    this.mode = options.mode ?? (process.env.TAPNOW_TARGET ?? 'desktop') as 'desktop' | 'web';
    if (!['desktop', 'web'].includes(this.mode)) throw new TapnowError('INVALID_ARGUMENT', 'TAPNOW_TARGET 必须为 desktop 或 web。');
    this.requestedTargetId = options.targetId ?? process.env.TAPNOW_TARGET_ID;
    this.browserMode = endpoint === 'chrome' || endpoint.startsWith('ws:');
    if (endpoint === 'chrome') { this.endpoint = endpoint; return; }
    if (this.browserMode) { this.endpoint = localBrowserSocket(endpoint); return; }
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new TapnowError('INVALID_ENDPOINT', '调试端点必须是本机 HTTP 地址，例如 http://127.0.0.1:9222。');
    }
    this.endpoint = url.origin;
  }

  async targets(): Promise<Target[]> {
    if (this.browserMode) {
      await this.ensureBrowser();
      const result = await this.sendRaw('Target.getTargets');
      if (!Array.isArray(result.targetInfos) || result.targetInfos.some((t: any) => !t || typeof t.targetId !== 'string' || typeof t.url !== 'string' || typeof t.type !== 'string')) {
        throw new TapnowError('INVALID_TARGET_LIST', '浏览器返回了无效的页面列表。');
      }
      return result.targetInfos.map((t: any) => ({ id: t.targetId, title: t.title ?? '', type: t.type, url: t.url, webSocketDebuggerUrl: '' }));
    }
    try {
      const response = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value: unknown = await response.json();
      if (!Array.isArray(value) || value.some(t => !t || typeof t.id !== 'string' || typeof t.url !== 'string' || typeof t.type !== 'string' || typeof t.webSocketDebuggerUrl !== 'string')) {
        throw new TapnowError('INVALID_TARGET_LIST', '调试接口返回了无效的页面列表。');
      }
      return value as Target[];
    } catch (error) {
      if (error instanceof TapnowError) throw error;
      throw new TapnowError('NOT_CONNECTED', '无法连接本机调试端口。请检查目标应用已打开，并已启用调试连接。', { endpoint: this.endpoint });
    }
  }

  async connect() {
    const candidates = (await this.targets()).filter(t => t.type === 'page' && isTapnowTarget(t.url, this.mode) && (!this.requestedTargetId || t.id === this.requestedTargetId));
    if (candidates.length !== 1) throw new TapnowError(candidates.length ? 'AMBIGUOUS_WINDOW' : 'APP_PAGE_NOT_FOUND', this.mode === 'web' ? '需要恰好一个 Tapnow 网页画布；多个画布时请设置 TAPNOW_TARGET_ID。' : '需要恰好一个 Tapnow 主窗口。', { candidates: candidates.map(({ id, title, url }) => ({ id, title, url })) });
    const target = candidates[0];
    if (this.targetId === target.id && this.socket?.readyState === WebSocket.OPEN) return target;
    if (this.browserMode) {
      const previousSession = this.sessionId;
      this.targetId = undefined;
      this.sessionId = undefined;
      if (previousSession) await this.sendRaw('Target.detachFromTarget', { sessionId: previousSession });
      const attached = await this.sendRaw('Target.attachToTarget', { targetId: target.id, flatten: true });
      if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw new TapnowError('CDP_ERROR', '浏览器未返回画布会话。');
      this.sessionId = attached.sessionId;
      this.targetId = target.id;
      return target;
    }
    this.close();
    const wsUrl = new URL(target.webSocketDebuggerUrl);
    if (wsUrl.protocol !== 'ws:' || wsUrl.username || wsUrl.password || !['127.0.0.1', '[::1]', 'localhost'].includes(wsUrl.hostname) || wsUrl.port !== new URL(this.endpoint).port) {
      throw new TapnowError('INVALID_TARGET', '拒绝连接非本机调试 WebSocket。');
    }
    await this.openSocket(wsUrl.href);
    this.targetId = target.id;
    return target;
  }

  private async ensureBrowser() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    let endpoint = this.endpoint;
    if (endpoint === 'chrome') {
      const directory = process.env.TAPNOW_CHROME_USER_DATA_DIR ?? (process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
        : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
          : join(homedir(), '.config', 'google-chrome'));
      let lines: string[];
      try { lines = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); }
      catch { throw new TapnowError('CHROME_DEBUGGING_DISABLED', '请在 Chrome 的 chrome://inspect/#remote-debugging 启用远程调试，再允许本机连接。MCP 不会自动修改此设置。'); }
      if (!/^\d+$/.test(lines[0]) || Number(lines[0]) < 1 || Number(lines[0]) > 65535 || !lines[1]) throw new TapnowError('INVALID_ENDPOINT', 'Chrome 调试端口文件无效。');
      endpoint = localBrowserSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    }
    await this.openSocket(endpoint);
  }

  private async openSocket(endpoint: string) {
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    socket.on('message', raw => {
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1002, 'Invalid JSON'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1002, 'Invalid message'); return; }
      if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId === this.sessionId) {
        this.close();
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new TapnowError('CDP_ERROR', message.error.message));
      else entry.resolve(message.result);
    });
    const disconnected = () => {
      if (this.socket !== socket) return;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new TapnowError('CONNECTION_LOST', 'Tapnow 连接中断；写操作结果可能未知，请先重新读取画布，不要盲目重试。'));
      }
      this.pending.clear();
      if (this.socket === socket) { this.socket = undefined; this.targetId = undefined; this.sessionId = undefined; }
    };
    socket.on('close', disconnected);
    socket.on('error', disconnected);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new TapnowError('CONNECT_TIMEOUT', '连接调试接口超时；如果 Chrome 显示连接提示，请允许后重试。')); }, this.browserMode ? 45000 : 5000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', e => { clearTimeout(timer); reject(e); });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}, timeout = 15000): Promise<any> {
    if (this.browserMode && !this.sessionId) throw new TapnowError('NOT_CONNECTED', '尚未连接 Tapnow 画布。');
    return this.sendRaw(method, params, timeout, this.sessionId);
  }

  private async sendRaw(method: string, params: Record<string, unknown> = {}, timeout = 15000, sessionId?: string): Promise<any> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new TapnowError('NOT_CONNECTED', '尚未连接 Tapnow。');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TapnowError('OPERATION_TIMEOUT', '操作超时，执行结果可能未知。请先查询画布或任务状态，再决定是否重试。', { method }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate<T = any>(expression: string, timeout = 20000): Promise<T> {
    const reply = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeout);
    if (reply.exceptionDetails) throw new TapnowError('ADAPTER_ERROR', reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result?.value as T;
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    this.targetId = undefined;
    this.sessionId = undefined;
    socket?.close();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new TapnowError('CONNECTION_LOST', '连接已关闭。')); }
    this.pending.clear();
  }
}
