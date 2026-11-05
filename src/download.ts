import { mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TapnowError } from './errors.js';

const extensions: Record<string, string> = {
  'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp', 'image/gif':'gif', 'image/avif':'avif',
  'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov',
  'audio/mpeg':'mp3', 'audio/wav':'wav', 'audio/x-wav':'wav', 'audio/ogg':'ogg', 'audio/mp4':'m4a', 'audio/flac':'flac',
};
function hostedUrl(value: string) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || !['tapnow.media','tapnow.ai','tapnow.tv'].some(h=>u.hostname===h || u.hostname.endsWith('.'+h))) {
    throw new TapnowError('UNSUPPORTED_DOWNLOAD_URL', '仅下载 Tapnow 官方域名托管的 HTTPS 媒体，第三方素材请先导入 Tapnow。');
  }
  return u.href;
}
export async function downloadNodes(nodes: any[], directory: string, fetcher: typeof fetch = fetch) {
  if (!isAbsolute(directory)) throw new TapnowError('INVALID_ARGUMENT', '下载目录必须是绝对路径。');
  await mkdir(directory, {recursive:true});
  const results: any[] = [];
  for (const n of nodes) {
    let path: string | undefined, file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (!['text','image','video','audio'].includes(n.type)) throw new TapnowError('UNSUPPORTED_MEDIA', '节点不是可下载的媒体或文字。');
      const name = String(n.data?.title || n.type).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,60) || n.type;
      const stem = `${name}-${randomUUID()}`;
      if (n.type === 'text') {
        if (typeof n.data?.text !== 'string' || !n.data.text.trim()) throw new TapnowError('ASSET_NOT_READY', '文字节点没有可下载内容。');
        path=join(directory, stem+'.txt'); file=await open(path,'wx'); await file.writeFile(n.data.text,'utf8');
        results.push({nodeId:n.id,ok:true,path,bytes:Buffer.byteLength(n.data.text)}); continue;
      }
      const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),600000);
      try {
        let url=hostedUrl(n.data?.src), response: Response | undefined;
        for(let redirects=0;redirects<=5;redirects++) {
          response=await fetcher(url,{redirect:'manual',signal:controller.signal});
          if(![301,302,303,307,308].includes(response.status)) break;
          const next=response.headers.get('location'); await response.body?.cancel();
          if(!next || redirects===5) throw new TapnowError('DOWNLOAD_FAILED','媒体重定向无效或过多。');
          url=hostedUrl(new URL(next,url).href);
        }
        if(!response?.ok || !response.body) { await response?.body?.cancel(); throw new TapnowError('DOWNLOAD_FAILED',`媒体下载失败（HTTP ${response?.status}）。`); }
        const mime=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
        const extension=extensions[mime];
        if(!extension || mime.split('/')[0]!==n.type) { await response.body.cancel(); throw new TapnowError('UNSUPPORTED_MEDIA','响应不是与节点类型匹配的受支持媒体。'); }
        const limit=(n.type==='video'?500:50)*1024*1024;
        const expected=response.headers.get('content-length');
        if(expected && Number(expected)>limit) { await response.body.cancel(); throw new TapnowError('FILE_TOO_LARGE','媒体超过下载大小限制。'); }
        path=join(directory,stem+'.'+extension);file=await open(path,'wx');
        let bytes=0;
        for await(const chunk of response.body as any) {
          bytes+=chunk.length;
          if(bytes>limit) { controller.abort(); throw new TapnowError('FILE_TOO_LARGE','媒体超过下载大小限制。'); }
          await file.writeFile(chunk);
        }
        if(!bytes || expected && Number.isFinite(Number(expected)) && bytes!==Number(expected) && !response.headers.get('content-encoding')) throw new TapnowError('DOWNLOAD_INCOMPLETE','媒体下载不完整。');
        results.push({nodeId:n.id,ok:true,path,bytes,mimeType:mime});
      } finally { clearTimeout(timer); }
    } catch(e:any) {
      if(file) { await file.close(); file=undefined; if(path) await unlink(path).catch(()=>{}); }
      results.push({nodeId:n.id,ok:false,error:{code:e.code??'DOWNLOAD_FAILED',message:e.message}});
    } finally { await file?.close(); }
  }
  return {ok:results.every(r=>r.ok),results};
}
