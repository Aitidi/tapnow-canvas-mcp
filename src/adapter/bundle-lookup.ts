/**
 * Serialized into the renderer: keep every dependency inside it.
 * Find the loaded official canvas bundle URLs on the desktop (tapnow://app) or the
 * web app (https://app.tapnow.ai), which share one same-origin Vite build. The
 * bundle is imported lazily, so it is named only by loaded resources (CDP hints,
 * resource timing) or, on desktop, by the entry's import map. Never evaluates code.
 */
export async function findCanvasBundles(includeLegacy = false): Promise<string[]> {
  const g = globalThis as any, location = g.location;
  if (!((location.protocol === 'tapnow:' && location.host === 'app') || location.origin === 'https://app.tapnow.ai')) return [];
  const pattern = includeLegacy ? /^\/assets\/vendor-pkg-canvas(?:-v2)?-[A-Za-z0-9_-]{8}\.js$/ : /^\/assets\/vendor-pkg-canvas-v2-[A-Za-z0-9_-]{8}\.js$/;
  const same = (value: any) => {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && url.protocol === location.protocol && url.host === location.host &&
        !url.username && !url.password && !url.search && !url.hash ? url : null;
    } catch { return null; }
  };
  const found = new Set<string>();
  const add = (value: any) => { const url = same(value); if (url && pattern.test(url.pathname)) found.add(url.href); };
  const hints = Array.isArray(g.__tapnowCanvasMcpModuleHints) ? g.__tapnowCanvasMcpModuleHints : [];
  for (const value of [...hints, ...(g.performance?.getEntriesByType?.('resource') ?? []).map((entry: any) => entry.name),
    ...Array.from(g.document.querySelectorAll('link[rel="modulepreload"]'), (link: any) => link.href)]) add(value);
  const entry = Array.from(g.document.scripts, (script: any) => script.src).find((value: any) => {
    const url = same(value); return !!url && /^\/assets\/main-[A-Za-z0-9_-]{8}\.js$/.test(url.pathname);
  }) as string | undefined;
  if (entry) {
    try {
      const text = await (await fetch(entry)).text();
      for (const match of new Set(text.match(/\.\/vendor-pkg-canvas(?:-v2)?-[A-Za-z0-9_-]{8}\.js/g) ?? [])) add(new URL(match, entry).href);
    } catch { /* Loaded resources still apply. */ }
  }
  return [...found];
}

/** Same-origin script URLs the frame has loaded, from CDP (not capped like resource timing). */
export async function collectModuleHints(cdp: { send(method: string, params?: Record<string, unknown>): Promise<any>; evaluate(expression: string): Promise<any> }) {
  let urls: string[] = [];
  try {
    const tree = await cdp.send('Page.getResourceTree');
    const origin = (url: string) => { try { const u = new URL(url); return u.protocol === 'tapnow:' ? 'tapnow://' + u.host : u.origin; } catch { return null; } };
    const frame = tree?.frameTree?.frame;
    const own = frame?.url ? origin(frame.url) : null;
    urls = (tree?.frameTree?.resources ?? []).filter((r: any) => r?.type === 'Script' && typeof r.url === 'string' && own && origin(r.url) === own &&
      /\/assets\/[\w-]+\.js$/.test(new URL(r.url).pathname)).map((r: any) => r.url);
  } catch { /* Resource timing and import maps still apply. */ }
  await cdp.evaluate(`globalThis.__tapnowCanvasMcpModuleHints=${JSON.stringify(urls)}`);
  return urls.length;
}
