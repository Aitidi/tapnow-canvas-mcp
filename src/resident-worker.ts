import { createServer, type Socket } from 'node:net';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { TapnowService, serviceMethods } from './service.js';
import { errorResult, TapnowError } from './errors.js';
import { newResidentRecord, readResidentRecord, residentConfig, type ResidentConfig } from './resident.js';

export async function startResidentWorker(config: ResidentConfig = residentConfig(), service: any = new TapnowService()) {
  const record = newResidentRecord(config);
  let closing = false;
  const allowed = new Set<string>(serviceMethods);
  const sockets = new Set<Socket>();
  const shutdown = async () => {
    if (closing) return; closing = true;
    server.close();
    await service.close();
    const current = await readResidentRecord(config);
    if (current?.token === record.token) await unlink(config.recordPath);
  };
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); socket.setTimeout(10000, () => socket.destroy());
    let buffer = '', handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { handled = true; socket.end(JSON.stringify(errorResult(new TapnowError('INVALID_ARGUMENT', '本机请求超过大小限制。'))) + '\n'); return; }
      const end = buffer.indexOf('\n'); if (end < 0) return;
      handled = true; socket.setTimeout(0);
      try {
        const request = JSON.parse(buffer.slice(0, end));
        const token = request?.token;
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(record.token))) throw new TapnowError('RESIDENT_UNAUTHORIZED', '本机常驻服务认证失败。');
        let result: any;
        if (request.method === 'ping' || request.method === 'status') result = { running: !closing, pid: record.pid, startedAt: record.startedAt, protocol: record.protocol, ...service.cdp.status };
        else if (request.method === 'shutdown') { await shutdown(); result = { stopped: true }; }
        else {
          if (closing) throw new TapnowError('SERVICE_CLOSED', '常驻服务正在停止。');
          if (!allowed.has(request.method)) throw new TapnowError('INVALID_ACTION', '不允许调用此常驻服务方法。');
          if (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)) throw new TapnowError('INVALID_ARGUMENT', '本机调用参数必须是对象。');
          result = await service[request.method](request.args);
        }
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (e) { socket.end(JSON.stringify(errorResult(e)) + '\n'); }
    });
  });
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ path: config.pipe, exclusive: true }, resolve); });
  try {
    if (process.platform !== 'win32') await chmod(config.pipe, 0o600);
    const temporary = config.recordPath + '.' + record.pid + '.tmp';
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, config.recordPath);
  } catch (e) { server.close(); await service.close(); throw e; }
  return { record, server, shutdown: async () => { await shutdown(); for (const socket of sockets) socket.destroy(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startResidentWorker().then(worker => {
    process.once('SIGTERM', () => { void worker.shutdown(); });
    process.once('SIGINT', () => { void worker.shutdown(); });
  }).catch(e => {
    if (e.code !== 'EADDRINUSE') process.stderr.write(JSON.stringify(errorResult(e)) + '\n');
    process.exitCode = e.code === 'EADDRINUSE' ? 0 : 1;
  });
}
