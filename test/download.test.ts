import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadNodes } from '../src/download.js';

test('批量下载隔离逐项失败，清理不完整文件，清理名称且不覆盖现有成果',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'tapnow-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const media={id:'image',type:'image',data:{src:'https://files.tapnow.media/test',title:'../../CON'}};
  const get:any=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png','content-length':'3'}});
  const first=await downloadNodes([{id:'text',type:'text',data:{text:'hello',title:'../note'}},media,{id:'bad',type:'image',data:{src:'http://localhost/private'}}],dir,get);
  assert.equal(first.ok,false);assert.deepEqual(first.results.map(r=>r.ok),[true,true,false]);
  assert.equal(await readFile(first.results[0].path,'utf8'),'hello');
  assert.equal(await readFile(first.results[1].path).then(x=>x.length),3);
  assert.ok(first.results.every(r=>!r.path||r.path.startsWith(dir+requireSeparator())));
  const second=await downloadNodes([media],dir,get);assert.notEqual(second.results[0].path,first.results[1].path);
  const incomplete:any=async()=>new Response(new Uint8Array([1]),{headers:{'content-type':'image/png','content-length':'4'}});
  const failed=await downloadNodes([media],dir,incomplete);assert.equal(failed.results[0].error.code,'DOWNLOAD_INCOMPLETE');
  assert.equal((await readdir(dir)).length,3);
});
function requireSeparator(){return process.platform==='win32'?'\\':'/';}

test('媒体重定向不离开官方域名，HTML 和超大响应不会创建文件',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'tapnow-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const node={id:'n',type:'image',data:{src:'https://files.tapnow.media/test'}};
  let calls=0;
  const redirect:any=async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})};
  const redirected=await downloadNodes([node],dir,redirect);assert.equal(calls,1);assert.equal(redirected.results[0].error.code,'UNSUPPORTED_DOWNLOAD_URL');
  const html:any=async()=>new Response('not an image',{headers:{'content-type':'text/html'}});
  assert.equal((await downloadNodes([node],dir,html)).results[0].error.code,'UNSUPPORTED_MEDIA');
  const large:any=async()=>new Response('x',{headers:{'content-type':'image/png','content-length':String(51*1024*1024)}});
  assert.equal((await downloadNodes([node],dir,large)).results[0].error.code,'FILE_TOO_LARGE');
  assert.deepEqual(await readdir(dir),[]);
  await assert.rejects(downloadNodes([node],'relative'),(e:any)=>e.code==='INVALID_ARGUMENT');
});
