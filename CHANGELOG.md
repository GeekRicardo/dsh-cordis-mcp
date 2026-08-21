# CHANGELOG

## 1.2.0

安全与协议一致性，外加一个真实的连不上场景。

- **fix**：按 `http://[::1]:<port>/mcp` 接线时被误判为非回环而 403。取 Host 主机名时按第一个 `:` 切，对 IPv6 字面量是错的（`[::1]:8090` → `[`）；同源的设置页也因此读不到状态。
- **security**：bearer token 改为常数时间比较，两个头（`Authorization` / `X-DSH-MCP-Token`）都比一遍，拒绝耗时不再随猜对的前缀长度增长。
- **security**：校验 `Origin`——必须是回环且与本端点 host:port 一致，`"null"` 这类不透明来源直接拒；没有 `Origin` 的非浏览器客户端照常放行。这是 MCP 规范对本地 HTTP transport 的要求，且不依赖并非所有浏览器都发的 `sec-fetch-site`。
- **http**：处理 `MCP-Protocol-Version`——不支持的版本 400 并列出支持的版本，支持的版本在响应（含 202 通知）上回声。
- **http**：401 带 `WWW-Authenticate`，405 带 `Allow: POST, OPTIONS`。
- **refactor**：设置页路由与 MCP 端点共用同一套同源判定，不再是两份会分叉的实现。
- **install**：`install.sh --uninstall` 一键卸载（与安装对称、幂等，支持 `--dry-run` / `--restart`）。

## 1.1.0

- 认证改为在 DSH 设置页配置，MCP 端点永不开放（未配置 token 时 503）。

## 1.0.0

- 首个版本：把 DSH 动态 Cordis 工具集（inspect / define / run / stop / undefine）以 MCP streamable HTTP 暴露给 Claude Code。
