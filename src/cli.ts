import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TapnowService } from './service.js';
import { errorResult } from './errors.js';

async function main() {
  const [command = 'diagnose', ...args] = process.argv.slice(2);
  if (command === 'launch') {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/launch-tapnow.ps1', import.meta.url)), ...args], { stdio: 'inherit', windowsHide: true });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    return;
  }
  if (command !== 'diagnose') throw new Error('用法：npm run diagnose，或 npm run launch -- [-AppPath 路径] [-Port 9222]');
  const service = new TapnowService();
  try { process.stdout.write(`${JSON.stringify(await service.diagnose(), null, 2)}\n`); }
  finally { await service.close(); }
}
main().catch(error => { process.stderr.write(`${JSON.stringify(errorResult(error), null, 2)}\n`); process.exitCode = 1; });
