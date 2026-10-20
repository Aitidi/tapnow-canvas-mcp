// Generate machine-specific settings without changing any client configuration.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const format = process.argv[2] ?? 'json';
if (process.argv.includes('--web-resident')) {
  process.env.TAPNOW_TARGET = 'web'; process.env.TAPNOW_CDP_URL ??= 'chrome'; process.env.TAPNOW_RESIDENT = '1';
}
if (!['json', 'codex', 'claude-code'].includes(format)) {
  process.stderr.write('用法：node scripts/print-config.mjs [json|codex|claude-code]\n');
  process.exit(1);
}
const server = fileURLToPath(new URL('../dist/server.js', import.meta.url));
if (!existsSync(server)) {
  process.stderr.write('尚未构建 MCP 服务，请先在项目目录执行 npm ci 和 npm run build。\n');
  process.exit(1);
}
const { CdpConnection } = await import('../dist/cdp.js');
const env = {};
if (process.argv.includes('--both')) {
  // Chrome's own remote debugging defaults to 9222, so the desktop app gets a separate port.
  process.env.TAPNOW_TARGET = 'both'; process.env.TAPNOW_RESIDENT = '1';
  env.TAPNOW_DESKTOP_CDP_URL = new CdpConnection(process.env.TAPNOW_DESKTOP_CDP_URL ?? 'http://127.0.0.1:9333', { mode: 'desktop' }).endpoint;
  env.TAPNOW_WEB_CDP_URL = new CdpConnection(process.env.TAPNOW_WEB_CDP_URL ?? 'chrome', { mode: 'web' }).endpoint;
} else env.TAPNOW_CDP_URL = new CdpConnection().endpoint;
for (const name of ['TAPNOW_TARGET','TAPNOW_TARGET_ID', 'TAPNOW_CHROME_USER_DATA_DIR', 'TAPNOW_STATE_DIR', 'TAPNOW_RESIDENT']) {
  if (process.env[name]) env[name] = process.env[name];
}
const entry = { command: process.execPath, args: [server], env };
if (format === 'json') {
  process.stdout.write(JSON.stringify({ mcpServers: { 'tapnow-canvas': entry } }, null, 2) + '\n');
} else if (format === 'codex') {
  process.stdout.write(`[mcp_servers.tapnow_canvas]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\ntool_timeout_sec = 660\n\n[mcp_servers.tapnow_canvas.env]\n${Object.entries(env).map(([key, value]) => key + ' = ' + JSON.stringify(value)).join('\n')}\n`);
} else {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  process.stdout.write(`claude mcp add --transport stdio --scope user ${Object.entries(env).map(([key, value]) => '--env ' + quote(key + '=' + value)).join(' ')} tapnow-canvas -- ${quote(entry.command)} ${quote(server)}\n`);
}
