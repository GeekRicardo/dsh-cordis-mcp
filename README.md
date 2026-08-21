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

插件挂在现有 web 端口上，不新开端口、不发布服务；MCP 端点**强制 Bearer 认证**，token 在 **DSH 设置 → dsh-cordis-mcp** 页面配置（首次自动生成，可自定义/重新生成）。

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

### 认证（强制，不能直连）

MCP 端点**强制 Bearer 认证**，未带 token 一律 401（未配置 token 则 503）。token 在 **DSH 设置 → dsh-cordis-mcp** 页面里配置：首次使用自动生成并持久化，页面可查看/复制/自定义/重新生成。把 token 填进 `.mcp.json` 的请求头：

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer <设置页里的 token>" }
    }
  }
}
```

token 解析优先级：**设置页配置 > `DSH_MCP_TOKEN` 环境变量 > 自动生成**。改 token 立即生效（无需重启）；重新生成后旧 token 立即失效，需同步更新 Claude Code 配置。

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
| `DSH_MCP_TOKEN` | 无 | 认证 token 的回退来源（设置页未配置时使用） |
| `DSH_MCP_DEFAULT_SESSION` | 无 | 未显式传 `sessionId` 时的目标会话 |

## 安全边界

- **强制 Bearer 认证**：无 token 一律 401 / 503，端点永远不能直连；token 走常数时间比较，猜对的前缀不会让拒绝来得更慢；
- 只接受 loopback Host（`127.*` / `localhost` / `::1`，含 `[::1]:port` 这种带方括号的写法），拒绝一切外部访问；
- 浏览器带来的 `Origin` 必须是回环、且与本端点的 host:port 一致（MCP 规范要求的 DNS rebinding 防护）；完全没有 `Origin` 的请求视为非浏览器客户端（Claude Code 就是），由 token 把守；
- 拒绝 `sec-fetch-site: cross-site` 的浏览器请求，且**永不返回 CORS 头**——网页读不到响应；
- 设置页路由 `/dsh-cordis-mcp/settings` 与 MCP 端点共用同一套同源判定（不带 MCP token，但改的只是 token 配置本身）；
- 该端点能 define/run/删除插件，**等同 shell 权限**，别把端口暴露到非本机。

## 工作原理

| 文件 | 职责 |
| --- | --- |
| `lib/mcp-protocol.js` | 纯 MCP JSON-RPC 层（initialize / ping / tools/list / tools/call），零 DSH 依赖 |
| `lib/tools.js` | 10 个工具的输入校验 + 会话解析，封装 `dynamicCordisRunner` / `cordisInspect` |
| `lib/token.js` | 纯 token 解析/生成（设置 > env > 自动生成） |
| `lib/http.js` | MCP route 的 HTTP 层：强制认证、body 读取、loopback/跨站防护 |
| `lib/index.js` | Cordis 插件：注入 5 个宿主服务、settings 命名空间、`/mcp` + `/dsh-cordis-mcp/settings` 两条 route |
| `lib/client.js` | 设置页 UI：token 查看/复制/自定义/重新生成 + 端点地址 |

## 卸载

```bash
bash install.sh --uninstall            # 加 --dry-run 可先看要做什么
claude mcp remove dsh                  # 摘掉 Claude Code 那侧的 server 条目
```

`--uninstall` 与安装完全对称：从 `~/.dsh/profiles/web/package.json` 的
`dependencies` 与 `dsh.profile.bundles` 里摘掉 `dsh-cordis-mcp`，再 `pnpm install`，
最后校验确实摘干净。加 `--restart` 可顺带重启 pm2 托管的 dsh-web；重启后 MCP 端点下线。

手工卸载（等价步骤）：

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
| 401 / `missing or invalid bearer token` | `.mcp.json` 里的 token 过期或不对——去设置页复制当前 token 更新 |
| 503 / `auth-not-configured` | host 未初始化 token（异常态）——在设置页保存任意 token 或重启 DSH |
| 插件重启后消失 | 动态插件是进程内存态，属预期；本桥只管理运行中的 DSH 进程 |

## License

MIT
