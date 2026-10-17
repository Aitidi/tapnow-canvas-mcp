import WebSocket from 'ws';
import { TapnowError } from './errors.js';

export interface Target { id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }

export class CdpConnection {
  private socket?: WebSocket;
  private targetId?: string;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly endpoint: string;

  constructor(endpoint = process.env.TAPNOW_CDP_URL ?? 'http://127.0.0.1:9222') {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') {
      throw new TapnowError('INVALID_ENDPOINT', '调试端点必须是本机 HTTP 地址，例如 http://127.0.0.1:9222。');
    }
    this.endpoint = url.origin;
  }

  async targets(): Promise<Target[]> {
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
      throw new TapnowError('NOT_CONNECTED', '无法连接 Tapnow。本机调试端口尚未开启，或应用已退出。请运行启动脚本。', { endpoint: this.endpoint });
    }
  }

  async connect() {
    const candidates = (await this.targets()).filter(t => t.type === 'page' && /^tapnow:\/\/app(?:\/|$)/.test(t.url));
    if (candidates.length !== 1) throw new TapnowError(candidates.length ? 'AMBIGUOUS_WINDOW' : 'APP_PAGE_NOT_FOUND', '需要恰好一个 Tapnow 主窗口。', { candidates: candidates.map(({ id, title, url }) => ({ id, title, url })) });
    const target = candidates[0];
    if (this.targetId === target.id && this.socket?.readyState === WebSocket.OPEN) return target;
    this.close();
    const wsUrl = new URL(target.webSocketDebuggerUrl);
    if (wsUrl.protocol !== 'ws:' || wsUrl.username || wsUrl.password || !['127.0.0.1', '[::1]', 'localhost'].includes(wsUrl.hostname) || wsUrl.port !== new URL(this.endpoint).port) {
      throw new TapnowError('INVALID_TARGET', '拒绝连接非本机调试 WebSocket。');
    }
    const socket = new WebSocket(wsUrl);
    this.socket = socket;
    socket.on('message', raw => {
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1002, 'Invalid JSON'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1002, 'Invalid message'); return; }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new TapnowError('CDP_ERROR', message.error.message));
      else entry.resolve(message.result);
    });
    const disconnected = () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new TapnowError('CONNECTION_LOST', 'Tapnow 连接中断；写操作结果可能未知，请先重新读取画布，不要盲目重试。'));
      }
      this.pending.clear();
      if (this.socket === socket) { this.socket = undefined; this.targetId = undefined; }
    };
    socket.on('close', disconnected);
    socket.on('error', disconnected);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new TapnowError('CONNECT_TIMEOUT', '连接 Tapnow 调试接口超时。')); }, 5000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', e => { clearTimeout(timer); reject(e); });
    });
    this.targetId = target.id;
    return target;
  }

  async send(method: string, params: Record<string, unknown> = {}, timeout = 15000): Promise<any> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new TapnowError('NOT_CONNECTED', '尚未连接 Tapnow。');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TapnowError('OPERATION_TIMEOUT', '操作超时，执行结果可能未知。请先查询画布或任务状态，再决定是否重试。', { method }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
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
    socket?.close();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new TapnowError('CONNECTION_LOST', '连接已关闭。')); }
    this.pending.clear();
  }
}
