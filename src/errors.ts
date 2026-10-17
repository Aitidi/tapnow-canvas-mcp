export class TapnowError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'TapnowError';
  }
}

export function errorResult(error: unknown) {
  const e = error instanceof TapnowError ? error : new TapnowError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  return { ok: false as const, error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } };
}
