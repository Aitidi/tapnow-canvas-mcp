# Tapnow 画布操作 MCP

让 Codex、Claude 和其他支持本地 MCP 的 agent 操作 Tapnow 桌面端或 Chrome 网页端当前打开的画布。

通过本机调试接口连接 Tapnow Desktop（Electron）或 Chrome，复用目标应用的当前登录状态，调用应用自身的编辑、上传、生成与保存入口；不修改应用安装文件，不向 agent 开放任意脚本执行。

另提供 **Chrome 网页端实验适配**，连接与验证边界见下文。桌面端仍为默认连接目标。

> 当前版本：0.2.0。最近验证：2026-10-19，Windows、Tapnow Desktop 0.4.112、Chrome 网页端、Node.js 24.13.1。构建及 99 项自动化测试通过。Tapnow 更新可能影响兼容性，其他操作系统尚未实测。

## 能做什么

- **画布编辑**：读取节点和连线，创建与编辑文字、媒体生成节点，移动、缩放尺寸、删除、连线、分组和布局。
- **素材管理**：导入本地图片、视频、音频，或引用 HTTP(S) 素材地址；本地视频最大 500 MiB，其他媒体最大 50 MiB，应用自身限制仍适用。
- **提示词引用**：混排文字与原生 `@素材`，支持画布素材、素材库素材、多素材和重复引用。
- **生成流程**：读取可用模型与参数，准备生成、提交任务、查询状态与结果。
- **保存与历史**：调用原生保存，检查保存确认，撤销、重做和截图。
- **常驻连接**：后台进程保管 Chrome 连接，多个 MCP 客户端可先后复用，减少重新连接时的授权弹窗。

### 当前验证状态

| 项目 | 已验证结果 |
| --- | --- |
| MCP 接入 | 14 个工具，正式 stdio 客户端调用通过 |
| 桌面端生成 | Seedance 2.0 全能参考，3 张参考图，10 秒、720p、无音频，任务完成并回填 |
| 网页端生成 | Seedance 2.5 全能参考，1 张原生 `@素材` 图片，5 秒、720p、无音频，任务完成并保存；输出 MP4 实际 5.042 秒、1280×720、H.264 |
| 多素材引用 | 画布图片、文字、音频和素材库图片混排；重复引用不重复连线，刷新后标签保留 |
| 大视频上传 | 原文件 71.11 MiB、1920×1080、38.47 秒；播放、缩略图、保存及刷新后保留均通过 |
| 常驻服务 | 两个独立 MCP 客户端依次退出后，后台进程与同一条 Chrome 连接仍保留 |

这些结果不代表所有模型、参数组合或多人协作场景均已兼容。完整证据与边界见 [VERIFICATION.md](VERIFICATION.md)。

## 快速开始

以下命令在 Windows PowerShell 中执行。需要安装 Node.js 22 或更新版本；使用克隆方式下载时还需要 Git。

### 1. 下载并构建

```powershell
git clone https://github.com/Aitidi/tapnow-canvas-mcp.git
cd tapnow-canvas-mcp
npm ci
npm run build
```

也可以从 GitHub 下载源码 ZIP，解压后在项目目录执行最后两条命令。当前提供源码安装方式，不提供便携运行时或一键安装包。

**Chrome 网页用户**：完成构建后，直接按下方 [Chrome 网页端接入](#chrome-网页端实验) 操作。以下第 2–4 步用于 Tapnow 桌面端，无需为网页端修改桌面应用快捷方式。

### 2. 开启 Tapnow 调试端口

先确认画布保存成功，正常退出整个 Tapnow 应用。在快捷方式“目标”的程序路径引号外添加以下参数：

```text
"C:\实际安装路径\Tapnow.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --enable-desktop-devtools
```

重新从该快捷方式启动 Tapnow，并打开目标画布。已有实例通常会复用旧进程，因此仅修改快捷方式后再次点击，可能不会启用端口。

也可以在应用已正常退出后使用启动脚本：

```powershell
npm run launch -- -AppPath 'C:\实际安装路径\Tapnow.exe'
```

启动脚本不会强制结束或重启正在运行的应用。MCP 服务本身只连接，不会自行启动 Tapnow。调试端口仅供可信的本机程序访问；`--enable-desktop-devtools` 是否生效取决于应用版本，以诊断结果为准。

### 3. 检查连接

```powershell
npm run diagnose
```

确认连接成功，并且打开的是希望 agent 操作的画布，再接入客户端。

### 4. 生成客户端配置

在项目目录选择对应命令：

| 客户端 | 生成命令 | 输出内容 |
| --- | --- | --- |
| Claude Desktop | `npm run --silent config:claude` | 通用 MCP JSON 配置 |
| Codex 桌面版 / CLI | `npm run --silent config:codex` | TOML 配置 |
| Claude Code | `npm run --silent config:claude-code` | 一行 PowerShell 注册命令 |
| 其他支持本地 stdio 的 agent | `npm run --silent config:claude` | 通用 MCP JSON，按客户端格式合并 |

生成器自动读取本机 Node.js 和项目路径，**仅输出配置或命令，不修改客户端文件**。每台电脑应分别生成；移动项目或更换 Node 安装位置后应重新生成。

输出中的绝对路径是本机自动生成的，用于保证客户端从任意工作目录都能找到服务，不需要手工填写。`examples/` 中的配置仅展示结构，占位符不能直接使用。

## 接入客户端

### Chrome 网页端（实验）

网页模式只识别 `https://app.tapnow.ai/canvas/<画布 UUID>`，复用 Chrome 已登录的 Tapnow 页面。已实测通过画布读取、文字和音频节点创建、图片/音频/视频上传、远程素材引用、原生保存、节点连线与断开重连、多素材 `@引用`、撤销和重做、分组和解除分组、三种布局、视口与截图，以及刷新后的保留。网页端仍为实验支持，不能据此推断全部模型流程已兼容。

网页将部分文字、音频构造函数和素材引用解析器保留在模块私有作用域中。适配器只检查当前页面已加载的官方画布包，获取经过特征校验的原生函数引用；不读取全局或其他闭包状态，不把任意代码执行作为 MCP 工具开放。音频已验证指定 `music-2.6` 模型创建，通用 `data.prompt` 映射到原生 `data.params.prompt`。若无法识别私有入口，文字与音频可尝试原生添加菜单，此回退路径仅使用默认模型。

`@素材` 已验证两张画布图片、一个文字节点、一段音频和一张素材库图片混排，首图重复引用；6 个标签只产生 4 条画布输入连线，素材库引用不创建画布连线。标签顺序和内容刷新后保留。已验证断开、重连、重复连接及自连接拒绝，并处理刷新后默认端口由空值变为 `right/left` 的去重差异。

正式 SDK 客户端通过真实 stdio 连接生产服务，14 个工具均已有真实网页调用；原生撤销/重做、分组/解除分组、`grid`/`LR`/`TB` 布局通过。保存后刷新，内容、尺寸、位置、分组关系和素材地址保留。合成 WebM 上传后原生预览可解码，但该极短素材的服务端缩略图返回空文件，未把缩略图渲染计为通过；用户提供的真实 MP4 上传、播放及缩略图均通过。

网页端另已完成一次真实 Seedance 2.5 全能参考生成：1 张画布图片以原生 `@素材` 引用，5 秒、720p、16:9、关闭音频、单次提交。结果回填并取得保存确认；解析输出 MP4，实际时长 5.042 秒、1280×720、H.264，仅视频轨道。其他模型的实际生成与真实多人协作尚未逐一验证。

Chrome 144 或更新版本可连接已运行的浏览器，无需重启：

1. 手动打开 `chrome://inspect/#remote-debugging`，启用远程调试。
2. 登录 Tapnow 并打开一个目标网页画布。
3. 按下方命令启动常驻服务；若 Chrome 显示本机调试连接提示，由用户确认允许。

Chrome 按调试连接授权。建议启用下述常驻模式：独立后台进程保管 Chrome 连接，MCP 客户端退出后连接仍保留，后续客户端继续复用。首次连接、Chrome 重启或连接断开后的重连仍可能需要用户允许；此模式不自动点击或取消 Chrome 的授权检查。未启用常驻模式时，每个新服务进程仍会建立自己的连接。

调试访问能控制当前浏览器会话并接触已登录页面；只允许可信的本机程序，测试结束后可关闭调试开关。MCP 不会自行修改浏览器设置或确认权限提示。[Chrome 官方连接说明](https://developer.chrome.com/docs/devtools/agents/get-started/configuration#automatic-connection-chrome-144)

启用常驻模式并生成客户端配置：

```powershell
npm run resident:start
npm run resident:status
npm run --silent config:codex:web
```

生成内容包含 `TAPNOW_TARGET=web`、`TAPNOW_CDP_URL=chrome` 和 `TAPNOW_RESIDENT=1`。将输出合并到客户端配置并重新加载 MCP；生成命令本身不会修改客户端配置。

其他客户端可运行 `node scripts/print-config.mjs json --web-resident` 或 `node scripts/print-config.mjs claude-code --web-resident`。`chrome` 会读取 Chrome 用户数据目录中的 `DevToolsActivePort`；仅用于发现本机调试地址，不读取登录凭据。非默认目录可用 `TAPNOW_CHROME_USER_DATA_DIR` 指定。

常驻服务管理与只读验证：

```powershell
npm run resident:status
npm run verify:resident
npm run resident:stop
```

状态查询不会建立 Chrome 连接；停止命令等待在途操作结束后断开连接。没有运行后台进程时，常驻客户端首次调用会按需启动；无需注册 Windows 开机启动任务。`npm run diagnose:web` 检测到已运行的常驻服务时也会复用它。`verify:resident` 先后运行并关闭两个独立 stdio MCP 客户端，确认后台进程和 Chrome 连接仍保留，不编辑画布或提交生成。

Windows 使用本机命名管道，其他系统使用本机 Unix socket，配合随机认证令牌；不开放 HTTP 监听端口。连接记录与令牌位于 `.tapnow-mcp/resident/`，不要将此目录加入版本管理。相同状态目录、目标模式及浏览器配置复用同一后台进程。更新源码并构建后，需要执行 `resident:stop`、`resident:start` 加载新版本，这次重连可能再次询问授权。

高级连接支持本机浏览器 WebSocket 地址 `ws://127.0.0.1:端口/devtools/browser/ID`，或另行开启的本机 HTTP CDP 地址。多个网页画布时会拒绝猜测，可将诊断错误候选列表中的 ID 设置为 `TAPNOW_TARGET_ID`；它是调试目标 ID，不是画布 UUID。所有访问同一浏览器的客户端应使用相同连接配置及状态目录，以共享写入锁和去重记录。

初次连接先运行只读诊断，检查实际返回的能力。生成需用户明确授权；原生入口无法识别时会返回结构化错误，不会伪造素材 token 或绕过原生保存。

### 同时连接桌面端和网页端

设置 `TAPNOW_TARGET=both` 后，一个 MCP 服务同时管理桌面端和 Chrome 网页端两条连接，每个工具多一个可选参数 `target`：

- `app`：只操作 Tapnow 桌面端，连接 `TAPNOW_DESKTOP_CDP_URL`。
- `web`：只操作 Chrome 网页画布，连接 `TAPNOW_WEB_CDP_URL`，设置 `TAPNOW_RESIDENT=1` 时复用网页常驻服务。
- `auto`（默认）：两端都检查，只有一端打开画布时才自动选择；带 `canvasId` 时按画布 ID 选择。两端都打开可用画布时返回 `AMBIGUOUS_TARGET`，不会猜测。

`tapnow_diagnose` 同时报告两端，一端未连接不影响另一端；其他工具的结果带有 `target` 字段，标明实际操作的一端。指定 `target` 可跳过对另一端的检查。

Chrome 在 `chrome://inspect` 启用的远程调试默认也使用 9222 端口，与桌面端默认端口冲突，先启动者占用端口。双端模式下应让桌面端改用其他端口，例如把 Tapnow 快捷方式参数改为 `--remote-debugging-port=9333`，或运行 `npm run launch -- -Port 9333`。

```powershell
npm run --silent config:codex:both
node scripts/print-config.mjs json --both
npm run diagnose:both
```

生成的配置默认 `TAPNOW_DESKTOP_CDP_URL=http://127.0.0.1:9333`，可在执行前用同名环境变量覆盖。`npm run diagnose:both` 是只读检查，网页常驻服务运行时会复用它。

### Claude Desktop

1. 执行 `npm run --silent config:claude`。
2. 在 Claude 中打开 **Settings → Developer → Edit Config**。Windows 配置文件通常为 `%APPDATA%\Claude\claude_desktop_config.json`。
3. 将输出中的 `tapnow-canvas` 服务合并到已有的 `mcpServers`，保留其他配置。
4. 完全退出并重新打开 Claude Desktop。

### Codex 桌面版 / CLI

桌面端执行 `npm run --silent config:codex`；Chrome 网页常驻模式执行 `npm run --silent config:codex:web`。将输出合并到本机的 `~/.codex/config.toml`，保留已有服务。Windows 默认位置为 `%USERPROFILE%\.codex\config.toml`；如设置了 `CODEX_HOME`，使用该目录下的配置文件。保存后在客户端重新加载 MCP，必要时重启客户端。

### Claude Code

执行 `npm run --silent config:claude-code`，复制输出的整行注册命令，在 PowerShell 中执行。进入 Claude Code 后，用 `/mcp` 查看连接状态。

### 其他 agent

使用通用 JSON 输出中的 `command`、`args` 和 `env` 创建一个 **stdio** MCP 服务。客户端需支持启动本机进程；不同客户端的配置外层结构可能不同。

客户端会启动 MCP 服务，通常无需另外运行 `npm start`。不要把 `npm run diagnose` 当作 MCP 启动命令。当前服务没有远程 HTTP 接口，不能直接作为 URL 连接器添加到 ChatGPT 或 Claude 网页版。

接入后可先对 agent 说：

> 使用 Tapnow MCP 检查连接并读取当前画布，先不要修改内容。

客户端配置参考：[Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)、[Claude Code](https://code.claude.com/docs/en/mcp)、[Codex](https://developers.openai.com/codex/mcp)。

## 工具列表

共 14 个工具：

| 工具 | 用途 |
| --- | --- |
| `tapnow_diagnose` | 检查连接、页面、画布及原生入口 |
| `tapnow_canvas_read` | 读取画布 ID、节点、连线、选中项与保存状态 |
| `tapnow_canvas_edit` | 批量创建、更新、删除、连线、选择、分组及布局 |
| `tapnow_canvas_view` | 适配全部节点、聚焦指定节点或设置视口 |
| `tapnow_asset_import` | 导入本地视频（最大 500 MiB）或其他媒体（最大 50 MiB），或引用远程 URL；应用自身限制仍适用 |
| `tapnow_prompt_references` | 只读查询画布或原生素材库中的引用候选 |
| `tapnow_prompt_set` | 替换提示词并插入原生素材引用 |
| `tapnow_generation_capabilities` | 查询当前可用的模型与参数 |
| `tapnow_generation_prepare` | 打开原生生成面板，检查就绪情况，不提交任务 |
| `tapnow_generation_submit` | 实际提交生成任务，可能消耗 Tapies |
| `tapnow_generation_status` | 查询任务状态、错误与结果 |
| `tapnow_history` | 撤销或重做 |
| `tapnow_canvas_save` | 请求保存并检查确认结果 |
| `tapnow_canvas_screenshot` | 截取当前应用页面，包含画布与界面 |

## 使用约定

1. **先读再写**：先调用诊断和读取工具，取得当前 `canvasId` 与节点 ID。写操作会再次核对画布；用户切换画布后，应重新读取再操作。
2. **检查逐项结果**：批量编辑可能部分成功。失败后先读取实际画布，不要直接重做整批操作。
3. **保留请求 ID**：编辑、素材导入、提示词写入和生成提交使用唯一 `requestId`。同一请求重试复用原 ID；参数改变后不能复用。
4. **区分显示与保存**：检查返回的保存确认，不能将界面更新视为已持久化。读取时的 `unknown` 表示尚无当前内容的保存确认，可调用保存工具核查。
5. **生成前核对参数**：先查能力，再配置节点并调用准备工具。模型或模式切换可能重置默认值，应检查最终模型、模式、时长、音频和生成数量。只有用户明确授权生成后才提交。
6. **超时后先核查**：断线或超时可能意味着操作已执行。先读取画布或用原请求 ID 查询生成状态，避免重复提交与重复扣费。

撤销恢复已删除节点时，Tapnow 可能重新分配节点 ID。后续调用应使用历史工具返回的 ID，或重新读取画布。

超过 50 MiB 的本地视频使用 2 MiB 分块传入页面，再交给原生上传器；保留原文件内容，不压缩、不转码。传输前后核对内容哈希，文件中途变化时停止上传。大视频客户端调用建议允许至少 10 分钟；超时后先读取画布，勿换请求 ID 重传，以免重复上传或创建节点。

### Seedance 2.5 全能参考流程

1. 用 `tapnow_generation_capabilities` 确认当前页面提供 `seedance-2.5`，再用 `tapnow_asset_import` 导入参考图片。
2. 用 `tapnow_canvas_edit` 创建视频生成节点，设置 `model: "seedance-2.5"`、`variant: "reference"`、`modelType: "reference_to_video"`。本次通过的组合为 `duration: 5`、`resolution: "720p"`、`aspectRatio: "16:9"`、`generateAudio: false`、`times: 1`。
3. 用 `tapnow_prompt_set` 将图片节点写入原生 `@素材` 引用，并填写文字提示词。工具自动补齐输入连线，不要手拼 `{{Image 1}}` 等标记。
4. 调用 `tapnow_generation_prepare`，核对原生面板显示的是 **Seedance 2.5 / 全能参考 / 5 秒**，并检查分辨率、音频、数量及预估消耗。不要将 `variant: "image"` 的图生视频模式当作全能参考。
5. 用户明确授权后，用唯一 `requestId` 调用 `tapnow_generation_submit` 一次；随后用 `tapnow_generation_status` 查询，直到任务完成或失败。任务排队期间不要重复提交。
6. 完成后检查返回的结果地址，调用 `tapnow_canvas_save` 核对保存确认。

实测提示词方向是保留天宫门廊、远处宫殿与三人的构图，加入缓慢前推、云海薄雾流动和轻微衣袂运动。具体价格与可用参数以当前原生面板为准。

### 画布编辑示例

调用 `tapnow_canvas_edit`，将示例中的画布 ID 替换为读取结果：

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

操作字段为 `op`，支持 `create`、`update`、`delete`、`connect`、`disconnect`、`select`、`layout`、`group` 和 `ungroup`。更新使用 `nodeId`，删除、选择与分组使用 `nodeIds`，断连使用 `edgeIds`。布局方向支持 `LR`、`TB`、`grid`。

生成节点使用 `mode: "generate"`，通过 `data.prompt`、`data.params` 配置。音频节点的通用 `data.prompt` 会映射到原生 `data.params.prompt`。本地文件使用素材导入工具；`data.src` 用于已有的素材地址。

### 提示词中的 `@素材`

先调用 `tapnow_prompt_references` 查询素材，再把返回的 ID 交给 `tapnow_prompt_set`：

| 来源 | 查询方式 | 引用标识 | 写入行为 |
| --- | --- | --- | --- |
| 当前画布 | `source: "canvas"` | `nodeId` | 自动补齐素材到目标节点的连线 |
| 原生素材库 | `source: "library"` | `assetId` | 查询真实元数据并写入原生 token，不新增画布连线 |

查询支持 `query`、`limit`、`offset`，默认每页 50 条，最多 100 条；继续分页使用返回的 `nextOffset`。画布候选返回 `usable`；提供目标节点 `nodeId` 时，还返回 `connected` 和 `canConnect`。素材库按个人、团队的顺序分页，旧版模板包暂不支持。查询不选择节点，也不打开面板。

混排文字与两种素材的参数示例：

```json
{
  "canvasId": "当前画布 ID",
  "nodeId": "目标生成节点 ID",
  "requestId": "example-prompt-ref-001",
  "segments": [
    { "type": "text", "text": "参考人物 " },
    { "type": "reference", "source": "canvas", "nodeId": "画布人物素材节点 ID" },
    { "type": "text", "text": "，使用场景 " },
    { "type": "reference", "source": "library", "assetId": "素材库返回的素材 ID" },
    { "type": "text", "text": "，创作电影风格画面。" }
  ]
}
```

写入会**整体替换提示词**，保留片段顺序；同一画布素材重复引用不会重复连线。替换提示词不会删除已有连线，需要时单独断开。此工具只配置提示词，不提交生成任务。

普通 `@文字` 可放入文字段；`{{Asset:...}}`、`{{Image 1}}` 等原生标记必须由引用段构造，不能手拼。引用段只接受 ID，不接受 URL 或素材元数据。单次支持 1–200 段、总文字最多 200000 字符、最多 32 个引用段。出现部分连线失败时，先重新读取画布再处理。

## 配置与多电脑使用

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TAPNOW_CDP_URL` | `http://127.0.0.1:9222` | Tapnow 本机调试地址，修改端口时启动参数也需同步修改 |
| `TAPNOW_STATE_DIR` | 项目目录下的 `.tapnow-mcp/` | 请求账本与跨客户端写入锁的位置 |
| `TAPNOW_TARGET` | `desktop` | `desktop` 为桌面端，`web` 为 Chrome 网页画布（实验），`both` 为同时连接两端 |
| `TAPNOW_DESKTOP_CDP_URL` | `http://127.0.0.1:9222` | `both` 模式下桌面端的调试地址；建议改用 9333 等非 9222 端口 |
| `TAPNOW_WEB_CDP_URL` | `chrome` | `both` 模式下网页端的调试地址 |
| `TAPNOW_TARGET_ID` | 不设置 | 明确指定一个调试目标，避免多窗口或多标签歧义；`both` 模式下只作用于网页端 |
| `TAPNOW_CHROME_USER_DATA_DIR` | 系统默认 Chrome 用户数据目录 | `TAPNOW_CDP_URL=chrome` 时查找调试端口文件的位置 |
| `TAPNOW_RESIDENT` | `0` | `1` 时 MCP 通过本机后台服务复用连接；客户端退出不停止后台服务 |

每台电脑分别安装依赖、构建、生成配置，并登录自己的 Tapnow。同一台电脑上的多个 agent 应使用同一份项目，或显式设置相同的 `TAPNOW_STATE_DIR`，以共享写入锁和请求去重记录。升级或移动项目时应保留请求记录，不要在未知任务尚未核查时清空账本。

源码更新后，重新运行 `npm ci`、`npm run build`，再重启或重新加载 MCP 服务。

使用常驻模式时，还需执行 `npm run resident:stop` 和 `npm run resident:start`，让后台进程加载新代码；仅重新加载客户端不会替换已经运行的后台版本。

## 验证与排障

开发检查：

```powershell
npm run build
npm test
npx tsx scripts/mcp-smoke.ts --schema-only
```

Tapnow 已连接并打开画布后，可进行只读检查：

```powershell
npm run diagnose
npx tsx scripts/mcp-smoke.ts
```

完整 smoke 检查使用官方 MCP 客户端连接生产服务，验证工具发现、诊断、读取、能力查询和截图，不编辑画布或提交任务。真实编辑测试会修改测试内容，应按 [验证记录](VERIFICATION.md) 使用独立测试画布。

网页常驻模式使用以下只读检查，复用已建立的 Chrome 连接：

```powershell
npm run resident:status
npm run diagnose:web
npm run verify:resident
```

| 现象 | 处理方式 |
| --- | --- |
| 无法连接 | 检查 Tapnow 是否启动、参数是否生效、端口是否一致；访问 `http://127.0.0.1:9222/json/list` 检查页面列表 |
| 主页面缺失或多个窗口 | 保留一个 Tapnow 主窗口，在其中打开目标画布，再诊断 |
| Chrome 重复询问允许调试 | 使用网页常驻配置并检查 `resident:status`；避免直接启动多个独立调试进程。Chrome 重启或连接中断后仍可能再次询问 |
| 常驻进程运行但 `connected: false` | 确认 Chrome 已打开、调试已启用且目标画布可用，再运行 `resident:start` 重连；如出现提示，由用户允许 |
| 修改代码后行为未变化 | 重新构建并停止、启动常驻服务，再重新加载客户端 |
| 客户端找不到服务 | 先构建，再重新生成本机配置；检查是否移动了项目或 Node.js |
| 画布 ID 不匹配 | 重新读取当前画布，停止使用旧 ID |
| 请求超时或连接中断 | 先读取实际状态，不换新请求 ID 盲目重试 |
| 保存失败 | 保持应用打开，检查网络、权限与应用提示，重新核查保存状态 |
| 新增工具未出现 | 重新加载 MCP 服务或重启客户端 |
| Tapnow 更新后不兼容 | 记录版本与诊断错误，检查编辑、保存、素材引用；验证完成后再提交付费任务 |

本项目依赖应用内部运行时入口，不保证所有 Tapnow 版本兼容。调试连接成功不代表全部编辑和生成流程已通过验证；能力不匹配时会返回结构化错误，应更新适配器，不应绕过保存流程直接修改内部数据。
