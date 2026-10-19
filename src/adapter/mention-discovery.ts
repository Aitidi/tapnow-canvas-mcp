/** Serialized into the renderer. Discovery reads exports, never calls the backend. */
export async function discoverMentionNative(): Promise<any> {
  const doc = (globalThis as any).document;
  const base = new URL((globalThis as any).location.href);
  const candidates = [...Array.from(doc.scripts, (element: any) => element.src),
    ...Array.from(doc.querySelectorAll('link[rel="modulepreload"]'), (element: any) => element.href)];
  const urls = [...new Set(candidates.filter((value): value is string => typeof value === 'string' && !!value))]
    .filter(value => {
      try {
        const url = new URL(value, base.href);
        if (url.username || url.password || url.search || url.hash) return false;
        const legacy = url.origin === base.origin && url.protocol === base.protocol && url.hostname === base.hostname &&
          /^\/assets\/UnlimitedModeToggle-[^/]+\.js$/.test(url.pathname);
        const web = base.origin === 'https://app.tapnow.ai' && url.origin === 'https://fe-assets.tapnow.media' &&
          /^\/[a-f0-9]{40}\/assets\/(?:vendor-pkg-canvas|vendor-packages)-[A-Za-z0-9_-]{8}\.js$/.test(url.pathname);
        return legacy || web;
      } catch { return false; }
    });
  const source = (value: any): string => {
    try { return typeof value === 'function' ? Function.prototype.toString.call(value) : ''; }
    catch { return ''; }
  };
  const ownFunction = (value: any, key: string) => Object.getOwnPropertyDescriptor(value, key)?.value;
  const fail = (code: string, message: string, details?: any): never => {
    throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
  };
  let parser: any, tokenParser: any, expander: any, normalizeAsset: any, textContent: any, api: any;
  for (const moduleUrl of urls) {
    let module: any;
    try { module = await import(moduleUrl); } catch { continue; }
    const scoped = base.origin === 'https://app.tapnow.ai' ? (globalThis as any).__tapnowCanvasMcpScopedNative : undefined;
    for (const value of [...Object.values(module), ...Array.isArray(scoped) ? scoped : []] as any[]) {
      const src = source(value);
      if (src && /\.nodeType/.test(src) && /\.nodeId/.test(src) && /\.assetId/.test(src) &&
        /nodeName:/.test(src) && /mediaSrc:/.test(src) && /previewImage:/.test(src) &&
        /durationMs:/.test(src) && /official:/.test(src) && /return null/.test(src)) parser ??= value;
      if (src && /\.indexOf\(["']\{\{Asset:/.test(src) && /\.endIndex/.test(src) &&
        /\.content/.test(src) && /\.push\(/.test(src) && /return\[\]/.test(src) &&
        !/images:|videos:|audios:/.test(src)) tokenParser ??= value;
      if (src && /allowedNodeTypes/.test(src) && /allowLegacyNodePayload/.test(src) &&
        /\.indexOf\(["']\{\{Asset:/.test(src) && /\.mediaSrc/.test(src) &&
        /images:/.test(src) && /videos:/.test(src) && /audios:/.test(src)) expander ??= value;
      if (src && /\.asset_type/.test(src) && /\.compliance_status/.test(src) &&
        /\.\.\.[\w$]+,asset_type:/.test(src) && /compliance_status:/.test(src) && !/metadata|\.asset\b/.test(src)) normalizeAsset ??= value;
      if (src && /typeof [\w$]+\.content={2,3}["']string["']/.test(src) && /\.metadata/.test(src) &&
        /\.fields/.test(src) && /\.source_url/.test(src) && /\.thumbnail_url/.test(src) && /\.name/.test(src)) textContent ??= value;
      if (value && typeof value === 'object') {
        const search = ownFunction(value, 'searchAssets');
        const get = ownFunction(value, 'getAssetDetail');
        const list = ownFunction(value, 'listAssetsForMention');
        if (typeof search === 'function' && typeof get === 'function' && typeof list === 'function' &&
          /\.SEARCH_ASSETS/.test(source(search)) && /\.GET_ASSET_DETAIL/.test(source(get)) &&
          /\.LIST_ASSETS_FOR_MENTION/.test(source(list))) api ??= value;
      }
    }
  }
  if (!parser || !tokenParser || !expander || !normalizeAsset || !textContent || !api) fail('UNSUPPORTED_VERSION', '当前 Tapnow 未提供可识别的原生 @素材解析或素材库入口。');
  const spaces = new Map<string, string>();
  const safeUrl = (value: any) => {
    if (typeof value !== 'string' || !value) return undefined;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : undefined;
    } catch { return undefined; }
  };
  const canonical = (raw: any, space?: string) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
    const asset = normalizeAsset(raw);
    const kind = ({ 1: 'image', 2: 'video', 3: 'audio', 4: 'text' } as Record<number, string>)[asset.asset_type];
    if (!kind) return null;
    const mediaSrc = kind === 'text' ? undefined : safeUrl(asset.source_url);
    const content = kind === 'text' ? textContent(asset) : undefined;
    if (kind === 'text' ? typeof content !== 'string' || !content : !mediaSrc) return null;
    const previewImage = safeUrl(asset.thumbnail_url);
    const durationMs = ['video', 'audio'].includes(kind) && typeof asset.duration_ms === 'number' &&
      Number.isFinite(asset.duration_ms) && asset.duration_ms > 0 ? asset.duration_ms : undefined;
    if (space) spaces.set(asset.id, space);
    return { assetId: asset.id, label: typeof asset.name === 'string' ? asset.name : asset.id, kind,
      ...(mediaSrc ? { mediaSrc } : {}), ...(previewImage ? { previewImage } : {}),
      ...(durationMs ? { durationMs } : {}), ...(content !== undefined ? { content } : {}),
      ...(space ? { space } : {}) };
  };
  const libraryCall = async (callback: () => Promise<any>, asset = false) => {
    try { return await callback(); }
    catch (error: any) {
      if (asset && error?.status === 404) fail('ASSET_NOT_FOUND', '素材库中未找到该素材，或当前账号无法访问。');
      fail('LIBRARY_ERROR', 'Tapnow 原生素材库请求失败。', typeof error?.status === 'number' ? { status: error.status } : undefined);
    }
  };
  return {
    moduleUrls: urls,
    parseAsset: (payload: any) => {
      try {
        const value = typeof payload === 'string' ? payload : `Asset:${JSON.stringify(payload)}`;
        return parser(value) ?? null;
      } catch { return null; }
    },
    parseAssetTokens: (prompt: string) => tokenParser(prompt),
    expandAssets: expander,
    library: {
      async list(args: any = {}) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const limit = args.limit === undefined ? 50 : args.limit;
        const offset = args.offset === undefined ? 0 : args.offset;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - limit) {
          fail('LIBRARY_ERROR', '素材查询 limit 必须为 1–100，offset 必须为有效的非负整数。');
        }
        const fetchGroups = async (pages: (number | undefined)[], size: number) => {
          if (query) {
            return await libraryCall(() => Promise.all(pages.map(async (page, index) => page === undefined ? undefined :
              (await api.searchAssets({ space_type: index + 1, keyword: query, page, page_size: size }))?.data)));
          }
          const result = await libraryCall(() => api.listAssetsForMention({
            private_page: pages[0] ?? 1, private_page_size: pages[0] === undefined ? 1 : size,
            team_page: pages[1] ?? 1, team_page_size: pages[1] === undefined ? 1 : size,
          }));
          return [result?.data?.private_group, result?.data?.team_group];
        };
        const validGroup = (group: any) => group && Array.isArray(group.items) && group.pagination &&
          Number.isSafeInteger(group.pagination.total) && group.pagination.total >= 0;
        // Totals establish one stable ordering: all personal results, then all
        // team results. Cursor positions count raw records, including skipped
        // unsupported assets; filtering must never shift later page offsets.
        const metadata = await fetchGroups([1, 1], 1);
        if (metadata.some((group: any) => !validGroup(group))) fail('LIBRARY_ERROR', 'Tapnow 素材库返回格式或总数不匹配。');
        const totals = metadata.map((group: any) => group.pagination.total);
        const total = totals[0] + totals[1];
        if (!Number.isSafeInteger(total)) fail('LIBRARY_ERROR', 'Tapnow 素材库总数无效。');
        if (offset >= total) return { items: [], hasMore: false };
        const end = Math.min(total, offset + limit);
        const starts = [offset, Math.max(0, offset - totals[0])];
        const ends = [Math.min(totals[0], end), Math.max(0, end - totals[0])];
        const pages = totals.map((_: number, index: number) => {
          if (starts[index] >= ends[index]) return [];
          const first = Math.floor(starts[index] / 100) + 1;
          const last = Math.floor((ends[index] - 1) / 100) + 1;
          return first === last ? [first] : [first, last];
        });
        const pageData = [new Map<number, any[]>(), new Map<number, any[]>()];
        for (let round = 0; round < Math.max(pages[0].length, pages[1].length); round++) {
          const requested = pages.map((groupPages: number[]) => groupPages[round]);
          const groups = await fetchGroups(requested, 100);
          for (let index = 0; index < 2; index++) {
            const page = requested[index];
            if (page === undefined) continue;
            const group = groups[index];
            if (!validGroup(group) || group.pagination.total !== totals[index] || group.pagination.page !== page ||
              group.pagination.page_size !== 100 || group.items.length > 100) {
              fail('LIBRARY_ERROR', '素材库在分页期间发生变化，或分页格式不匹配，请重新查询。');
            }
            pageData[index].set(page, group.items);
          }
        }
        const items: any[] = [];
        for (let index = 0; index < 2; index++) {
          for (let cursor = starts[index]; cursor < ends[index]; cursor++) {
            const raw = pageData[index].get(Math.floor(cursor / 100) + 1)?.[cursor % 100];
            if (!raw) fail('LIBRARY_ERROR', '素材库分页内容已变化，请重新查询。');
            const item = canonical(raw.asset, index === 0 ? 'personal' : 'team');
            if (item) items.push(item);
          }
        }
        return { items, hasMore: end < total, ...(end < total ? { nextOffset: end } : {}) };
      },
      async get(assetId: string) {
        if (typeof assetId !== 'string' || !assetId || assetId.length > 256) fail('ASSET_NOT_FOUND', '素材 ID 无效。');
        const result = await libraryCall(() => api.getAssetDetail({ asset_id: assetId }), true);
        const asset = result?.data?.detail?.asset;
        if (!asset || asset.id !== assetId) fail('ASSET_NOT_FOUND', '素材库中未找到该素材，或当前账号无法访问。');
        const item = canonical(asset, spaces.get(assetId));
        if (!item) fail('ASSET_NOT_FOUND', '该素材不是可引用的图片、视频、音频或文字，或缺少有效内容。');
        return item;
      },
    },
  };
}
