import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TapnowService } from './service.js';
import { errorResult } from './errors.js';
import { createResidentService, ensureResident, residentConfig, residentStatus, stopResident } from './resident.js';

async function main() {
  const [command = 'diagnose', ...args] = process.argv.slice(2);
  if (['resident-start', 'resident-status', 'resident-stop'].includes(command)) {
    if (process.env.TAPNOW_TARGET === 'both') { process.env.TAPNOW_TARGET = 'web'; process.env.TAPNOW_CDP_URL = process.env.TAPNOW_WEB_CDP_URL ?? 'chrome'; }
    process.env.TAPNOW_TARGET ??= 'web';
    process.env.TAPNOW_CDP_URL ??= 'chrome';
    if (command === 'resident-start') {
      await ensureResident();
      const diagnose = await createResidentService().diagnose();
      process.stdout.write(JSON.stringify({ ok: true, ...await residentStatus(), canvas: diagnose.canvas }, null, 2) + '\n');
    } else process.stdout.write(JSON.stringify({ ok: true, ...await (command === 'resident-status' ? residentStatus() : stopResident()) }, null, 2) + '\n');
    return;
  }
  if (command === 'launch') {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/launch-tapnow.ps1', import.meta.url)), ...args], { stdio: 'inherit', windowsHide: true });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    return;
  }
  if (!['diagnose', 'diagnose-web', 'diagnose-both'].includes(command)) throw new Error('用法：npm run diagnose、diagnose:web、diagnose:both、resident:start、resident:status、resident:stop，或 npm run launch -- [-AppPath 路径] [-Port 9222]');
  if (command === 'diagnose-web') { process.env.TAPNOW_TARGET ??= 'web'; process.env.TAPNOW_CDP_URL ??= 'chrome'; }
  if (command === 'diagnose-both') {
    process.env.TAPNOW_TARGET = 'both';
    if ((await residentStatus(residentConfig({ endpoint: process.env.TAPNOW_WEB_CDP_URL ?? 'chrome', mode: 'web' }))).running) process.env.TAPNOW_RESIDENT ??= '1';
  }
  const useResident = process.env.TAPNOW_RESIDENT === '1' || command === 'diagnose-web' && (await residentStatus()).running;
  const service = process.env.TAPNOW_TARGET === 'both' ? await (await import('./dual.js')).createDualService() : useResident ? createResidentService() : new TapnowService();
  try { process.stdout.write(`${JSON.stringify(await service.diagnose(), null, 2)}\n`); }
  finally { await service.close(); }
}
main().catch(error => { process.stderr.write(`${JSON.stringify(errorResult(error), null, 2)}\n`); process.exitCode = 1; });
