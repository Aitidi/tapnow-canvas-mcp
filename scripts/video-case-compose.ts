import { TapnowService } from '../src/service.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const s = new TapnowService();
try {
 const state=JSON.parse(await readFile('artifacts/video-case-state.json','utf8'));
 const b=await s.inspect();assert.equal(b.canvasId,state.canvasId);assert.ok(b.nodes.some((n:any)=>n.id===state.nodeId));
 const refs:Record<string,string>={};
 for(const [i,key] of ['robot','street','parcel'].entries()) {
  const r=await s.importAsset({canvasId:state.canvasId,requestId:'courier-import-'+key+'-v1',path:resolve('output/courier/'+key+'.png'),position:{x:0,y:i*380}});
  assert.equal(r.persistence.confirmed,true);refs[key]=r.nodeId;
 }
 const renamed=await s.edit({canvasId:state.canvasId,requestId:'courier-reference-titles-v1',operations:[
  {op:'update',nodeId:refs.robot,data:{title:'参考01｜橙色快递机器人 · 角色'}},
  {op:'update',nodeId:refs.street,data:{title:'参考02｜雨夜青橙小巷 · 场景'}},
  {op:'update',nodeId:refs.parcel,data:{title:'参考03｜发光封印包裹 · 道具'}},
 ]});assert.ok(renamed.results.every((r:any)=>r.ok));
 const segments:any[]=[
  {type:'text',text:'制作一段10秒的电影感3D动画短片《雨夜快递员》，16:9横屏，静音。角色身份严格参考 '},
  {type:'reference',source:'canvas',nodeId:refs.robot},
  {type:'text',text:'：保持橙色外壳、奶油色面板、青色双眼、短四肢与背包，整个视频只有这一个机器人。环境与光影参考 '},
  {type:'reference',source:'canvas',nodeId:refs.street},
  {type:'text',text:'：雨后小巷、湿润石板路、青色与暖橙色灯光、尽头的投递口。包裹道具严格参考 '},
  {type:'reference',source:'canvas',nodeId:refs.parcel},
  {type:'text',text:'：奶油色方盒、橙色绑带、青色圆形发光封印，体积约为机器人躯干的一半，不要改变外观。\n分镜：0–3秒，低机位中景，机器人双手抱着包裹从左侧走入雨后小巷，脚下泛起细小水花；3–7秒，镜头平稳侧后方跟拍并轻微推进，机器人走向暖色投递口，身体有自然轻微重心变化，包裹保持稳定；7–10秒，镜头停在三分之二侧面中近景，机器人双手将包裹放入投递口，松手后抬头，青色双眼弯成开心的弧线，停留收尾。连续动作、自然衔接、角色与道具外形一致，电影级柔光与真实反射，浅景深。无字幕、无标志、无旁白、无音乐、无音效，不要拼贴参考图或展示角色设定板。'},
 ];
 const written=await s.promptSet({canvasId:state.canvasId,nodeId:state.nodeId,requestId:'courier-prompt-v1',segments});
 assert.equal(written.references.length,3);assert.equal(written.persistence.confirmed,true);
 await writeFile('output/courier/video-prompt.txt',written.prompt);
 await writeFile('artifacts/video-case-state.json',JSON.stringify({...state,refs,segments},null,2));
 await s.cdp.send('Page.reload');let restored:any;
 for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,250));try{restored=await s.inspect({nodeIds:[state.nodeId]});if(restored.nodes.length)break;}catch{}}
 assert.equal(restored.nodes[0].data.prompt,written.prompt);assert.equal(restored.nodes[0].data.params.duration,10);assert.equal(restored.nodes[0].data.params.generateAudio,false);
 let prep=await s.generationPrepare(state);
 for(let i=0;i<15&&(prep.priceLoading||!prep.ready);i++){await new Promise(r=>setTimeout(r,500));prep=await s.generationPrepare(state);}
 await writeFile('artifacts/video-case-prepared.json',JSON.stringify(prep,null,2));
 const shot=await s.screenshot({canvasId:state.canvasId});await writeFile('output/courier/prepared.png',Buffer.from(shot.data,'base64'));
 console.log(JSON.stringify(prep,null,2));
}finally{await s.close();}
