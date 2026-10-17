import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { TapnowService } from './service.js';
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
]);
export const promptReferencesSchema = z.strictObject({
  ...canvas,
  nodeId: id.optional().describe('可选目标生成节点；用于筛选适合该节点的参考素材，不会改变当前选择。'),
  source: z.enum(['canvas', 'library']).default('canvas'),
  query: z.string().max(10000).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export const promptSetSchema = z.strictObject({
  ...canvas,
  nodeId: id,
  requestId,
  segments: z.array(promptSegmentSchema).min(1).max(200),
}).superRefine((args, ctx) => {
  const textLength = args.segments.reduce((total, segment) => total + (segment.type === 'text' ? segment.text.length : 0), 0);
  if (textLength > 200000) ctx.addIssue({ code: 'custom', path: ['segments'], message: '文字段总字符数不能超过 200000。' });
  if (args.segments.filter(segment => segment.type === 'reference').length > 32) ctx.addIssue({ code: 'custom', path: ['segments'], message: '引用段不能超过 32 个。' });
});

function result(value: unknown): CallToolResult {
  const payload = value !== null && typeof value === 'object' ? value as Record<string, unknown> : { value };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, ...(payload.ok === false ? { isError: true } : {}) };
}

export function createServer(service = new TapnowService()) {
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
  register('tapnow_diagnose', '只读诊断本机 Tapnow、调试连接、当前画布和适配器能力，不启动或重启应用。', z.strictObject({}), () => service.diagnose(), true);
  register('tapnow_canvas_read', '读取当前画布 ID、节点、连线、选中项与保存状态。首次编辑前调用。', z.strictObject({ includeData: z.boolean().optional(), nodeIds: ids.optional() }), a => service.inspect(a), true);
  register('tapnow_canvas_edit', '使用应用自身编辑入口顺序执行批量操作，逐项报告结果。src 应使用已导入素材地址；本地文件使用素材导入工具。生成节点只配置参数，不付费提交。部分失败时先读取状态，不要更换 requestId 盲目重试。', z.strictObject({ ...canvas, requestId, operations: z.array(editOperationSchema).min(1).max(100) }), a => service.edit(a), false, true);
  register('tapnow_canvas_view', '调整画布视图，支持适配全部节点、聚焦指定节点或设置视口。', z.strictObject({ ...canvas, action: z.enum(['fit', 'focus', 'set']), nodeIds: ids.optional(), viewport: z.strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive().max(10) }).optional() }).refine(a => a.action !== 'set' || Boolean(a.viewport), 'set 需要 viewport').refine(a => a.action !== 'focus' || Boolean(a.nodeIds?.length), 'focus 需要 nodeIds'), a => service.view(a));
  register('tapnow_asset_import', '创建媒体节点。本地绝对路径走应用上传，最大 50 MiB；HTTP(S) URL 直接引用远程素材，不重新上传。path 与 url 恰好提供一个。', z.strictObject({ ...canvas, requestId, path: z.string().min(1).max(32000).optional(), url: httpUrl.max(20000).optional(), kind: z.enum(['image', 'video', 'audio']).optional(), position: position.optional() }).refine(a => Boolean(a.path) !== Boolean(a.url), 'path 与 url 必须且只能提供一个'), a => service.importAsset(a));
  register('tapnow_prompt_references', '只读查询原生 @素材 候选，不选择节点或打开面板。source=canvas 返回当前画布素材的 nodeId；source=library 返回当前账号可读单素材的 assetId，旧模板包不支持。支持 query、limit、offset 分页；可提供目标 nodeId 筛选可引用素材。', promptReferencesSchema, a => service.promptReferences(a), true);
  register('tapnow_prompt_set', '按 text/reference 段整体替换生成节点提示词并插入原生 @素材 引用。canvas 引用自动建立素材到目标节点的连线；library 引用由原生素材库查询元数据并写入原生素材 token，不新增画布连线。替换提示词不会删除已有连线。library 仅支持当前账号可读单素材，不支持旧模板包。普通 @ 文字可放入 text；保留的原生模板 token（如 {{Asset:...}}、{{Image 1}}）必须使用 reference 段，禁止手写或传入 URL/token。最多 200 段、总文字 200000 字符、32 个引用段。仅配置提示词，不提交生成、不付费。', promptSetSchema, a => service.promptSet(a));
  register('tapnow_generation_capabilities', '读取当前应用可用的生成类型、模型和参数，提交前应核对实际能力。', z.strictObject({}), () => service.generationCapabilities(), true);
  register('tapnow_generation_prepare', '检查生成节点的模型、参数和就绪情况，会选择及聚焦该节点并打开原生生成面板，不提交任务、不消耗 Tapies。', z.strictObject({ ...canvas, nodeId: id }), a => service.generationPrepare(a));
  register('tapnow_generation_submit', '实际提交生成任务，会消耗 Tapies。仅在用户明确授权生成后调用。相同 requestId 不重复提交；超时或断线后先查询状态。', z.strictObject({ ...canvas, nodeId: id, requestId }), a => service.generationSubmit(a));
  register('tapnow_generation_status', '查询真实生成状态、错误与结果节点。提交超时后先使用原 requestId 查询，避免重复扣费。', z.strictObject({ ...canvas, nodeId: id, requestId: requestId.optional() }), a => service.generationStatus(a), true);
  register('tapnow_history', '调用应用撤销或重做；执行前核对当前画布 ID。', z.strictObject({ ...canvas, action: z.enum(['undo', 'redo']) }), a => service.history(a), false, true);
  register('tapnow_canvas_save', '请求应用保存当前画布并核查保存状态；仅界面更新不代表已持久化。', z.strictObject(canvas), a => service.save(a));
  server.registerTool('tapnow_canvas_screenshot', {
    description: '截取 Tapnow 当前页面；包含画布及应用界面。截图前核对画布 ID。',
    inputSchema: z.strictObject(canvas), annotations: { readOnlyHint: true, openWorldHint: false },
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
  const { server, service } = createServer();
  const shutdown = async () => { await service.close(); await server.close(); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.stdin.once('end', () => { void service.close(); });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = 1; });
}
