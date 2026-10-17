# Tapnow 画布操作 MCP

让 Codex、Claude 和其他支持本地 MCP 的 agent 操作 Tapnow 桌面端当前打开的画布。

通过 Electron 本机调试接口连接，复用 Tapnow 当前登录状态，调用应用自身的编辑、上传、生成与保存入口；不修改应用安装文件，不向 agent 开放任意脚本执行。

> 当前版本：0.2.0。已验证环境：Windows、Tapnow Desktop 0.4.112、Node.js 24.13.1。Tapnow 更新可能影响兼容性，其他平台尚未实测。

## 能做什么

- **画布编辑**：读取节点和连线，创建与编辑文字、媒体生成节点，移动、缩放尺寸、删除、连线、分组和布局。
- **素材管理**：导入本地图片、视频、音频，或引用 HTTP(S) 素材地址。
- **提示词引用**：混排文字与原生 `@素材`，支持画布素材、素材库素材、多素材和重复引用。
- **生成流程**：读取可用模型与参数，准备生成、提交任务、查询状态与结果。
- **保存与历史**：调用原生保存，检查保存确认，撤销、重做和截图。

已完成多素材引用及真实 Seedance 2.0 视频生成验证，具体记录与边界见 [VERIFICATION.md](VERIFICATION.md)。

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

### Claude Desktop

1. 执行 `npm run --silent config:claude`。
2. 在 Claude 中打开 **Settings → Developer → Edit Config**。Windows 配置文件通常为 `%APPDATA%\Claude\claude_desktop_config.json`。
3. 将输出中的 `tapnow-canvas` 服务合并到已有的 `mcpServers`，保留其他配置。
4. 完全退出并重新打开 Claude Desktop。

### Codex 桌面版 / CLI

执行 `npm run --silent config:codex`，将输出合并到本机的 `~/.codex/config.toml`。Windows 默认位置为 `%USERPROFILE%\.codex\config.toml`；如设置了 `CODEX_HOME`，使用该目录下的配置文件。保存后在客户端重新加载 MCP，必要时重启客户端。

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
| `tapnow_asset_import` | 导入本地媒体文件（最大 50 MiB），或引用远程 URL |
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

每台电脑分别安装依赖、构建、生成配置，并登录自己的 Tapnow。同一台电脑上的多个 agent 应使用同一份项目，或显式设置相同的 `TAPNOW_STATE_DIR`，以共享写入锁和请求去重记录。升级或移动项目时应保留请求记录，不要在未知任务尚未核查时清空账本。

源码更新后，重新运行 `npm ci`、`npm run build`，再重启或重新加载 MCP 服务。

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

| 现象 | 处理方式 |
| --- | --- |
| 无法连接 | 检查 Tapnow 是否启动、参数是否生效、端口是否一致；访问 `http://127.0.0.1:9222/json/list` 检查页面列表 |
| 主页面缺失或多个窗口 | 保留一个 Tapnow 主窗口，在其中打开目标画布，再诊断 |
| 客户端找不到服务 | 先构建，再重新生成本机配置；检查是否移动了项目或 Node.js |
| 画布 ID 不匹配 | 重新读取当前画布，停止使用旧 ID |
| 请求超时或连接中断 | 先读取实际状态，不换新请求 ID 盲目重试 |
| 保存失败 | 保持应用打开，检查网络、权限与应用提示，重新核查保存状态 |
| 新增工具未出现 | 重新加载 MCP 服务或重启客户端 |
| Tapnow 更新后不兼容 | 记录版本与诊断错误，检查编辑、保存、素材引用；验证完成后再提交付费任务 |

本项目依赖应用内部运行时入口，不保证所有 Tapnow 版本兼容。调试连接成功不代表全部编辑和生成流程已通过验证；能力不匹配时会返回结构化错误，应更新适配器，不应绕过保存流程直接修改内部数据。
