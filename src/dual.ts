import { TapnowService, serviceMethods, type CanvasService, type ServiceMethod } from './service.js';
import { TapnowError, errorResult } from './errors.js';

export const sides = ['app', 'web'] as const;
export type Side = typeof sides[number];
export type TargetChoice = 'auto' | Side;

type Probe = { side: Side; ok: true; canvasId: string | null; result: any } | { side: Side; ok: false; error: ReturnType<typeof errorResult>['error'] };

/** Routes each call to the desktop app or the Chrome page. `auto` only picks a side when exactly one matches. */
export class DualService {
  constructor(readonly services: Record<Side, CanvasService>) {}

  private async probe(): Promise<Probe[]> {
    return Promise.all(sides.map(async (side): Promise<Probe> => {
      try {
        const result = await this.services[side].diagnose();
        return { side, ok: true, canvasId: result?.canvas?.canvasId ?? null, result };
      } catch (error) { return { side, ok: false, error: errorResult(error).error }; }
    }));
  }

  private async route(args: any = {}): Promise<{ side: Side; rest: any }> {
    const { target = 'auto', ...rest } = args ?? {};
    if (target === 'app' || target === 'web') return { side: target, rest };
    if (target !== 'auto') throw new TapnowError('INVALID_ARGUMENT', 'target 必须为 auto、app 或 web。');
    const probes = await this.probe();
    const summary = probes.map(p => p.ok ? { target: p.side, canvasId: p.canvasId, title: p.result?.title ?? null } : { target: p.side, error: p.error });
    const open = probes.filter((p): p is Extract<Probe, { ok: true }> => p.ok && !!p.canvasId);
    const matches = rest.canvasId ? open.filter(p => p.canvasId === rest.canvasId) : open;
    if (matches.length === 1) return { side: matches[0].side, rest };
    if (matches.length > 1) throw new TapnowError('AMBIGUOUS_TARGET', 'APP 端和网页端都打开了可用画布，请用 target 指定 app 或 web。', { sides: summary });
    if (rest.canvasId) throw new TapnowError('CANVAS_NOT_FOUND', 'APP 端和网页端当前都没有打开该画布；请重新读取画布。', { sides: summary });
    throw new TapnowError('NOT_CONNECTED', 'APP 端和网页端都没有可用的画布。', { sides: summary });
  }

  async diagnose(args: { target?: TargetChoice } = {}) {
    if (args.target && args.target !== 'auto') return { target: args.target, ...await this.services[args.target].diagnose() };
    const probes = await this.probe();
    const report = Object.fromEntries(probes.map(p => [p.side, p.ok ? p.result : { ok: false, error: p.error }]));
    return { ok: probes.some(p => p.ok), target: 'both', ...report };
  }

  async close() { await Promise.all(sides.map(side => this.services[side].close())); }
}
for (const method of serviceMethods) {
  if (method === 'diagnose') continue;
  (DualService.prototype as any)[method] = async function (this: DualService, args?: any) {
    const { side, rest }: { side: Side; rest: any } = await (this as any).route(args);
    const result = await (this.services[side] as any)[method satisfies ServiceMethod](rest);
    return result !== null && typeof result === 'object' && !Array.isArray(result) ? { target: side, ...result } : result;
  };
}

/** TAPNOW_TARGET=both: desktop app at TAPNOW_DESKTOP_CDP_URL, Chrome page at TAPNOW_WEB_CDP_URL (resident with TAPNOW_RESIDENT=1). */
export async function createDualService(): Promise<CanvasService> {
  const app = new TapnowService({ endpoint: process.env.TAPNOW_DESKTOP_CDP_URL ?? 'http://127.0.0.1:9222', mode: 'desktop', targetId: '' });
  const webOptions = { endpoint: process.env.TAPNOW_WEB_CDP_URL ?? 'chrome', mode: 'web' as const, targetId: process.env.TAPNOW_TARGET_ID ?? '' };
  const web = process.env.TAPNOW_RESIDENT === '1' ? (await import('./resident.js')).createResidentService(webOptions) : new TapnowService(webOptions);
  return new DualService({ app, web }) as unknown as CanvasService;
}
