# Tapnow 当前画布 MCP

供本机 agent 通过标准 MCP `stdio` 操作 Tapnow 桌面端当前打开的画布。使用应用自己的编辑、上传、生成和保存入口，复用当前登录状态；不修改 Tapnow 安装文件。首个适配目标为 Windows / Tapnow 0.4.112。

## 安装与连接

需要 Node.js 22 或更新版本。在项目目录运行：

```powershell
npm ci
npm run build
```

先在 Tapnow 确认画布保存成功，并正常退出整个应用，然后在快捷方式“目标”的程序路径引号后添加：

```text
"C:\实际安装路径\Tapnow.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --enable-desktop-devtools
```

参数要在程序路径的引号外。已有实例通常会复用原进程，添加参数后应先正常退出再重新打开。`--enable-desktop-devtools` 是否生效取决于应用版本，连接是否成功以诊断结果为准。

也可以手动使用启动脚本：

```powershell
.\scripts\launch-tapnow.ps1 -AppPath 'C:\实际安装路径\Tapnow.exe'
npm run diagnose
```

脚本只监听 `127.0.0.1`。如果应用仍运行而调试接口不可用，脚本停止并提示正常退出，不会强杀或自动重启。MCP 服务只连接，不会自行启动应用。调试端口应仅供可信的本机程序访问。

在应用中打开目标画布。在项目目录运行 `npm run --silent config:claude`，自动生成适用于本机的通用 MCP JSON；Codex 使用 `npm run --silent config:codex`。生成器读取实际 Node.js 程序路径和项目位置，不依赖固定盘符、用户名或终端当前目录。将输出的服务合并到客户端配置中，保留已有服务。每台电脑都应分别生成；移动项目后应重新生成。`examples/` 仅展示结构，其中的 `REPLACE_WITH_PROJECT_DIRECTORY` 是占位符，不可直接使用。MCP 客户端启动 `dist/server.js`，不要把 `npm run diagnose` 当作 MCP 启动命令。

`TAPNOW_CDP_URL` 默认为 `http://127.0.0.1:9222`；若改端口，启动参数与客户端环境变量必须一致。`TAPNOW_STATE_DIR` 可指定本地请求记录目录（持久化生成请求的去重信息）。

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `tapnow_diagnose` | 连接、页面、画布与兼容能力诊断 |
| `tapnow_canvas_read` | 读取节点、连线、选中项及保存状态 |
| `tapnow_canvas_edit` | 批量创建、更新、删除、连线、选择、分组和布局 |
| `tapnow_canvas_view` | 适配、聚焦节点或设置视口 |
| `tapnow_asset_import` | 上传本地文件（最大 50 MiB），或直接引用远程 URL |
| `tapnow_prompt_references` | 只读查询画布或原生素材库中的 `@素材` 候选 |
| `tapnow_prompt_set` | 按文字与引用段替换提示词，写入原生 `@素材` 引用 |
| `tapnow_generation_capabilities` | 查询当前可用生成模型与参数 |
| `tapnow_generation_prepare` | 校验并选择、聚焦生成节点；不提交任务、不消耗 Tapies |
| `tapnow_generation_submit` | 实际提交生成任务，可能消耗余额 |
| `tapnow_generation_status` | 查询任务实际进度、错误和结果 |
| `tapnow_history` | 撤销或重做 |
| `tapnow_canvas_save` | 保存并核查保存状态 |
| `tapnow_canvas_screenshot` | 截取当前应用页面 |

工具不开放任意脚本执行。能力不匹配时返回结构化错误，不绕过应用保存机制修改数据。不同模型、节点类型和应用版本可能支持不同操作，以诊断和工具结果为准。

## 建议的 agent 操作顺序

1. 调用 `tapnow_diagnose` 和 `tapnow_canvas_read`，取得当前 `canvasId` 与节点 ID。
2. 编辑时传入该 `canvasId` 和唯一 `requestId`。同一请求重试必须复用原 ID；同一 ID 不能用于不同操作。
3. 检查批量操作每一项的结果。部分成功不是整体成功，先重新读取再决定后续操作。
4. 调用保存工具并检查保存状态。界面已更新与已确认保存分别报告，不能将前者视为持久化成功。
5. 生成前查询能力、配置节点并调用 `tapnow_generation_prepare`；它会选择、聚焦节点并打开原生生成面板，但不提交任务。只有得到用户明确生成授权才调用提交工具。断线或超时先用原请求 ID 查询状态，避免重复扣费。

所有写操作执行前再次核对当前画布。用户切换画布后，旧请求会停止；重新读取新画布后再操作。

原生撤销恢复已删除节点时，Tapnow 可能为节点重新分配 ID。后续操作必须使用 `tapnow_history` 返回的节点 ID，或重新读取画布后取得的新 ID。

批量文字节点示例：

```json
{
  "canvasId": "从读取工具取得",
  "requestId": "example-text-001",
  "operations": [
    { "op": "create", "kind": "text", "data": { "title": "构思", "text": "新项目灵感" }, "position": { "x": 100, "y": 100 } }
  ]
}
```

操作类型字段为 `op`。支持 `create`、`update`、`delete`、`connect`、`disconnect`、`select`、`layout`、`group` 和 `ungroup`。`update` 使用 `nodeId`；删除/选择/分组使用 `nodeIds`；断连使用 `edgeIds`。布局方向支持 `LR`、`TB`、`grid`。生成类型节点用 `mode: "generate"`，通过 `data.prompt`、`data.params` 设置内容，具体参数先查询生成能力。导入素材应使用导入工具，`data.src` 用于已有的素材地址。

音频节点的 `data.prompt` 会由适配层自动映射到 Tapnow 原生 `data.params.prompt`，调用方可以统一使用 `data.prompt`。

## 接入 Claude

先在项目目录执行 `npm ci` 和 `npm run build`，并保持 Tapnow 已使用本机 9222 调试端口启动且打开画布。

### Claude Desktop（Windows）

在项目目录执行以下命令，生成包含本机正确路径的配置：

```powershell
npm run --silent config:claude
```

在 Claude 的 Settings → Developer → Edit Config 中打开配置文件，通常位于 `%APPDATA%\Claude\claude_desktop_config.json`。将命令输出的 `tapnow-canvas` 服务合并到已有的 `mcpServers` 中，保留其他服务。生成命令仅输出配置，不修改客户端文件。

完全退出并重新打开 Claude Desktop。Claude 会启动 MCP 服务，无需另外运行 `npm start`。接入后先让 Claude 调用 `tapnow_diagnose` 和 `tapnow_canvas_read` 检查连接。

### Claude Code（本机 Windows）

在项目目录的 PowerShell 中运行以下命令，复制其输出的整行注册命令，再执行：

```powershell
npm run --silent config:claude-code
```

在 Claude Code 中输入 `/mcp` 查看连接状态。此服务使用本地 stdio，不能作为远程连接器 URL 直接添加到 Claude 网页版。

Codex 桌面版或 CLI：运行 `npm run --silent config:codex`，将输出合并到本机的 `~/.codex/config.toml`。这些输出中出现绝对路径是正常的：它们由各台电脑自动生成，保证客户端从任意工作目录启动时都能找到服务。

官方参考：[Claude Desktop 本地 MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)。

## 提示词中的 `@素材`

先使用 `tapnow_prompt_references` 查询候选。`source: "canvas"` 返回当前画布素材的 `nodeId` 和 `usable`；提供目标生成节点 `nodeId` 时，还返回 `connected`、`canConnect` 用于检查连接兼容性。`source: "library"` 查询当前账号可读的原生单素材，返回 `assetId`。旧版模板包暂不支持。查询支持 `query`、`limit` 和 `offset`；默认每页 50 条，最多 100 条。查询不选择节点、不打开面板。

查询画布素材的调用参数：

```json
{
  "canvasId": "从读取工具取得",
  "nodeId": "目标生成节点 ID",
  "source": "canvas",
  "query": "人物",
  "limit": 50,
  "offset": 0
}
```

再把返回的 ID 传给 `tapnow_prompt_set`。以下为参数模板，替换其中的 ID 后调用：

```json
{
  "canvasId": "从读取工具取得",
  "nodeId": "目标生成节点 ID",
  "requestId": "example-prompt-ref-001",
  "segments": [
    { "type": "text", "text": "参考人物 " },
    { "type": "reference", "source": "canvas", "nodeId": "画布人物素材节点 ID" },
    { "type": "text", "text": "，使用场景 " },
    { "type": "reference", "source": "library", "assetId": "原生素材库返回的素材 ID" },
    { "type": "text", "text": "，创作电影风格画面。" }
  ]
}
```

写入会整体替换该节点的提示词，并保留段落顺序。画布素材引用自动建立源素材到目标节点的连线；原生素材库引用使用应用自己的素材 token，不新增画布连线。替换提示词不会删除已有连线，如需清理连线，请单独调用画布编辑工具。此工具只配置提示词，不提交生成、不消耗 Tapies。

普通 `@文字` 可放入 `text` 段；原生保留模板（例如 `{{Asset:...}}`、`{{Image 1}}`）不能手写到文字段中，必须使用 `reference` 段由适配层构造。引用段只接受查询返回的 ID，不接受 URL、伪造 token 或素材元数据。单次允许 1–200 段，总文字最多 200000 字符，引用段最多 32 个；重试时复用原 `requestId`。

更新后需重新加载 MCP 服务，客户端才会发现这两个新增工具。素材库按个人、团队的顺序分页，后续查询使用返回的 `nextOffset`。修改提示词后，应检查返回的 `persistence.confirmed`；出现部分连线失败时先重新读取画布，再决定后续操作。

## 检查与故障定位

```powershell
npm run build
npm test
npm run diagnose
npx tsx scripts/mcp-smoke.ts
```

最后一项使用官方 MCP 客户端连接生产 `dist/server.js`，验证 14 个工具、诊断、读取、能力查询和 PNG 截图，不编辑画布、不选择节点、不提交付费任务。仅在 Tapnow 已连接并打开画布后运行。

脚本还检查只读工具拒绝未知 `eval` 字段，并在本地使用生产 schema 验证 `params` 拒绝 `Infinity`，以及提示词引用的段类型、上限、默认分页和未知字段，不调用写工具。使用 `npx tsx scripts/mcp-smoke.ts --schema-only` 可单独运行这些检查。

- 无法连接：检查应用是否启动、快捷方式参数、端口是否一致。浏览器访问 `http://127.0.0.1:9222/json/list` 应看到 Tapnow 页面。
- 主页面缺失或多个窗口：保留一个 Tapnow 主窗口，在其中打开画布，再诊断。
- 画布 ID 不匹配：用户已切换画布，先重新读取。
- 适配器不兼容：保存诊断错误与 Tapnow 版本，更新适配器。不要直接写入内部状态。
- 请求超时或连接中断：操作结果可能未知，先读取画布或查询生成状态。
- 保存失败：保持应用打开，检查网络、权限及应用提示。不要用“界面出现了节点”替代保存确认。

实际付费生成不属于默认验证；只有用户明确要求时才提交。构建、自动测试与真实画布验证的结果以本次交付记录为准。

详细实测结果、复现步骤及验证边界见 [VERIFICATION.md](VERIFICATION.md)。

已完成的真实应用验证包括本地图片、音频、视频上传，远程 URL 引用，刷新后的持久化，以及原生撤销、重做。
