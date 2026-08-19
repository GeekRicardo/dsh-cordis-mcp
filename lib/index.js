// dsh-cordis-mcp — host face.
//
// Exposes DSH's dynamic-Cordis toolset (inspect / define / run / stop /
// undefine) to external MCP clients such as Claude Code, over the existing
// `webServer` route table. One route, default `/mcp`:
//
//   claude mcp add dsh --transport http http://127.0.0.1:8090/mcp
//
// The bridge is loopback-only and optionally token-gated (DSH_MCP_TOKEN).
// It manages dynamic plugins for one DSH session at a time: explicit
// sessionId per call, else DSH_MCP_DEFAULT_SESSION, else the sole live
// session. Dynamic plugins are process-local and session-owned — a Claude
// Code run can define, run, update, stop, and permanently remove the same
// plugins the GUI session sees, with the same approval semantics (a Client
// half needing approval surfaces as `awaiting-approval` in the DSH GUI).

import { buildTools, SERVER_INFO } from "./tools.js";
import { createRouteHandler } from "./http.js";

const inject = ["dynamicCordisRunner", "agents", "cordisInspect", "webServer"];

function env() {
  try {
    return typeof process !== "undefined" && process.env ? process.env : {};
  } catch {
    return {};
  }
}

function apply(ctx) {
  const webServer = ctx.webServer;
  const environment = env();

  const path = (environment.DSH_MCP_PATH || "/mcp").replace(/\/+$/, "") || "/mcp";
  const token = environment.DSH_MCP_TOKEN ? String(environment.DSH_MCP_TOKEN) : undefined;
  const defaultSessionId = environment.DSH_MCP_DEFAULT_SESSION
    ? String(environment.DSH_MCP_DEFAULT_SESSION)
    : undefined;

  const tools = buildTools({
    runner: ctx.dynamicCordisRunner,
    agents: ctx.agents,
    inspect: ctx.cordisInspect,
    ctx,
    config: { defaultSessionId, path },
  });

  const handler = createRouteHandler({
    tools,
    serverInfo: SERVER_INFO,
    security: { token },
  });

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path,
        handler,
      }),
    `dsh-cordis-mcp: ${path} route`,
  );

  try {
    const base = `http://127.0.0.1:${webServer.port !== undefined ? webServer.port : "?"}`;
    console.log(
      `[dsh-cordis-mcp] MCP endpoint ready: ${base}${path}` +
        (token ? " (token-gated)" : " (no token — loopback only)") +
        (defaultSessionId ? `; default session ${defaultSessionId}` : "; session resolved per call"),
    );
  } catch {
    console.log(`[dsh-cordis-mcp] MCP endpoint ready at ${path} (token-gated: ${token !== undefined})`);
  }
}

export { apply, inject, buildTools, createRouteHandler, SERVER_INFO };
