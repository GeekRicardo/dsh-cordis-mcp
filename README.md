# dsh-cordis-mcp

把 **DeepSeek Harness 的动态 Cordis 工具集**以 [MCP](https://modelcontextprotocol.io)（Streamable HTTP）暴露给 **Claude Code**：Claude Code 可以实时**加载、定义、运行、更新、停止、删除** DSH 的动态插件——和你在 DSH 会话里用 `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` / `cordis_inspect_*` 完全同一套能力，同一个运行时代理。

```
┌─────────────┐   MCP (Streamable HTTP, loopback)   ┌───────────────────────────┐
│ Claude Code │ ────── http://127.0.0.1:8090/mcp ──▶ │ DSH host (本插件)           │
│  (claude)   │ ────── JSON-RPC 2.0 ───────────────▶ │  dynamicCordisRunner      │
└─────────────┘                                       │  cordisInspect            │
                                                      │  agents (会话解析)         │
                                                      └───────────────────────────┘
```

插件是 **host-only** 的：只消费宿主服务（`dynamicCordisRunner` / `cordisInspect` / `agents` / `webServer`），挂在现有 web 端口上，不新开端口、不发布服务、无浏览器 UI。

## 能力（10 个工具）

| MCP 工具 | 对应 DSH 工具 | 作用 |
| --- | --- | --- |
| `dsh_status` | — | 桥状态：会话解析、活会话列表、插件数 |
| `dsh_sessions` | — | 列出可管理的活 DSH 会话（插件按会话归属） |
| `dsh_plugins_list` | `cordis_inspect_self`（无参） | 列出目标会话的全部动态插件与状态 |
| `dsh_plugin_inspect` | `cordis_inspect_self`（带参） | 插件/包详情；带 `packageId` 时返回源码 |
| `dsh_inspect_providers` | `cordis_inspect_list` | Inspect provider 目录（host + client） |
| `dsh_inspect_query` | `cordis_inspect_query` | 跑一次只读 inspect 查询（服务/事件/内建/槽位/主题/工具目录） |
| `dsh_plugin_define` | `cordis_define` | 定义不可变 Package（新建插件或追加版本） |
| `dsh_plugin_run` | `cordis_run` | 激活 Package（`run` / `update`），可返回 `awaiting-approval` |
| `dsh_plugin_stop` | `cordis_stop` | 停止运行、取消未决审批，保留定义与版本 |
| `dsh_plugin_undefine` | `cordis_undefine` | 永久删除插件（含全部 Package、授权、版本指针） |

> 含 Client half 的包首次运行仍走 DSH 的**审批流**：`dsh_plugin_run` 返回 `awaiting-approval`，在 DSH Web GUI 的 Run 卡片上点允许后异步完成——和 DSH 会话内一致。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/GeekRicardo/dsh-cordis-mcp/main/install.sh | bash
```

脚本做的事（可先 `--dry-run` 预览）：

1. 在 `~/.dsh/profiles/web/package.json` 写入依赖 `"dsh-cordis-mcp": "github:GeekRicardo/dsh-cordis-mcp"`；
2. 把 `dsh-cordis-mcp` 追加进 `dsh.profile.bundles`；
3. `cd ~/.dsh/profiles/web && pnpm install`；
4. 校验 bundles 已注册，提示重启。

重启 DSH 并硬刷新页面后，MCP 端点随 web 服务就绪：

```bash
pm2 restart dsh-web   # 若用 pm2 托管；否则用你的启动方式重启
```

## 接入 Claude Code

```bash
# 端口换成你 DSH web 的实际端口（启动日志会打印完整地址）
claude mcp add dsh --transport http http://127.0.0.1:8090/mcp
claude mcp list          # 确认 connected
```

或写入项目 `.mcp.json`：

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp"
    }
  }
}
```

然后直接对 Claude 说：

> 用 dsh_plugins_list 看看现在有哪些动态插件，然后 dsh_inspect_query 查一下 `dynamicCordisRunner` 服务，再 dsh_plugin_define + dsh_plugin_run 给我建一个打印 hello 的 host 插件。

### 可选：Token 鉴权

MCP 端点默认**仅限 loopback + 拒绝跨站**，不设密码。要加一道 token，给 DSH 进程设置环境变量后重启：

```bash
DSH_MCP_TOKEN=随便一串长随机值
```

`.mcp.json` 带请求头：

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer 随便一串长随机值" }
    }
  }
}
```

## 会话语义（重要）

动态插件**按会话归属**，且是进程内存态（DSH 重启即清空）。桥的会话解析顺序：

1. 调用参数里的 `sessionId`（可用 `dsh_sessions` 查）；
2. 环境变量 `DSH_MCP_DEFAULT_SESSION` 指定；
3. 当前唯一活会话；
4. 多个活会话但未指定 → 报错列出可选，要求传 `sessionId`。

## 其他环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_MCP_PATH` | `/mcp` | MCP 端点路径（挂在 webServer 上） |
| `DSH_MCP_TOKEN` | 无 | 设置后所有请求必须带 `Authorization: Bearer <token>`（或 `X-DSH-MCP-Token`） |
| `DSH_MCP_DEFAULT_SESSION` | 无 | 未显式传 `sessionId` 时的目标会话 |

## 安全边界

- 只接受 loopback Host（`127.*` / `localhost` / `::1`），拒绝一切外部访问；
- 拒绝 `sec-fetch-site: cross-site` 的浏览器请求，且**永不返回 CORS 头**——网页读不到响应；
- 可选 token 全请求校验；
- 该端点能 define/run/删除插件，**等同 shell 权限**，别把端口暴露到非本机。

## 工作原理

| 文件 | 职责 |
| --- | --- |
| `lib/mcp-protocol.js` | 纯 MCP JSON-RPC 层（initialize / ping / tools/list / tools/call），零 DSH 依赖 |
| `lib/tools.js` | 10 个工具的输入校验 + 会话解析，封装 `dynamicCordisRunner` / `cordisInspect` |
| `lib/http.js` | webServer route 上的 HTTP 层：body 读取、鉴权、loopback/跨站防护 |
| `lib/index.js` | Cordis 插件：注入 4 个宿主服务、注册 `/mcp` route、打印就绪日志 |
| `lib/client.js` | 空 web face（本插件无浏览器 UI） |

## 卸载

```bash
# 1. 从 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 移除 "dsh-cordis-mcp"
# 2. 移除 dependencies 里的 "dsh-cordis-mcp"
# 3. cd ~/.dsh/profiles/web && pnpm install
# 4. 重启 DSH；claude mcp remove dsh
```

## 前置条件

- DeepSeek Harness 已初始化 web profile（`~/.dsh/profiles/web` 存在），且当前会话跑在带 Cordis 工具集的 preset 上（宿主侧 `dynamicCordisRunner` 服务存在，默认即有）；
- 本机装有 Claude Code CLI 并已登录；
- Node.js ≥ 20、pnpm 可用。

## Troubleshooting

| 现象 | 原因与处理 |
| --- | --- |
| `claude mcp list` 显示 disconnected | DSH 未重启 / 端口不对。重启后在 DSH 启动日志里找 `[dsh-cordis-mcp] MCP endpoint ready` 一行，用打印出来的地址 |
| `dsh_plugin_run` 返回 `awaiting-approval` | 含 Client half 的包需要你在 DSH Web GUI 的 Run 卡片上允许；授权后重跑 `dsh_plugin_run` |
| 报 `multiple live DSH sessions` | 有多个活会话，先 `dsh_sessions` 查 id，再在调用里传 `sessionId` |
| 报 `no live DSH session` | DSH Web GUI 没打开任何会话；打开后再试 |
| 插件重启后消失 | 动态插件是进程内存态，属预期；本桥只管理运行中的 DSH 进程 |

## License

MIT
