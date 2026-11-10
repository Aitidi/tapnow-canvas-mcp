/**
 * Discover the currently loaded Tapnow frontend's native entry points by shape.
 * This function is serialized into the renderer: keep every dependency inside it.
 * Discovery never invokes factories, uploaders, hooks, generation or save actions.
 */
export async function discoverNativeModules(): Promise<any> {
  const doc = (globalThis as any).document;
  const base = new URL((globalThis as any).location.href);
  const candidates = [...Array.from(doc.scripts, (element: any) => element.src),
    ...Array.from(doc.querySelectorAll('link[rel="modulepreload"]'), (element: any) => element.href)];
  const sameApp = (url: any) => url.origin === base.origin && url.protocol === base.protocol && url.hostname === base.hostname;
  // 0.4.15x desktop loads the canvas bundle lazily, so it is only named in the entry's import map.
  for (const value of Array.from(doc.scripts, (element: any) => element.src)) {
    try {
      const url = new URL(value as string, base.href);
      if (base.protocol !== 'tapnow:' || !sameApp(url) || url.search || url.hash || !/^\/assets\/main-[A-Za-z0-9_-]{8}\.js$/.test(url.pathname)) continue;
      const text = await (await fetch(url.href)).text();
      for (const match of new Set(text.match(/\.\/vendor-pkg-canvas-v2-[A-Za-z0-9_-]{8}\.js/g) ?? [])) candidates.push(new URL(match, url.href).href);
    } catch { /* The legacy and preload candidates still apply. */ }
  }
  const moduleUrls = [...new Set(candidates.filter((value): value is string => typeof value === 'string' && !!value))]
    .filter(value => {
      try {
        const url = new URL(value, base.href);
        // Only the currently exposed, known native capability modules. Never
        // import every preloaded UI component: module evaluation can have effects.
        if (url.username || url.password || url.search || url.hash) return false;
        const legacy = sameApp(url) &&
          /^\/assets\/(?:index|UnlimitedModeToggle|course-api-base-url|group)-[^/]+\.js$/.test(url.pathname);
        const desktop = base.protocol === 'tapnow:' && sameApp(url) &&
          /^\/assets\/(?:vendor-pkg-canvas-v2|vendor-pkg-endpoints|vendor-pkg-tap-models|shell-canvas)-[A-Za-z0-9_-]{8}\.js$/.test(url.pathname);
        const web = base.origin === 'https://app.tapnow.ai' && url.origin === 'https://fe-assets.tapnow.media' &&
          /^\/[a-f0-9]{40}\/assets\/(?:vendor-pkg-canvas|vendor-packages)-[A-Za-z0-9_-]{8}\.js$/.test(url.pathname);
        return legacy || desktop || web;
      } catch { return false; }
    });
  const factories: Record<string, any> = {};
  const modelRegistries: Record<string, any> = {};
  let flush: any, upload: any, policy: any, selection: any, generationHistory: any, normalizeHistory: any, canvasApi: any;
  const audioModels = new Map<string, any>();
  const failures: string[] = [];
  const source = (value: any): string => {
    try { return typeof value === 'function' ? Function.prototype.toString.call(value) : ''; }
    catch { return ''; }
  };
  const hasOwnMethod = (value: any, key: string) => typeof Object.getOwnPropertyDescriptor(value, key)?.value === 'function';
  const wrapFactory = (factory: any, audio = false) => (data: any = {}, options: any = {}) => {
    if (audio) return { ...factory(data, options.position, options.selected), ...options };
    return factory(data, options);
  };
  for (const url of moduleUrls) {
    let module: any;
    try { module = await import(url); } catch { failures.push(url); continue; }
    const scoped = base.origin === 'https://app.tapnow.ai' || base.protocol === 'tapnow:' ?(globalThis as any).__tapnowCanvasMcpScopedNative : undefined;
    for (const value of [...Object.values(module), ...Array.isArray(scoped) ? scoped : []] as any[]) {
      try {
        if (typeof value === 'function') {
          const src = source(value);
          if (/rawGenerationParams:/.test(src) && /sourceFileIds:/.test(src) && /\.resources\.map\(/.test(src) && /createdAt:/.test(src)) normalizeHistory ??= value;
          // 0.4.20x exports the uploader class instead of its singleton. Delay
          // construction until an actual import, so discovery stays read-only.
          const prototype = value.prototype;
          if (prototype && hasOwnMethod(prototype, 'upload') && hasOwnMethod(prototype, 'validateFile') &&
            hasOwnMethod(prototype, 'legacyUpload') && /this\.validateFile/.test(source(prototype.upload)) &&
            /this\.legacyUpload/.test(source(prototype.upload)) && /this\.gcsUploader/.test(src)) {
            let manager: any;
            upload ??= async (file: any) => {
              manager ??= new value();
              const result = await manager.upload(file);
              if (result?.success !== true || !result.fileInfo || typeof result.fileInfo.url !== 'string' || !result.fileInfo.url) {
                throw Object.assign(new Error(result?.error || 'Tapnow 原生上传未返回有效素材地址。'), { code: 'UPLOAD_FAILED' });
              }
              return result.fileInfo;
            };
          }
          // Workflow groups use an implicit object return and a direct position
          // argument instead of the regular node constructor's options object.
          if (/=>\s*\(\{id:/.test(src) && /type:[\w$]+\.GROUP,/.test(src) &&
            /data:\{createdBy:["']client["']/.test(src) && /position:/.test(src)) {
            factories.group ??= (data: any = {}, options: any = {}) => ({ ...value(data, options.position ?? { x: 0, y: 0 }), ...options });
          }
          // Every accepted constructor must produce a native canvas-node shape.
          if (/return\s*\{id:/.test(src) && /position:/.test(src)) {
            // 0.4.25x localizes default titles: title:yi("uploadImage") instead of a literal.
            const titleMatch = /title:\s*(?:["']([^"']+)["']|[\w$]+\(["']([\w.]+)["']\))/.exec(src);
            const localizedTitles = new Map([['text', 'Text'], ['image', 'Image'], ['video', 'Video'], ['audio', 'Audio'],
              ['uploadImage', 'Upload Image'], ['uploadVideo', 'Upload Video'], ['uploadAudio', 'Upload Audio'], ['group', 'Group']]);
            const title = titleMatch?.[1] ?? localizedTitles.get(titleMatch?.[2] ?? '');
            if (title === 'Text' && /\.PURE/.test(src)) factories.text ??= wrapFactory(value);
            else if (title === 'Text' && /\.GENERATE/.test(src)) factories.textGenerate ??= wrapFactory(value);
            else if (title === 'Image' && /\.GENERATE/.test(src)) factories.image ??= wrapFactory(value);
            else if (title === 'Video' && /\.GENERATE/.test(src)) factories.video ??= wrapFactory(value);
            else if (title === 'Upload Image' && /\.UPLOAD/.test(src)) factories.imageUpload ??= wrapFactory(value);
            else if (title === 'Upload Video' && /\.UPLOAD/.test(src)) factories.videoUpload ??= wrapFactory(value);
            else if (title === 'Upload Audio' && /\.UPLOAD/.test(src)) factories.audioUpload ??= wrapFactory(value);
            else if (title === 'Audio' && /\.AUDIO/.test(src)) factories.audio ??= wrapFactory(value, true);
            else if (title === 'Group' && /(?:\.GROUP|["']group["'])/.test(src)) factories.group ??= wrapFactory(value);
          }
          // Intentionally narrow: never confuse owner-release functions with flush.
          if (/^[\w$]+\s*=>\s*[\w$]+\.get\([\w$]+\)\?\.flush\(\)\?\?Promise\.resolve\(["']failed["']\)$/.test(src)) flush ??= value;
          // Read only explicitly-owned Zustand API methods, never synthetic proxies.
          if (hasOwnMethod(value, 'getState') && hasOwnMethod(value, 'setState') && hasOwnMethod(value, 'subscribe')) {
            const state = value.getState();
            if (state && typeof state === 'object') {
              if ('mergedPolicy' in state && typeof state.setPolicy === 'function' && typeof state.clearPolicy === 'function') policy ??= value;
              if (Array.isArray(state.selectedNodes) && typeof state.setSelectedNodes === 'function' && typeof state.clearSelection === 'function') selection ??= value;
            }
          }
        } else if (value && typeof value === 'object') {
          if (['getAllCanvas','getCanvas','createCanvas'].every(k=>hasOwnMethod(value,k)) && /\.GET_ALL_CANVAS/.test(source(value.getAllCanvas))) {
            const send = async (call:any) => { const r=await call.send(); if(r?.code!==0 || !r.data) throw Object.assign(new Error('Tapnow 画布接口未确认成功。'),{code:'CANVAS_API_ERROR'}); return r.data; };
            canvasApi ??= {
              // Team canvases live in a separate scope; "all" serves personal first, then team, as one offset range.
              list: async (args:any)=>{
                const page=(scope:string,offset:number,limit:number)=>send(value.getAllCanvas({offset,limit,with_total:true,scope,sort_by:'updated_at',sort_order:'desc'}));
                const offset=args.offset??0,limit=args.limit??20;
                if(args.scope==='personal'||args.scope==='team'){const r=await page(args.scope==='team'?'team_shared':'personal',offset,limit);return {...r,total:Number(r.total)};}
                const personal=await page('personal',offset,limit);
                const personalTotal=Number(personal.total),remaining=limit-personal.canvases.length;
                // A full personal page still needs the team total, so ask for one row and discard it.
                const team=await page('team_shared',Math.max(0,offset-personalTotal),Math.max(1,remaining));
                return {canvases:[...personal.canvases,...remaining>0?team.canvases:[]],total:personalTotal+Number(team.total)};
              },
              get: (canvasId:string)=>send(value.getCanvas({canvas_id:canvasId,with_nodes:false,with_connections:false})),
              create: (args:any)=>send(value.createCanvas({name:args.name,description:args.description??'',is_public:false})),
            };
          }
          if (hasOwnMethod(value, 'getNodeGenerationHistory') && /\.GENERATION_HISTORY\(/.test(source(value.getNodeGenerationHistory))) {
            generationHistory ??= async (canvasId: string, nodeId: string, limit: number) => {
              const response = await value.getNodeGenerationHistory({ canvas_id: canvasId, node_id: nodeId, limit }).send();
              if (response?.code !== 0 || !Array.isArray(response.data?.items)) {
                throw Object.assign(new Error('Tapnow 未返回有效的节点生成历史。'), { code: 'HISTORY_ERROR' });
              }
              return response.data;
            };
          }
          // The native uploader is a class instance; hooks exposing uploadFile are
          // excluded. Preserve its receiver so its validation/fallback stays intact.
          const prototype = Object.getPrototypeOf(value);
          if (prototype && hasOwnMethod(prototype, 'upload') && hasOwnMethod(prototype, 'validateFile') &&
            hasOwnMethod(prototype, 'legacyUpload') && /this\.validateFile/.test(source(prototype.upload))) {
            upload ??= async (file: any) => {
              const result = await value.upload(file);
              if (result?.success !== true || !result.fileInfo || typeof result.fileInfo.url !== 'string' || !result.fileInfo.url) {
                throw Object.assign(new Error(result?.error || 'Tapnow 原生上传未返回有效素材地址。'), { code: 'UPLOAD_FAILED' });
              }
              return result.fileInfo;
            };
          }
          const records = Object.values(value).filter((item: any) => item && typeof item === 'object') as any[];
          if (!records.length) continue;
          if (records.every(item => typeof item.provider === 'string' && typeof item.name === 'string') &&
            records.some(item => /^textModels\./.test(item.name))) modelRegistries.text ??= value;
          if (records.every(item => typeof item.provider === 'string') &&
            records.some(item => Array.isArray(item.variants) && item.variants.some((variant: any) => typeof variant.modelType === 'string' && /_to_video$/.test(variant.modelType)))) modelRegistries.video ??= value;
          if (records.every(item => typeof item.provider === 'string') &&
            records.some(item => Array.isArray(item.supportedModes) && item.supportedModes.includes('text_to_image')) &&
            records.some(item => item.defaults && item.options)) modelRegistries.image ??= value;
          if (Array.isArray(value) && records.length === value.length && records.every(item =>
            typeof item.provider === 'string' && typeof item.model === 'string' &&
            typeof item.characterLimit === 'number') && records.some(item => item.defaultParams)) {
            for (const item of records) audioModels.set(item.model, item);
          }
        }
      } catch { /* An incompatible export is not an excuse to execute it. */ }
    }
  }
  if (audioModels.size) modelRegistries.audio = [...audioModels.values()];
  const persistence = base.protocol === 'tapnow:' ? (globalThis as any).__tapnowCanvasMcpPersistence : undefined;
  if (Array.isArray(persistence) && persistence.length) {
    flush = async (canvasId:string) => {
      const matches = persistence.filter(p => typeof p.registered === 'function' && typeof p.flush === 'function' && p.registered(canvasId));
      if (matches.length !== 1) throw Object.assign(new Error('当前画布没有唯一匹配的原生保存队列。'), {code:'SAVE_QUEUE_UNAVAILABLE'});
      return matches[0].flush(canvasId);
    };
  }
  return { factories, modelRegistries, flush, upload, policy, selection, generationHistory, normalizeHistory, canvasApi, moduleUrls, failures };
}
