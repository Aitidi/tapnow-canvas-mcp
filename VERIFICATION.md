# 验证记录

验证日期：2026-10-17；Windows、Tapnow Desktop 0.4.112、Node.js 24.13.1。

## 已通过

- TypeScript 构建，以及 74 项自动化测试。
- 官方 MCP 客户端通过真实 stdio 连接生产服务，发现 14 个工具，完成诊断、读取、能力查询和 PNG 截图。
- 独立的「MCP 开发验证」画布：创建和编辑文字、图片、视频、音频节点，连线、布局、分组、解除分组、删除、撤销、重做。
- 使用合成测试素材完成图片、音频、视频本地上传，以及远程素材 URL 引用。
- 应用原生保存返回确认；刷新并重新加载后，节点、连线、内容及素材地址保留。
- 四类生成节点的原生面板准备与参数读取；音频面板可读取预估价格及价格加载状态。
- 请求去重、不同参数冲突、未知结果不自动重提、多个服务互斥、画布切换保护及异常输入校验。
- 原生 `@素材`：画布引用自动补齐连线，同一素材多次内联不重复连线；素材库引用经过真实元数据读取及原生解析校验，不新增画布连线。
- 两种引用均在应用中显示原生素材标签，保存并刷新后仍能识别；素材库引用经原生生成参数展开后得到一张参考图，未提交模型任务。
- 素材库深分页、跨个人/团队分页、过滤后游标及分页过程中数据变化的模拟回归。
- 真实视频生成案例：ChatGPT 内置图片生成制作 3 张参考图，原生 `@素材` 关联到 Seedance 2.0 全能参考模式，10 秒、720p、16:9、关闭音频、单次生成。任务完成并回填画布；直接解析输出 MP4，时长 10.042 秒，仅有视频轨道，无音频轨道。记录保留在本机 `output/courier/result.json`。
- 多素材混排真实验证：2 张画布图片、1 个画布文字节点、1 张素材库图片，以及首图重复引用，共 5 个原生标签；刷新后顺序与内容一致，两张画布图片编号不同，仅保留 3 条输入连线，重复请求不重复执行。证据为 `artifacts/mentions-multi-verification.json` 和 `artifacts/mentions-multi.png`。

真实画布的详细结果和截图分别位于 `artifacts/verification.json`、`artifacts/live-extended.json` 和 `artifacts/live-canvas.png`。这些运行产物与请求账本不加入源码版本管理。

`@素材` 的额外证据：`artifacts/mentions-verification.json`、`artifacts/mentions-library-verification.json`、`artifacts/mentions-canvas.png`、`artifacts/mentions-library.png`。真实写入仅使用合成测试图；为验证素材库引用，在个人素材库创建了「MCP 素材引用验证」文件夹和合成参考图，测试节点位于独立的「MCP 开发验证」画布。

## 验证边界

已按用户要求提交并完成一次真实 Seedance 2.0 视频生成，确认任务完成和结果回填。没有单独核查账单明细；其他模型的实际生成尚未逐一测试。

当前实测为单机、单主窗口、普通非协作画布。协作历史入口有模拟测试，未在真实多人画布中测试。Tapnow 更新后如接口特征不再匹配，工具会返回不兼容诊断。

原生撤销恢复删除内容时可能分配新节点 ID；后续操作应使用历史工具的最新返回结果。默认读取时，未取得本次内容的原生保存确认会显示 `unknown`，可调用保存工具确认。

## 复现

常规检查不编辑画布：

```powershell
npm run build
npm test
npm run diagnose
npx tsx scripts/mcp-smoke.ts
npx tsx scripts/mcp-smoke.ts --schema-only
```

真实编辑测试必须使用独立的空测试画布；手动打开该画布，取得 ID 后运行：

```powershell
$env:TAPNOW_TEST_CANVAS_ID = '独立空测试画布的 ID'
npx tsx scripts/live-smoke.ts
npx tsx scripts/live-extended.ts
npx tsx scripts/live-history.ts
npx tsx scripts/live-mentions.ts
npx tsx scripts/live-library-mentions.ts
npx tsx scripts/live-multi-mentions.ts
```

这些脚本会创建、修改、删除测试内容并上传少量合成素材，不会调用生成提交工具。`live-smoke.ts` 拒绝对非空画布执行初始测试。
