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
    const url = same(value); return !!url && /^\/assets\/(?:main|index)-[A-Za-z0-9_-]{8}\.js$/.test(url.pathname);
  }) as string | undefined;
  if (entry && !found.size) {
    try {
      const text = await (await fetch(entry)).text();
      for (const match of new Set(text.match(/\.\/vendor-pkg-canvas(?:-v2)?-[A-Za-z0-9_-]{8}\.js/g) ?? [])) add(new URL(match, entry).href);
    } catch { /* Loaded resources still apply. */ }
  }
  // The Rolldown web build can evict the main bundle from resource timing, and
  // Page.getResourceTree may retain only images/styles after a late CDP attach.
  // Already loaded 3D companion modules import that exact core bundle. Read
  // their static imports only; do not import or execute the companion UI here.
  if (!found.size) {
    const name = 'vendor-pkg-canvas';
    const companion = new RegExp('^/assets/' + name + '-v2-(?:three-d-overlay|three-d-session-ui)-[A-Za-z0-9_-]{8}\\.js$');
    const imports = new RegExp('\\./' + name + '(?:-v2)?-[A-Za-z0-9_-]{8}\\.js', 'g');
    const observed = [...hints, ...(g.performance?.getEntriesByType?.('resource') ?? []).map((entry: any) => entry.name),
      ...Array.from(g.document.querySelectorAll('link[rel="modulepreload"]'), (link: any) => link.href)];
    const companions = [...new Set(observed.filter((value: any) => { const url = same(value); return !!url && companion.test(url.pathname); }))].slice(0, 2);
    for (const url of companions) {
      try {
        const response = await fetch(url as string, { signal: g.AbortSignal?.timeout?.(5000) });
        if (response.ok === false) continue;
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) continue;
        for (const match of new Set(text.match(imports) ?? [])) add(new URL(match, url as string).href);
        if (found.size) break;
      } catch { /* Missing companion source cannot authorize guessed bundle URLs. */ }
    }
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
  return cdp.evaluate(`(async()=>{const __name=value=>value;globalThis.__tapnowCanvasMcpModuleHints=${JSON.stringify(urls)};const bundles=await (${findCanvasBundles.toString()})(true);globalThis.__tapnowCanvasMcpModuleHints=[...new Set([...globalThis.__tapnowCanvasMcpModuleHints,...bundles])];return globalThis.__tapnowCanvasMcpModuleHints.length;})()`);
}
