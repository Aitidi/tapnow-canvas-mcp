# Tapnow 画布操作 MCP

让 Claude、Codex 和其他支持本地 MCP 的 agent 操作你在 **Tapnow 桌面端（APP）** 或 **Chrome 网页端** 中打开的画布。

这是一个本地 stdio MCP 服务：通过 Chrome DevTools Protocol（CDP）连接本机的 Tapnow Desktop（Electron）或 Chrome，复用当前登录状态，调用应用自身的编辑、上传、生成与保存入口。它不修改应用安装文件，不读取登录凭据，也不向 agent 开放任意脚本执行。

> 当前版本 0.2.0。在 Windows、Tapnow Desktop 0.4.112、Chrome 网页端、Node.js 24 上实测；构建和 104 项自动化测试通过。Tapnow 更新可能影响兼容性，其他操作系统尚未实测。

## 能做什么

- **画布编辑**：读取节点和连线，创建与编辑文字、媒体生成节点，移动、缩放、删除、连线、分组和布局。
- **素材导入**：导入本地图片、视频、音频，或引用 HTTP(S) 地址。本地视频最大 500 MiB，其他媒体最大 50 MiB，应用自身限制仍适用。
- **提示词 `@素材`**：混排文字与原生素材引用，支持画布素材、素材库素材、多素材和重复引用。
- **生成**：查询可用模型与参数，准备、提交生成任务，查询状态与结果。
- **保存与历史**：原生保存并核对保存确认，撤销、重做，截图。
- **双端模式**：一个服务同时连接 APP 端和网页端，每次调用用 `target` 指定操作哪一端。
- **常驻连接**：后台进程保管 Chrome 连接，多个 MCP 客户端先后复用，减少 Chrome 的授权弹窗。

## 选择连接方式

| 场景 | `TAPNOW_TARGET` | 你需要准备 |
| --- | --- | --- |
| 只用 APP 端 | `desktop`（默认） | 用调试端口启动 Tapnow 桌面端 |
| 只用网页端 | `web` | Chrome 开启远程调试，启用常驻服务 |
| 两端都用 | `both` | 以上两项；APP 端改用 9333 端口 |

**端口建议**：Chrome 在 `chrome://inspect` 中开启远程调试时，默认也占用 9222 端口，先启动的一方会占住端口。因此本文统一让 APP 端使用 **9333**。代码中 APP 端的默认地址仍是 `http://127.0.0.1:9222`，按下文设置环境变量即可改为 9333；双端配置生成器已默认使用 9333。

## 快速开始

以下命令在 Windows PowerShell 中执行。需要 Node.js 22 或更新版本，克隆源码时还需要 Git。

### 1. 下载并构建

```powershell
git clone https://github.com/Aitidi/tapnow-canvas-mcp.git
cd tapnow-canvas-mcp
npm ci
npm run build
```

也可以下载源码 ZIP，解压后在项目目录执行后两条命令。目前只提供源码安装。

### 2. 准备 APP 端（只用网页端可跳过）

先在 Tapnow 中确认画布已保存，然后**完全退出**应用。在 Tapnow 快捷方式的“目标”中，程序路径引号外加上调试参数：

```text
"C:\实际安装路径\Tapnow.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333 --enable-desktop-devtools
```

从这个快捷方式重新启动 Tapnow，打开目标画布。如果应用还在后台运行，再次点击快捷方式会复用旧进程，端口不会生效。

也可以在应用已退出时用启动脚本：

```powershell
npm run launch -- -Port 9333
npm run launch -- -Port 9333 -AppPath 'C:\实际安装路径\Tapnow.exe'
```

脚本会自动查找常见安装位置，找不到时用 `-AppPath` 指定。它不会强制结束正在运行的 Tapnow；MCP 服务本身也只连接，不会启动应用。

检查连接：

```powershell
$env:TAPNOW_CDP_URL = 'http://127.0.0.1:9333'
npm run diagnose
```

确认诊断结果中的画布就是你希望 agent 操作的那个。

### 3. 准备网页端（只用 APP 端可跳过）

网页端只识别 `https://app.tapnow.ai/canvas/<画布 UUID>`，需要 Chrome 144 或更新版本，无需重启浏览器：

1. 打开 `chrome://inspect/#remote-debugging`，启用远程调试。
2. 登录 Tapnow，打开一个目标网页画布。
3. 启动常驻服务。Chrome 弹出调试连接提示时，由你手动允许：

```powershell
npm run resident:start
npm run resident:status
npm run diagnose:web
```

常驻服务保管这条 Chrome 连接，之后的 MCP 客户端都复用它，不必每次重新授权。详见下文 [常驻服务](#常驻服务)。

### 4. 生成客户端配置

配置生成器自动填入本机 Node.js 和项目的绝对路径，**只输出内容，不修改任何客户端文件**。每台电脑分别生成；移动项目或更换 Node 后需要重新生成。`examples/` 里的文件只展示结构，占位符不能直接使用。

| 场景 | Codex（TOML） | Claude Desktop / 其他客户端（JSON） | Claude Code（注册命令） |
| --- | --- | --- | --- |
| 只用 APP 端 | `npm run --silent config:codex` | `npm run --silent config:claude` | `npm run --silent config:claude-code` |
| 只用网页端 | `npm run --silent config:codex:web` | `node scripts/print-config.mjs json --web-resident` | `node scripts/print-config.mjs claude-code --web-resident` |
| 两端都用 | `npm run --silent config:codex:both` | `node scripts/print-config.mjs json --both` | `node scripts/print-config.mjs claude-code --both` |

只用 APP 端时，生成器读取 `TAPNOW_CDP_URL`，所以请在同一个 PowerShell 窗口先执行第 2 步的 `$env:TAPNOW_CDP_URL = 'http://127.0.0.1:9333'`，否则输出的是 9222。

双端配置的输出内容为：

```text
TAPNOW_TARGET=both
TAPNOW_DESKTOP_CDP_URL=http://127.0.0.1:9333
TAPNOW_WEB_CDP_URL=chrome
TAPNOW_RESIDENT=1
```

如需其他端口，生成前设置同名环境变量即可覆盖。

### 5. 接入客户端

**Claude Desktop**：打开 **Settings → Developer → Edit Config**（Windows 通常是 `%APPDATA%\Claude\claude_desktop_config.json`），把输出中的 `tapnow-canvas` 合并进已有的 `mcpServers`，保留其他服务，然后完全退出并重新打开 Claude Desktop。

**Codex 桌面版 / CLI**：把 TOML 输出合并到 `%USERPROFILE%\.codex\config.toml`（设置了 `CODEX_HOME` 时用该目录下的文件），保存后重新加载 MCP。生成的配置已设置 `tool_timeout_sec = 660`，以便大视频上传。

**Claude Code**：在 PowerShell 中执行输出的整行 `claude mcp add` 命令，进入 Claude Code 后用 `/mcp` 查看状态。

**其他 agent**：用 JSON 输出中的 `command`、`args`、`env` 创建一个 **stdio** MCP 服务。

客户端会自己启动 MCP 服务，不需要另外运行 `npm start`，也不要把 `npm run diagnose` 当作启动命令。本服务没有远程 HTTP 接口，不能作为 URL 连接器添加到 ChatGPT 或 Claude 网页版。

接入后可以先对 agent 说：

> 使用 Tapnow MCP 检查连接并读取当前画布，先不要修改内容。

参考文档：[Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)、[Claude Code](https://code.claude.com/docs/en/mcp)、[Codex](https://developers.openai.com/codex/mcp)。

## 双端模式

`TAPNOW_TARGET=both` 时，一个 MCP 服务同时管理 APP 端和网页端两条连接，每个工具多一个可选参数 `target`：

| `target` | 行为 |
| --- | --- |
| `app` | 只操作 APP 端（`TAPNOW_DESKTOP_CDP_URL`） |
| `web` | 只操作网页端（`TAPNOW_WEB_CDP_URL`；`TAPNOW_RESIDENT=1` 时经常驻服务） |
| `auto`（默认） | 两端都检查。只有一端打开了画布时自动选它；传了 `canvasId` 时按画布 ID 匹配 |

- 两端都打开了可用画布时，`auto` 返回 `AMBIGUOUS_TARGET`，不会猜测，请指定 `app` 或 `web`。
- 两端都没有画布时返回 `NOT_CONNECTED`；指定的 `canvasId` 两端都找不到时返回 `CANVAS_NOT_FOUND`。
- `tapnow_diagnose` 不指定 `target` 时同时报告两端，一端连不上不影响另一端。
- 其他工具的返回结果带 `target` 字段，标明实际操作的是哪一端。明确指定 `target` 可以省去对另一端的检查。

命令行检查双端（APP 端默认地址是 9222，需先指定 9333；网页常驻服务在运行时会自动复用）：

```powershell
$env:TAPNOW_DESKTOP_CDP_URL = 'http://127.0.0.1:9333'
npm run diagnose:both
```

## 工具列表

共 14 个工具。双端模式下，每个工具都接受 `target` 参数。

| 工具 | 用途 |
| --- | --- |
| `tapnow_diagnose` | 只读检查连接、页面、画布及原生入口 |
| `tapnow_canvas_read` | 读取画布 ID、节点、连线、选中项与保存状态 |
| `tapnow_canvas_edit` | 批量创建、更新、删除、连线、选择、分组及布局 |
| `tapnow_canvas_view` | 适配全部节点、聚焦指定节点或设置视口 |
| `tapnow_asset_import` | 导入本地文件或引用 HTTP(S) 素材地址 |
| `tapnow_prompt_references` | 只读查询画布或素材库中可引用的素材 |
| `tapnow_prompt_set` | 整体替换提示词并插入原生 `@素材` 引用 |
| `tapnow_generation_capabilities` | 查询当前可用的模型与参数 |
| `tapnow_generation_prepare` | 打开原生生成面板检查就绪情况，不提交任务 |
| `tapnow_generation_submit` | 实际提交生成任务，**会消耗 Tapies** |
| `tapnow_generation_status` | 查询任务状态、错误与结果 |
| `tapnow_history` | 撤销或重做 |
| `tapnow_canvas_save` | 请求保存并核对保存确认 |
| `tapnow_canvas_screenshot` | 截取当前页面，包含画布与界面 |

## 使用约定

1. **先读再写**：先诊断、读取，拿到当前 `canvasId` 和节点 ID。写操作会再次核对画布；切换画布后要重新读取。
2. **看逐项结果**：批量编辑可能部分成功。失败后先读取实际画布，不要整批重做。
3. **保留 `requestId`**：编辑、导入、提示词写入和生成提交都用唯一的 `requestId`。重试同一请求时复用原 ID，参数改变后不能复用。
4. **以保存确认为准**：界面更新不等于已持久化。读取结果中的 `unknown` 表示当前内容还没有保存确认，可调用保存工具核对。
5. **生成前核对参数**：先查能力，再配置节点，调用准备工具。切换模型或模式可能重置默认值，要核对最终的模型、模式、时长、音频和数量。只有用户明确授权后才提交。
6. **超时先核查**：超时或断线时操作可能已经执行。先读取画布，或用原 `requestId` 查询生成状态，避免重复提交和重复扣费。

撤销恢复已删除的节点时，Tapnow 可能分配新的节点 ID，后续请使用历史工具返回的 ID 或重新读取。

超过 50 MiB 的本地视频按 2 MiB 分块传入页面再交给原生上传器，不压缩、不转码，传输前后核对哈希，文件中途变化会停止上传。超时后先读取画布，不要换 `requestId` 重传。

### 画布编辑示例

```json
{
  "canvasId": "当前画布 ID",
  "requestId": "example-text-001",
  "operations": [
    {
      "op": "create",
      "kind": "text",
      "data": { "title": "构思", "text": "新项目灵感" },
      "position": { "x": 100, "y": 100 }
    }
  ]
}
```

`op` 支持 `create`、`update`、`delete`、`connect`、`disconnect`、`select`、`layout`、`group`、`ungroup`。更新用 `nodeId`；删除、选择、分组用 `nodeIds`；断开连线用 `edgeIds`。布局方向支持 `LR`、`TB`、`grid`。单次最多 100 个操作。

生成节点使用 `mode: "generate"`，通过 `data.prompt`、`data.params` 配置；音频节点的 `data.prompt` 会映射到原生 `data.params.prompt`。本地文件请用素材导入工具，`data.src` 只用于已有的素材地址。

### 提示词中的 `@素材`

先用 `tapnow_prompt_references` 查询，再把返回的 ID 交给 `tapnow_prompt_set`：

| 来源 | 查询参数 | 引用标识 | 写入行为 |
| --- | --- | --- | --- |
| 当前画布 | `source: "canvas"` | `nodeId` | 自动补齐素材到目标节点的连线 |
| 素材库 | `source: "library"` | `assetId` | 写入原生素材 token，不新增画布连线 |

查询支持 `query`、`limit`、`offset`（默认每页 50 条，最多 100 条），用返回的 `nextOffset` 翻页。提供目标节点 `nodeId` 时，画布候选还会返回 `connected` 和 `canConnect`。素材库按个人、团队顺序分页，暂不支持旧版模板包。

```json
{
  "canvasId": "当前画布 ID",
  "nodeId": "目标生成节点 ID",
  "requestId": "example-prompt-ref-001",
  "segments": [
    { "type": "text", "text": "参考人物 " },
    { "type": "reference", "source": "canvas", "nodeId": "画布素材节点 ID" },
    { "type": "text", "text": "，使用场景 " },
    { "type": "reference", "source": "library", "assetId": "素材库素材 ID" },
    { "type": "text", "text": "，创作电影风格画面。" }
  ]
}
```

- 写入会**整体替换**提示词，保留片段顺序；同一画布素材重复引用不会重复连线。
- 替换提示词不会删除已有连线，需要时单独断开。此工具不提交生成。
- `{{Asset:...}}`、`{{Image 1}}` 等原生标记必须通过引用段生成，不能手写；引用段只接受 ID，不接受 URL。
- 单次 1–200 段，总文字最多 200000 字符，最多 32 个引用段。

### 示例：Seedance 2.5 全能参考

1. `tapnow_generation_capabilities` 确认当前页面提供 `seedance-2.5`，`tapnow_asset_import` 导入参考图。
2. `tapnow_canvas_edit` 创建视频生成节点：`model: "seedance-2.5"`、`variant: "reference"`、`modelType: "reference_to_video"`。实测通过的参数为 `duration: 5`、`resolution: "720p"`、`aspectRatio: "16:9"`、`generateAudio: false`、`times: 1`。
3. `tapnow_prompt_set` 写入图片的 `@素材` 引用和文字提示词。
4. `tapnow_generation_prepare`，核对原生面板显示 **Seedance 2.5 / 全能参考 / 5 秒**，以及分辨率、音频、数量和预估消耗。注意 `variant: "image"` 是图生视频，不是全能参考。
5. 用户明确授权后，用唯一 `requestId` 调用一次 `tapnow_generation_submit`，再用 `tapnow_generation_status` 查询到完成或失败。排队期间不要重复提交。
6. 完成后调用 `tapnow_canvas_save` 核对保存确认。

价格与可用参数以当前原生面板为准。

## 常驻服务

Chrome 对每一条新的调试连接都可能弹出授权提示。设置 `TAPNOW_RESIDENT=1` 后，网页端连接交给一个独立的后台进程保管：MCP 客户端退出后连接仍在，后续客户端直接复用。常驻服务只用于网页端；双端模式下 APP 端仍由 MCP 服务直接连接。

```powershell
npm run resident:start    # 启动并连接 Chrome，可能需要你允许一次
npm run resident:status   # 查看状态，不会新建 Chrome 连接
npm run verify:resident   # 依次运行两个独立 MCP 客户端，确认后台连接保留；只读
npm run resident:stop     # 等在途操作结束后断开
```

- 后台进程未运行时，常驻模式的客户端首次调用会按需启动它，无需设置开机启动。
- 首次连接、Chrome 重启或连接中断后重连时仍可能需要授权。本服务不会自动点击或绕过 Chrome 的授权提示。
- 通信使用本机命名管道（Windows）或 Unix socket 加随机令牌，不开放 HTTP 端口。连接记录与令牌位于 `.tapnow-mcp/resident/`，不要提交到版本库。
- 更新源码并构建后，要执行 `resident:stop` 再 `resident:start` 才会加载新代码，仅重新加载客户端不够。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TAPNOW_TARGET` | `desktop` | `desktop`、`web` 或 `both` |
| `TAPNOW_CDP_URL` | `http://127.0.0.1:9222` | 单端模式的调试地址。APP 端建议设为 `http://127.0.0.1:9333`；网页端用 `chrome` |
| `TAPNOW_DESKTOP_CDP_URL` | `http://127.0.0.1:9222` | 双端模式下 APP 端的地址；双端配置生成器默认输出 9333 |
| `TAPNOW_WEB_CDP_URL` | `chrome` | 双端模式下网页端的地址 |
| `TAPNOW_RESIDENT` | `0` | `1` 时网页端连接经常驻服务复用 |
| `TAPNOW_TARGET_ID` | 不设置 | 打开多个网页画布时指定调试目标 ID（不是画布 UUID）；双端模式下只作用于网页端 |
| `TAPNOW_CHROME_USER_DATA_DIR` | 系统默认 Chrome 用户数据目录 | 地址为 `chrome` 时，从这里读取 `DevToolsActivePort` 发现调试端口 |
| `TAPNOW_STATE_DIR` | 项目下的 `.tapnow-mcp/` | 请求账本、跨客户端写入锁和常驻服务记录的位置 |

`chrome` 表示自动读取 Chrome 的 `DevToolsActivePort` 文件找到调试地址，只用于发现端口，不读取任何凭据。也可以直接填本机浏览器 WebSocket 地址 `ws://127.0.0.1:端口/devtools/browser/ID`，或另行开启的本机 HTTP CDP 地址。

**多客户端与多电脑**：同一台电脑上的多个 agent 应使用同一份项目，或设置相同的 `TAPNOW_STATE_DIR` 和连接配置，才能共享写入锁和请求去重记录。每台电脑分别安装、构建、生成配置，并登录自己的 Tapnow。不要在仍有未核查任务时清空账本。

**更新源码后**：重新执行 `npm ci`、`npm run build`，再重新加载 MCP 服务；使用常驻服务时还要重启它。

## 验证状态

| 项目 | 结果 |
| --- | --- |
| MCP 接入 | 14 个工具通过正式 stdio 客户端调用 |
| 双端模式 | APP 端（9333）与 Chrome 网页端同时连接，按 `target` 路由 |
| APP 端生成 | Seedance 2.0 全能参考，3 张参考图，10 秒 720p，任务完成并回填 |
| 网页端生成 | Seedance 2.5 全能参考，1 张 `@素材` 图片，5 秒 720p；输出 MP4 实测 5.042 秒、1280×720 |
| 多素材引用 | 画布图片、文字、音频与素材库图片混排；重复引用不重复连线，刷新后保留 |
| 大视频上传 | 71.11 MiB、1920×1080、38 秒视频；播放、缩略图、保存及刷新后保留 |
| 常驻服务 | 两个独立 MCP 客户端依次退出后，后台进程与 Chrome 连接仍保留 |

这些结果不代表所有模型、参数组合或多人协作场景都已兼容。网页端仍属实验支持。完整证据见 [VERIFICATION.md](VERIFICATION.md)。

网页端会从当前页面已加载的官方画布包中，获取经过特征校验的原生函数引用（文字、音频构造函数和素材引用解析器位于模块私有作用域）。适配器不读取全局或闭包中的普通状态，也不把代码执行开放为工具。无法识别私有入口时，文字和音频会回退到原生添加菜单，此时只能使用默认模型。

## 开发与排障

```powershell
npm run build
npm test
npx tsx scripts/mcp-smoke.ts --schema-only
```

连接好画布后的只读检查：

```powershell
npm run diagnose            # APP 端（先设置 TAPNOW_CDP_URL）
npm run diagnose:web        # 网页端，常驻服务运行时会复用
npm run diagnose:both       # 双端（先设置 TAPNOW_DESKTOP_CDP_URL）
npx tsx scripts/mcp-smoke.ts
```

smoke 检查用官方 MCP 客户端连接服务，验证工具发现、诊断、读取、能力查询和截图，不编辑画布、不提交任务。会修改内容的真实测试请按 [VERIFICATION.md](VERIFICATION.md) 使用独立测试画布。

| 现象 | 处理 |
| --- | --- |
| APP 端连不上 | 确认 Tapnow 是从带调试参数的快捷方式启动的，端口与配置一致；浏览器访问 `http://127.0.0.1:9333/json/list` 查看页面列表 |
| 端口被占用 | 多半是 Chrome 远程调试占了 9222，APP 端改用 9333 |
| `AMBIGUOUS_TARGET` | 两端都打开了画布，调用时指定 `target: "app"` 或 `"web"` |
| `AMBIGUOUS_WINDOW` / 找不到主页面 | APP 端只保留一个主窗口；网页端多个画布时设置 `TAPNOW_TARGET_ID` |
| Chrome 反复询问是否允许调试 | 使用常驻配置并检查 `resident:status`，避免多个独立进程各自连接 |
| 常驻服务运行但 `connected: false` | 确认 Chrome 已打开、调试已启用、画布可用，再运行 `resident:start` 重连 |
| 改了代码行为不变 | 重新构建，重启常驻服务，再重新加载客户端 |
| 客户端找不到服务 | 先构建，再重新生成本机配置；检查是否移动了项目或 Node.js |
| 画布 ID 不匹配 | 重新读取当前画布，不要继续用旧 ID |
| 超时或连接中断 | 先读取实际状态，不要换新 `requestId` 盲目重试 |
| 保存失败 | 保持应用打开，检查网络、权限和应用提示，再次核对保存状态 |
| Tapnow 更新后异常 | 记录版本和诊断错误，先验证编辑、保存和素材引用，再提交付费任务 |

本项目依赖 Tapnow 的内部运行时入口，不保证兼容所有版本。连接成功不代表所有编辑和生成流程都可用；能力不匹配时会返回结构化错误，应更新适配器，而不是绕过保存流程直接修改内部数据。
