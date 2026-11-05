import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { TapnowService, type CanvasService } from './service.js';
import { errorResult } from './errors.js';

const id = z.string().min(1).max(512);
const canvas = { canvasId: id.describe('先读取当前画布取得 canvasId；切换画布后必须重新读取。') };
const requestId = z.string().min(8).max(128).describe('调用方生成的唯一请求 ID；重试同一请求必须复用。');
const position = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const ids = z.array(id).min(1).max(500);
const httpUrl = z.url().refine(value => {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}, '需要不带凭据的 HTTP(S) 地址');
const data = z.strictObject({
  title: z.string().max(10000).optional(), text: z.string().max(200000).optional(),
  prompt: z.string().max(200000).optional(), src: httpUrl.max(20000).optional(),
  params: z.record(z.string(), z.json()).optional(),
});
const geometry = { position: position.optional(), width: z.number().positive().max(100000).optional(), height: z.number().positive().max(100000).optional() };
export const editOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), clientId: id.optional().describe('批次内新节点别名，后续连接等操作可引用。'), kind: z.enum(['text', 'image', 'video', 'audio', 'group']), mode: z.enum(['plain', 'generate', 'upload']).optional(), data, ...geometry }),
  z.strictObject({ op: z.literal('update'), nodeId: id, data: data.optional(), ...geometry }),
  z.strictObject({ op: z.literal('delete'), nodeIds: ids }),
  z.strictObject({ op: z.literal('connect'), source: id, target: id, sourceHandle: id.optional(), targetHandle: id.optional() }),
  z.strictObject({ op: z.literal('disconnect'), edgeIds: ids }),
  z.strictObject({ op: z.literal('select'), nodeIds: z.array(id).max(500) }),
  z.strictObject({ op: z.literal('layout'), nodeIds: ids.optional(), direction: z.enum(['LR', 'TB', 'grid']).optional(), gap: z.number().min(0).max(10000).optional() }),
  z.strictObject({ op: z.literal('group'), nodeIds: ids, title: z.string().max(10000).optional() }),
  z.strictObject({ op: z.literal('ungroup'), nodeId: id }),
]);

export const promptSegmentSchema = z.union([
  z.strictObject({ type: z.literal('text'), text: z.string().max(200000) }),
  z.strictObject({ type: z.literal('reference'), source: z.literal('canvas'), nodeId: id }),
  z.strictObject({ type: z.literal('reference'), source: z.literal('library'), assetId: id }),
  z.strictObject({ type: z.literal('reference'), source: z.literal('element'), elementId: z.string().regex(/^[1-9]\d{0,29}$/) }),
]);
const target = z.enum(['auto', 'app', 'web']).default('auto').describe('auto 时仅一端打开画布才自动选择；两端都打开时需指定 app（桌面端）或 web（Chrome 网页端）。');
type Extra = { target?: typeof target };
const promptReferencesShape = (extra: Extra = {}) => z.strictObject({
  ...canvas, ...extra,
  nodeId: id.optional().describe('可选目标生成节点；用于筛选适合该节点的参考素材，不会改变当前选择。'),
  source: z.enum(['canvas', 'library']).default('canvas'),
  query: z.string().max(10000).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});
const promptSetShape = (extra: Extra = {}) => z.strictObject({
  ...canvas, ...extra,
  nodeId: id,
  requestId,
  segments: z.array(promptSegmentSchema).min(1).max(200),
}).superRefine((args, ctx) => {
  const textLength = args.segments.reduce((total, segment) => total + (segment.type === 'text' ? segment.text.length : 0), 0);
  if (textLength > 200000) ctx.addIssue({ code: 'custom', path: ['segments'], message: '文字段总字符数不能超过 200000。' });
  if (args.segments.filter(segment => segment.type === 'reference').length > 32) ctx.addIssue({ code: 'custom', path: ['segments'], message: '引用段不能超过 32 个。' });
});
export const promptReferencesSchema = promptReferencesShape();
export const promptSetSchema = promptSetShape();

function result(value: unknown): CallToolResult {
  const payload = value !== null && typeof value === 'object' ? value as Record<string, unknown> : { value };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, ...(payload.ok === false ? { isError: true } : {}) };
}

/** With dual, every tool accepts 	arget to pick the desktop app or the Chrome page. */
export function createServer(service: CanvasService = new TapnowService(), options: { dual?: boolean } = {}) {
  const t: Extra = options.dual ? { target } : {};
  const c = { ...canvas, ...t };
  const server = new McpServer({ name: 'tapnow-canvas', version: '0.2.0' });
  function register<S extends z.ZodRawShape>(name: string, description: string, schema: z.ZodObject<S>, fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, readOnly = false, destructive = false) {
    server.registerTool(name, {
      description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: true },
    }, async (args) => {
      try { return result(await fn(args as z.infer<z.ZodObject<S>>)); }
      catch (error) { return result(errorResult(error)); }
    });
  }
  register('tapnow_diagnose', '只读诊断本机 Tapnow、调试连接、当前画布和适配器能力，不启动或重启应用。', z.strictObject(t), a => (service.diagnose as any)(a), true);
  register('tapnow_canvas_read', '读取当前画布 ID、节点、连线、选中项与保存状态。首次编辑前调用。', z.strictObject({ ...t, includeData: z.boolean().optional(), nodeIds: ids.optional() }), a => service.inspect(a), true);
  register('tapnow_canvas_edit', '使用应用自身编辑入口顺序执行批量操作，逐项报告结果。src 应使用已导入素材地址；本地文件使用素材导入工具。生成节点只配置参数，不付费提交。部分失败时先读取状态，不要更换 requestId 盲目重试。', z.strictObject({ ...c, requestId, operations: z.array(editOperationSchema).min(1).max(100) }), a => service.edit(a), false, true);
  register('tapnow_canvas_view', '调整画布视图，支持适配全部节点、聚焦指定节点或设置视口。', z.strictObject({ ...c, action: z.enum(['fit', 'focus', 'set']), nodeIds: ids.optional(), viewport: z.strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive().max(10) }).optional() }).refine(a => a.action !== 'set' || Boolean(a.viewport), 'set 需要 viewport').refine(a => a.action !== 'focus' || Boolean(a.nodeIds?.length), 'focus 需要 nodeIds'), a => service.view(a));
  register('tapnow_asset_import', '创建媒体节点。本地绝对路径走应用上传，视频最大 500 MiB，其他媒体最大 50 MiB；应用自身限制仍适用。大视频分块传输，客户端应允许至少 10 分钟调用时间。HTTP(S) URL 直接引用远程素材，不重新上传。path 与 url 恰好提供一个。', z.strictObject({ ...c, requestId, path: z.string().min(1).max(32000).optional(), url: httpUrl.max(20000).optional(), kind: z.enum(['image', 'video', 'audio']).optional(), position: position.optional() }).refine(a => Boolean(a.path) !== Boolean(a.url), 'path 与 url 必须且只能提供一个'), a => service.importAsset(a));
  register('tapnow_prompt_references', '只读查询原生 @素材 候选，不选择节点或打开面板。source=canvas 返回当前画布素材的 nodeId；source=library 返回当前账号可读单素材的 assetId，旧模板包不支持。支持 query、limit、offset 分页；可提供目标 nodeId 筛选可引用素材。', promptReferencesShape(t), a => service.promptReferences(a), true);
  register('tapnow_prompt_set', '按 text/reference 段整体替换生成节点提示词并插入原生 @素材 引用。canvas 引用自动建立素材到目标节点的连线；element 引用校验 Element 后由原生编码器生成引用；library 引用由原生素材库查询元数据并写入原生素材 token，不新增画布连线。替换提示词不会删除已有连线。library 仅支持当前账号可读单素材，不支持旧模板包。普通 @ 文字可放入 text；保留的原生模板 token（如 {{Asset:...}}、{{Image 1}}）必须使用 reference 段，禁止手写或传入 URL/token。最多 200 段、总文字 200000 字符、32 个引用段。仅配置提示词，不提交生成、不付费。', promptSetShape(t), a => service.promptSet(a));
  register('tapnow_generation_capabilities', '读取当前应用可用的生成类型、模型和参数，提交前应核对实际能力。', z.strictObject(t), a => (service.generationCapabilities as any)(a), true);
  register('tapnow_generation_prepare', '检查生成节点的模型、参数和就绪情况，会选择及聚焦该节点并打开原生生成面板，不提交任务、不消耗 Tapies。', z.strictObject({ ...c, nodeId: id }), a => service.generationPrepare(a));
  register('tapnow_generation_submit', '实际提交生成任务，会消耗 Tapies。仅在用户明确授权生成后调用。相同 requestId 不重复提交；超时或断线后先查询状态。', z.strictObject({ ...c, nodeId: id, requestId }), a => service.generationSubmit(a));
  register('tapnow_generation_status', '查询真实生成状态、错误与结果节点。提交超时后先使用原 requestId 查询，避免重复扣费。', z.strictObject({ ...c, nodeId: id, requestId: requestId.optional() }), a => service.generationStatus(a), true);
  register('tapnow_generation_history', '只读查询当前画布节点的历史生成批次、资源及原始参数。不恢复版本，不提交生成。', z.strictObject({...c,nodeId:id,limit:z.number().int().min(1).max(100).default(20)}),a=>service.generationHistory(a),true);
  register('tapnow_history_restore','从节点最近 100 条原生生成历史中选择批次资源恢复，或复制为新素材节点。只接受历史身份，不接受任意资源地址；不提交生成。',z.strictObject({...c,requestId,nodeId:id,historyId:id,resourceId:id.optional(),resourceIndex:z.number().int().min(0).max(100).default(0),mode:z.enum(['replace','copy']).default('replace'),restoreParameters:z.boolean().default(true),position:position.optional()}),a=>service.historyRestore(a),false,true);
  register('tapnow_image_tools','图片工具：inspect 查询入口；prepare 检查像素处理方案或打开原生多角度/打光/放大面板；execute 执行。crop/resize/split 生成新的 PNG 素材，不覆盖原图。settings 配置角度/灯光/放大参数；relight output=preview 免费导出本地预览，须等待原生导出按钮就绪。其他生成操作必须先获用户明确授权并传 allowPaid=true。',z.strictObject({...c,nodeId:id,phase:z.enum(['inspect','prepare','execute']),operation:z.enum(['crop','resize','split','upscale','cutout','multi_angle','relight']).optional(),requestId:requestId.optional(),allowPaid:z.boolean().default(false),rect:z.strictObject({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive(),height:z.number().int().positive()}).optional(),width:z.number().int().min(1).max(8192).optional(),height:z.number().int().min(1).max(8192).optional(),rows:z.number().int().min(2).max(8).optional(),cols:z.number().int().min(2).max(8).optional(),output:z.enum(['generate','preview']).default('generate'),settings:z.strictObject({rotation:z.number().min(-90).max(90).optional(),tilt:z.number().min(-1).max(1).optional(),zoom:z.number().min(0).max(10).optional(),wideAngleLens:z.boolean().optional(),azimuth:z.number().min(-180).max(180).optional(),elevation:z.number().min(-90).max(90).optional(),brightness:z.number().min(0).max(100).optional(),temperature:z.number().int().min(1000).max(12000).optional(),rimEnabled:z.boolean().optional(),scale:z.union([z.literal(2),z.literal(4),z.literal(6)]).optional(),style:z.enum(['general','low_resolution','animation_3d','high_fidelity','text_refine']).optional()}).optional()}).superRefine((a,ctx)=>{if(a.phase!=='inspect'){if(!a.requestId)ctx.addIssue({code:'custom',path:['requestId'],message:'写操作必须提供 requestId'});if(!a.operation)ctx.addIssue({code:'custom',path:['operation'],message:'请选择图片操作'});
      if(a.output==='preview'&&a.operation!=='relight')ctx.addIssue({code:'custom',path:['output'],message:'只有打光支持预览导出'});
      const allowed:Record<string,string[]>={multi_angle:['rotation','tilt','zoom','wideAngleLens'],relight:['azimuth','elevation','brightness','temperature','rimEnabled'],upscale:['scale','style']};
      for(const key of Object.keys(a.settings??{}))if(!allowed[a.operation??'']?.includes(key))ctx.addIssue({code:'custom',path:['settings',key],message:'该操作不支持此参数'});
    }}),a=>service.imageTools(a));
  register('tapnow_canvas_manage','跨画布管理：list 列出最近画布；create 创建私有画布；open 保存源画布后打开目标；copy_nodes 保存源画布并复制节点及内部连线到目标，保留源节点，完成后停留在目标。复制分组会包括后代，最多 100 个节点。',z.strictObject({...t,canvasId:id.optional(),requestId:requestId.optional(),action:z.enum(['list','create','open','copy_nodes']),destinationCanvasId:z.string().uuid().optional(),name:z.string().trim().min(1).max(200).optional(),description:z.string().max(2000).optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(20),nodeIds:z.array(id).min(1).max(100).optional(),position:position.optional()}).superRefine((a,ctx)=>{if(a.action!=='list')for(const k of ['canvasId','requestId'])if(!(a as any)[k])ctx.addIssue({code:'custom',path:[k],message:'缺少 '+k});for(const k of a.action==='create'?['name']:a.action==='open'?['destinationCanvasId']:a.action==='copy_nodes'?['destinationCanvasId','nodeIds']:[])if(!(a as any)[k])ctx.addIssue({code:'custom',path:[k],message:'缺少 '+k});}),a=>service.canvasManage(a));
  register('tapnow_elements','只读查询个人/团队素材库 Element 元素及成员素材。list 支持关键词和分页；get 查询单个元素。引用时将 elementId 交给 tapnow_prompt_set 的 source=element 段，由原生编码器生成引用。',z.strictObject({...c,action:z.enum(['list','get']).default('list'),space:z.enum(['personal','team']).default('personal'),query:z.string().max(200).optional(),page:z.number().int().min(1).max(10000).default(1),limit:z.number().int().min(1).max(100).default(20),elementId:z.string().regex(/^[1-9]\d{0,29}$/).optional()}).refine(a=>a.action!=='get'||!!a.elementId,'get 需要 elementId'),a=>service.elements(a),true);
  register('tapnow_generation_control','任务控制：list/progress 查询真实任务状态；cancel 仅调用应用暴露的该任务 stop 回调，不伪造取消状态；retry_prepare 准备失败任务重试；retry 经明确授权后提交。enqueue 创建持久化串行队列但不生成；queue_status 查询；queue_advance 经 allowPaid 授权后最多提交下一项，前项未结束不推进；queue_cancel 取消未提交项或请求原生取消。没有后台自动扣费循环。',z.strictObject({...c,action:z.enum(['list','progress','cancel','retry_prepare','retry','enqueue','queue_status','queue_advance','queue_cancel']),nodeId:id.optional(),activityId:id.optional(),nodeIds:z.array(id).min(1).max(32).optional(),queueId:z.string().regex(/^[a-f0-9]{32}$/).optional(),jobId:z.number().int().min(0).max(31).optional(),requestId:requestId.optional(),allowPaid:z.boolean().default(false)}).superRefine((a,ctx)=>{const fields=['cancel','retry_prepare','retry'].includes(a.action)?['nodeId','requestId']:a.action==='enqueue'?['nodeIds','requestId']:a.action==='queue_cancel'?['queueId','jobId','requestId']:a.action==='queue_advance'?['queueId','requestId']:a.action==='queue_status'?['queueId']:[];for(const k of fields)if((a as any)[k]===undefined)ctx.addIssue({code:'custom',path:[k],message:'缺少 '+k});}),a=>service.generationControl(a));
  register('tapnow_asset_download', '将指定节点的当前成果批量下载到本地绝对目录。支持文字及 Tapnow 官方域名托管的 HTTPS 图片、视频、音频；逐项返回结果，不覆盖已有文件。视频最大 500 MiB，其他媒体 50 MiB。相同 requestId 不重复下载。', z.strictObject({...c,nodeIds:z.array(id).min(1).max(100),directory:z.string().min(1).max(32000),requestId}),a=>service.assetDownload(a));
  register('tapnow_library', '管理素材库：folders 只读列文件夹；create_folder 创建文件夹（根目录 parentId=0）；rename_asset 重命名；move_asset 移动到指定空间文件夹；save_nodes 将有成果的画布节点归档到素材库。写操作必须有 requestId，不删除素材，不提交生成。', z.strictObject({...c,action:z.enum(['folders','create_folder','rename_asset','move_asset','save_nodes']),requestId:requestId.optional(),space:z.enum(['personal','team']).default('personal'),parentId:z.string().regex(/^\d{1,30}$/).optional(),folderId:z.string().regex(/^\d{1,30}$/).optional(),assetId:z.string().regex(/^\d{1,30}$/).optional(),name:z.string().trim().min(1).max(200).optional(),nodeIds:z.array(id).min(1).max(100).optional()}).superRefine((a,ctx)=>{
    const required=a.action==='create_folder'?['parentId','name']:a.action==='rename_asset'?['assetId','name']:a.action==='move_asset'?['assetId','folderId']:a.action==='save_nodes'?['folderId','nodeIds']:[];
    if(a.action!=='folders'&&!a.requestId)ctx.addIssue({code:'custom',path:['requestId'],message:'写操作必须提供 requestId'});
    for(const key of required)if(!(a as any)[key])ctx.addIssue({code:'custom',path:[key],message:'缺少 '+key});
  }),a=>service.libraryManage(a));
  register('tapnow_history', '调用应用撤销或重做；执行前核对当前画布 ID。', z.strictObject({ ...c, action: z.enum(['undo', 'redo']) }), a => service.history(a), false, true);
  register('tapnow_canvas_save', '请求应用保存当前画布并核查保存状态；仅界面更新不代表已持久化。', z.strictObject(c), a => service.save(a));
  server.registerTool('tapnow_canvas_screenshot', {
    description: '截取 Tapnow 当前页面；包含画布及应用界面。截图前核对画布 ID。',
    inputSchema: z.strictObject(c), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async args => {
    try {
      const shot = await service.screenshot(args);
      const { data: imageData, mimeType, ...metadata } = shot;
      return { content: [{ type: 'image' as const, data: imageData, mimeType }, { type: 'text' as const, text: JSON.stringify(metadata) }], structuredContent: metadata };
    } catch (error) { return result(errorResult(error)); }
  });
  return { server, service };
}

export async function main() {
  const dual = process.env.TAPNOW_TARGET === 'both';
  const implementation = dual ? await (await import('./dual.js')).createDualService()
    : process.env.TAPNOW_RESIDENT === '1' ? (await import('./resident.js')).createResidentService() : new TapnowService();
  const { server, service } = createServer(implementation, { dual });
  const shutdown = async () => { await service.close(); await server.close(); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.stdin.once('end', () => { void service.close(); });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = 1; });
}
