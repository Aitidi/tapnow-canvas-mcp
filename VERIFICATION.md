# 验证记录

验证日期：2026-10-17；Windows、Tapnow Desktop 0.4.112、Node.js 24.13.1。

## 网页端实验适配（2026-10-19）

- 已查看 Chrome 中的官方 Tapnow 空白画布，确认存在 React 根节点、原生画布 DOM 标识，以及官方 CDN 中的 `vendor-pkg-canvas`、`vendor-packages` 模块。
- 增加显式网页目标模式、本机浏览器 WebSocket/Chrome 调试端口发现、Target 选择与独立 session 路由；保留默认桌面端模式。
- 原生模块发现支持当前网页 CDN 的版本目录；排除同名前缀的 3D、world 等附加包，仅加载精确匹配的已暴露能力包。
- TypeScript 构建通过，89 项自动化测试通过，真实 stdio MCP 工具发现与 schema 检查通过。新增测试覆盖官方域名限制、浏览器会话路由、多标签歧义、CDN 包选择、文字/音频菜单回退、私有函数引用筛选、素材实体归一化及刷新后的连线去重。
- 用户手动启用 Chrome 调试访问后，真实诊断成功：`desktop:false`，读取到原生画布、编辑、视口、保存和上传入口。
- 在用户提供的空画布上，通过原生添加菜单创建文字节点、调用原生编辑入口修改内容与尺寸、取得原生保存确认。刷新后比对节点 ID、完整 data、位置、宽度和高度一致。
- 删除一次试验留下的空白文字节点，当前仅保留一个「网页 MCP 验证成功」节点；视口适配与 PNG 截图通过。创建文字节点保留网页的默认生成模式和默认模型，但没有提交生成任务。
- 连续检查改为复用一个调试连接，避免每启动一个诊断进程就触发一次 Chrome 授权。页面刷新后曾短暂调试超时，恢复后已重新读取并完成持久化比对，未重复创建节点。

网页证据保存在本机 `artifacts/web-diagnose.json`、`artifacts/web-create.json`、`artifacts/web-update.json`、`artifacts/web-before-reload.json`、`artifacts/web-after-reload.json`、`artifacts/web-final-edit.json` 和 `artifacts/web-canvas.png`，运行产物不加入版本管理。

后续适配已补齐 `@素材` 与音频创建：通过本机调试接口读取官方画布包的 Module 作用域，只转移经过特征筛选的原生函数引用，跳过 Global、Closure 和普通状态；随后由原适配器再次识别能力，临时引用与调试句柄完成后释放。修正了误把关系 schema 解析器当作素材实体归一化函数的问题，保留原始素材 ID。

### 网页多素材、音频与连线实测

- 官方 MCP SDK 客户端连接生产 `createServer`，通过进程内协议传输调用真实工具；复用现有 Chrome 调试连接。此项验证包含真实工具分发、schema、服务层、原生适配器及网页保存，不宣称使用 stdio 进行了这些读写。
- 音频：使用原生工厂指定 `music-2.6` 创建音频节点，确认提示词在 `params.prompt`，保留原生场景和参数；刷新后模型、提示词和尺寸保留。另验证原生菜单回退创建及音频生成面板准备，没有提交任务。
- 素材：使用合成青色/红色图片和静音 WAV 完成原生上传；在个人素材库创建「MCP 网页多素材验证」文件夹与合成参考图，使用真实搜索和详情入口读取素材。
- 多素材：Seedance 2.0 全能参考节点混排两张画布图片、一个文字节点、一段音频和一张素材库图片，首图再次引用，共 5 种不同素材、6 个内联标签。图片编号分别为 Image 1、Image 2，重复首图仍使用 Image 1。
- 连线：4 个画布来源只产生 4 条输入连线，素材库引用没有新增边；重复请求通过账本重放，断开并重连成功，再次连接返回原边，自连接明确拒绝。
- 刷新：逐一比较 7 个节点的关键数据、模型参数、内容、尺寸与 5 条连线（其中 4 条输入视频节点），全部保留；位置按应用原生两位小数精度比较。重新打开面板后，原生编辑器的 6 个标签 ID 与顺序完全一致。
- 修复刷新后连线端口被原生归一化为 `right/left` 时，省略端口的重复连接无法匹配旧边的问题；真实刷新后再次连接仍返回 `existing:true`。

详细证据：`artifacts/web-features-verification.json`、`artifacts/web-multi-final-written.json`、`artifacts/web-multi-replay.json`、`artifacts/web-multi-chips-after-reload.json`、`artifacts/web-features-before-reload.json`、`artifacts/web-features-after-reload.json`、`artifacts/web-native-audio-create.json`、`artifacts/web-link-disconnect.json`、`artifacts/web-link-reconnect.json` 和 `artifacts/web-link-after-reload-dedup.json`；截图为 `artifacts/web-multi-mentions.png`。

### 网页非生成功能补测（真实 stdio）

- 官方 SDK `Client` → `StdioClientTransport` → 构建后的 `dist/server.js` → 真实网页。没有替换服务层或适配器；全部阶段复用同一服务进程和 Chrome 调试连接。
- 撤销/重做：创建临时纯文字节点并删除，原生撤销恢复内容，重做再次删除；恢复分配新 ID，前后节点和连线数量回到初始状态，保存确认通过。
- 分组/解除分组：创建 3 个纯文字节点和 2 条连线，核对分组后父节点 ID 与相对坐标，确认绝对位置不变；解除分组后恢复原位置并移除容器。
- 布局：对这 3 个测试节点分别执行 `grid`、`LR`、`TB`，检查网格行列及连线方向上的位置顺序；最终保留网格布局和分组供页面查看。
- 媒体：合成 WebM 经原生上传器导入，远程图片使用既有合成图片 URL 直接引用。保存刷新后地址保留。打开原生视频预览可显示青色画面，解码就绪状态为 4，视频尺寸 64×64；原始视频和应用播放变体的时长分别约 0.401 秒、0.558 秒。该素材的 `display_hd`、`thumbnail` 服务端变体虽返回 200，却均为空文件，未将缩略图渲染计为通过。
- 正式工具覆盖：14 个工具中，除 `tapnow_generation_submit` 外的 13 个均完成真实网页调用，包括素材库查询、6 标签提示词写入、四类节点原生面板准备及任务状态读取。面板入口均能识别；文字节点当前缺少输入，音频首次准备时价格仍在加载，不宣称各节点已具备提交条件。
- 保存和刷新：逐一比较 13 个节点的 ID、类型、完整 data、尺寸、位置（两位小数）和分组关系，以及 7 条连线的 ID 与端点，全部一致。原有 7 个测试节点保留；新增的分组、3 个文字、视频与远程图片用于展示补测结果。

补测证据为 `artifacts/web-parity-verification.json`、`artifacts/web-stdio-diagnose.json`、`artifacts/web-stdio-history-*.json`、`artifacts/web-stdio-group*.json`、`artifacts/web-stdio-ungroup*.json`、`artifacts/web-stdio-layout-*.json`、`artifacts/web-stdio-video-upload.json`、`artifacts/web-stdio-remote-import.json`、`artifacts/web-stdio-before-reload.json`、`artifacts/web-stdio-after-reload.json`、`artifacts/web-stdio-prompt-set.json`、`artifacts/web-stdio-library-references.json`、`artifacts/web-stdio-prepare-*.json` 和 `artifacts/web-stdio-status-*.json`；截图为 `artifacts/web-parity.png`、`artifacts/web-parity-video-preview.png` 和 `artifacts/web-parity-final.png`。

边界：本节按用户要求进行非生成补测，没有提交付费任务；后续网页真实生成见「Seedance 2.5 全能参考生成」。多素材标签和连线通过不等于所有模型的实际生成任务均已通过；不同模型的引用限制仍由原生面板决定。真实多人协作仍未实测；合成视频的服务端缩略图存在上述问题。

### 用户提供的真实 MP4 上传测试

- 经用户明确指定，将桌面 MP4 原文件上传至同一网页测试画布。文件大小 74,569,291 字节（约 71.11 MiB），超过原 MCP 50 MiB 上限。
- 本地视频上限扩展至 500 MiB，超过 50 MiB 时按 2 MiB 分块送入页面，完整到达后仅调用一次原生上传器。上传前不压缩或转码；两遍流式内容哈希核对，文件中途变化则停止。其他媒体仍保持原 50 MiB 上限，应用自身限制仍适用。
- 正式 stdio MCP 上传返回原生保存确认，原始素材地址返回 `video/mp4`，长度与本地文件相同。原生预览读取到 1920×1080、38.471771 秒、解码就绪状态 4；随后确认播放到结尾且无解码错误。
- 此真实 MP4 的服务端缩略图正常生成，刷新后页面缩略图实际解码为 1920×1080；此前极短合成 WebM 的空缩略图问题未在该 MP4 上复现。
- 修正分块上传时节点名称丢失的问题，并将本次已创建节点通过原生编辑恢复原文件名。保存刷新后完整 data、名称、地址、位置和尺寸一致；画布从 13 个节点增加至 14 个，原有节点与 7 条连线保留。同请求再次调用返回 `replayed:true`，没有再次上传或创建节点。
- 构建通过，95 项自动化测试通过，正式 stdio 工具 schema 检查通过。新增回归覆盖分块完整性、乱序/超量/跨画布拒绝、中断清理、请求去重、大小上限、传输期间文件变化及原文件名保留。未进行付费生成。

证据保存在本机 `artifacts/user-video-upload.json`、`artifacts/user-video-before-reload.json`、`artifacts/user-video-after-reload.json`、`artifacts/user-video-replay.json` 和 `artifacts/user-video-verification.json`；截图为 `artifacts/user-video-upload.png`。上传内容及运行证据不加入源码版本管理。

### 常驻 Chrome 连接

- 增加独立后台进程保管 `TapnowService` 和 Chrome WebSocket，stdio MCP 入口在 `TAPNOW_RESIDENT=1` 时通过认证的本机 IPC 转发原有 14 个服务方法；代理退出不会关闭后台连接，不增加任意执行入口或网络监听端口。
- 增加后台启动、状态和停止命令，以及网页常驻客户端配置生成。状态查询不访问浏览器；并发启动只允许一个后台进程监听同一管道；写入失败或连接中断不自动重放；停止时等待在途操作结束。
- 构建和 99 项自动化测试通过。新增验证覆盖认证失败、固定方法白名单、错误传播、代理关闭不影响后台、并发启动和两个真实 stdio 客户端退出后的后台复用。
- 真实 Chrome 验证：后台 PID 为 8012；两个独立 MCP 客户端先后读取画布并退出后，后台 PID、启动时间和 Chrome 目标一致。操作系统核对 Chrome TCP 连接的本地/远程端口及所属进程完全相同，确认并非重新连接到相同页面。画布保留 14 个节点和 7 条连线，测试仅只读。
- `diagnose:web` 也已确认复用该后台服务。用户 Codex 配置添加 `tapnow_canvas` 常驻入口，保留所有其他配置，并在本机保留修改前备份；没有调整工具审批策略或 Chrome 安全设置。

后台连接在验收结束后继续运行。首次建立连接、Chrome 重启或连接中断后的重连仍可能要求授权；未注册操作系统开机自启。此项不会消除 Chrome 自身的授权机制。

真实证据：`artifacts/resident-verification.json`、`artifacts/resident-socket-before.json` 和 `artifacts/resident-socket-after.json`。可运行 `npm run verify:resident` 复现只读客户端切换验证。

### Seedance 2.5 全能参考生成

- 用户明确授权使用所提供图片，在当前网页画布生成 Seedance 2.5、5 秒视频；随后将模式改为全能参考。改模式前没有提交生成。
- 当前画布为 `34f91421-a208-4ad4-b12e-f7485ee7d43a`，起始为空。原图经原生上传器导入，创建视频节点，将图片写成原生 `@素材` 标签并复用唯一输入连线。
- 原生面板确认 Seedance 2.5、全能参考、5 秒、720p、16:9、关闭音频、单次生成；提示词为天宫门廊缓慢前推、云海薄雾流动和轻微衣袂运动。面板显示预估 200 Tapies，完成后余额显示由 867 变为 667。
- 经常驻服务和正式 stdio MCP 只提交一次。任务 ID 为 `a0316bd9-36cf-4da0-9fde-2d063204255a`，约 3 分钟后完成并回填原节点；等待期间仅查询同一任务。
- 解析真实输出 MP4 的容器和轨道：4,094,992 字节，时长 5.042 秒，1280×720，H.264（`avc1`），仅一个视频轨道，无音频轨道。取得原生保存确认，画布保留 2 个节点和 1 条连线。
- 此项补齐网页实际生成提交到结果回填的验证，不代表其他模型或所有参数组合已通过。

证据：`artifacts/seedance25-reference-prompt.json`、`artifacts/seedance25-reference-prepare.json`、`artifacts/seedance25-reference-before-submit.png`、`artifacts/seedance25-submit.json`、`artifacts/seedance25-timeline.json`、`artifacts/seedance25-status.json`、`artifacts/seedance25-final-save.json`、`output/seedance25-palace/manifest.json`、`output/seedance25-palace/result.json` 和 `output/seedance25-palace/canvas.png`。生成内容和运行产物不加入源码版本管理。

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
