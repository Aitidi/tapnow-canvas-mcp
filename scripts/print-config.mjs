// Generate machine-specific settings without changing any client configuration.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const format = process.argv[2] ?? 'json';
if (!['json', 'codex', 'claude-code'].includes(format)) {
  process.stderr.write('用法：node scripts/print-config.mjs [json|codex|claude-code]\n');
  process.exit(1);
}
const server = fileURLToPath(new URL('../dist/server.js', import.meta.url));
if (!existsSync(server)) {
  process.stderr.write('尚未构建 MCP 服务，请先在项目目录执行 npm ci 和 npm run build。\n');
  process.exit(1);
}
const endpoint = new URL(process.env.TAPNOW_CDP_URL ?? 'http://127.0.0.1:9222');
if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
  || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
  throw new Error('TAPNOW_CDP_URL 必须是本机 HTTP 调试地址。');
}
const entry = { command: process.execPath, args: [server], env: { TAPNOW_CDP_URL: endpoint.origin } };
if (format === 'json') {
  process.stdout.write(JSON.stringify({ mcpServers: { 'tapnow-canvas': entry } }, null, 2) + '\n');
} else if (format === 'codex') {
  process.stdout.write(`[mcp_servers.tapnow_canvas]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n\n[mcp_servers.tapnow_canvas.env]\nTAPNOW_CDP_URL = ${JSON.stringify(endpoint.origin)}\n`);
} else {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  process.stdout.write(`claude mcp add --transport stdio --scope user --env ${quote('TAPNOW_CDP_URL=' + endpoint.origin)} tapnow-canvas -- ${quote(entry.command)} ${quote(server)}\n`);
}
