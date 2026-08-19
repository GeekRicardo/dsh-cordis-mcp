// dsh-cordis-mcp — host face.
//
// Exposes DSH's dynamic-Cordis toolset (inspect / define / run / stop /
// undefine) to external MCP clients such as Claude Code, over the existing
// `webServer` route table. One route, default `/mcp`:
//
//   claude mcp add dsh --transport http http://127.0.0.1:8090/mcp
//
// Authentication is MANDATORY — the endpoint is never open. The bearer token
// is configured in DSH Settings → dsh-cordis-mcp (persisted via the `settings`
// service); the DSH_MCP_TOKEN env var is the fallback; if neither exists a
// random token is generated and persisted on first use, and is shown on the
// settings page for copying into Claude Code.
//
// The bridge is loopback-only and manages dynamic plugins for one DSH session
// at a time: explicit sessionId per call, else DSH_MCP_DEFAULT_SESSION, else
// the sole live session. Dynamic plugins are process-local and session-owned —
// a Claude Code run can define, run, update, stop, and permanently remove the
// same plugins the GUI session sees, with the same approval semantics.

import z from "@deepseek-ai/schemastery";
import { buildTools, SERVER_INFO } from "./tools.js";
import { createRouteHandler, isLoopbackHostname, readBody } from "./http.js";
import { generateToken, resolveConfiguredToken } from "./token.js";

const inject = ["dynamicCordisRunner", "agents", "cordisInspect", "webServer", "settings"];

const SETTINGS_NS = "dsh-cordis-mcp";
const SETTINGS_ROUTE = "/dsh-cordis-mcp/settings";
const MAX_SETTINGS_BODY_BYTES = 64 * 1024;

function env() {
  try {
    return typeof process !== "undefined" && process.env ? process.env : {};
  } catch {
    return {};
  }
}

/** Loopback host + same-origin browser check for the settings route. */
function isSameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = host.split(":")[0];
  if (hostname.startsWith("[") && hostname.endsWith("]") && !isLoopbackHostname(hostname)) return false;
  if (!isLoopbackHostname(hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true; // non-browser loopback client
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function apply(ctx) {
  const webServer = ctx.webServer;
  const settings = ctx.settings;
  const environment = env();

  const path = (environment.DSH_MCP_PATH || "/mcp").replace(/\/+$/, "") || "/mcp";
  const envToken = environment.DSH_MCP_TOKEN ? String(environment.DSH_MCP_TOKEN) : undefined;
  const defaultSessionId = environment.DSH_MCP_DEFAULT_SESSION
    ? String(environment.DSH_MCP_DEFAULT_SESSION)
    : undefined;

  // Settings namespace: the user-owned token. Registered on this plugin's
  // fiber, so stopping/removing the bundle unwinds the namespace with it.
  const scope = settings.register(SETTINGS_NS, z.object({ token: z.string().default("") }));

  const tools = buildTools({
    runner: ctx.dynamicCordisRunner,
    agents: ctx.agents,
    inspect: ctx.cordisInspect,
    ctx,
    config: { defaultSessionId, path },
  });

  // ── auth token resolution ───────────────────────────────────────────────

  let bootstrapPromise = null;

  /** Effective token: Settings → env → auto-generated (persisted). */
  function ensureToken() {
    const configured = resolveConfiguredToken({
      settingsToken: scope.get() && scope.get().token,
      envToken,
    });
    if (configured) return Promise.resolve(configured);
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      const generated = generateToken();
      try {
        await settings.update(SETTINGS_NS, { token: generated });
      } catch (error) {
        console.error("[dsh-cordis-mcp] failed to persist auto-generated token", error);
      }
      return generated;
    })().finally(() => {
      bootstrapPromise = null;
    });
    return bootstrapPromise;
  }

  // ── settings page state (same-origin route, no MCP token needed) ────────

  async function settingsState() {
    const token = await ensureToken();
    return {
      ok: true,
      server: SERVER_INFO,
      path,
      requireAuth: true,
      token,
      defaultSessionId: defaultSessionId || null,
      sessions: ctx.agents.list().map((agent) => String(agent.id)),
    };
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: SETTINGS_ROUTE,
        handler: async (req, res) => {
          if (!isSameOrigin(req)) {
            writeJson(res, 403, { ok: false, error: "forbidden" });
            return;
          }
          try {
            if (req.method === "GET") {
              writeJson(res, 200, await settingsState());
              return;
            }
            if (req.method === "POST") {
              let body;
              try {
                body = JSON.parse(await readBody(req, MAX_SETTINGS_BODY_BYTES));
              } catch {
                writeJson(res, 400, { ok: false, error: "invalid JSON body" });
                return;
              }
              const action = body && body.action;
              if (action === "set-token") {
                if (typeof body.token !== "string") {
                  writeJson(res, 400, { ok: false, error: "token must be a string (empty string clears the setting)" });
                  return;
                }
                await settings.update(SETTINGS_NS, { token: body.token.trim() });
                writeJson(res, 200, await settingsState());
                return;
              }
              if (action === "regenerate-token") {
                await settings.update(SETTINGS_NS, { token: generateToken() });
                writeJson(res, 200, await settingsState());
                return;
              }
              writeJson(res, 400, { ok: false, error: `unknown action: ${action}` });
              return;
            }
            writeJson(res, 405, { ok: false, error: "method not allowed" });
          } catch (error) {
            writeJson(res, 500, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    `dsh-cordis-mcp: ${SETTINGS_ROUTE} settings route`,
  );

  // ── MCP endpoint (auth mandatory) ───────────────────────────────────────

  const mcpHandler = createRouteHandler({
    tools,
    serverInfo: SERVER_INFO,
    security: { getToken: () => ensureToken() },
  });

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path,
        handler: mcpHandler,
      }),
    `dsh-cordis-mcp: ${path} MCP route`,
  );

  try {
    const base = `http://127.0.0.1:${webServer.port !== undefined ? webServer.port : "?"}`;
    console.log(
      `[dsh-cordis-mcp] MCP endpoint ready: ${base}${path} — auth MANDATORY; configure/copy the token in DSH Settings → dsh-cordis-mcp` +
        (defaultSessionId ? `; default session ${defaultSessionId}` : "; session resolved per call"),
    );
  } catch {
    console.log(`[dsh-cordis-mcp] MCP endpoint ready at ${path} — auth MANDATORY; token in Settings → dsh-cordis-mcp`);
  }
}

export { apply, inject, buildTools, createRouteHandler, SERVER_INFO };
