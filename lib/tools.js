// dsh-cordis-mcp — tool surface over the DSH dynamic-Cordis runner.
//
// buildTools(deps) returns the MCP tool map consumed by the protocol and HTTP
// layers. `deps` is a small facade over the real host services so the whole
// file is unit-testable with mocks:
//
//   {
//     runner:  dynamicCordisRunner service,
//     agents:  agents service (list() / get(id)),
//     inspect: cordisInspect service (list() / query(...)),
//     ctx:     the plugin's Cordis Context (for ctx.get in fiber checks),
//     config:  { defaultSessionId?: string, path?: string }
//   }
//
// Every handler returns only lossless JSON data; live objects (agents, fibers,
// service instances) never cross the boundary.

import { invalidParams } from "./mcp-protocol.js";

export const SERVER_INFO = { name: "dsh-cordis-mcp", version: "1.0.0" };

export function buildTools(deps) {
  const runner = deps.runner;
  const agents = deps.agents;
  const inspect = deps.inspect;

  if (runner === undefined) throw new Error("dsh-cordis-mcp: dynamicCordisRunner service is unavailable");
  if (agents === undefined) throw new Error("dsh-cordis-mcp: agents service is unavailable");
  if (inspect === undefined) throw new Error("dsh-cordis-mcp: cordisInspect service is unavailable");

  // ── session resolution ─────────────────────────────────────────────────

  function liveSessionIds() {
    return agents.list().map((agent) => String(agent.id));
  }

  /**
   * Resolve the target Agent for a tool call.
   * Explicit sessionId wins; otherwise the configured default; otherwise the
   * single live session; otherwise an actionable error.
   */
  function resolveAgent(sessionId) {
    if (sessionId !== undefined) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw invalidParams("sessionId must be a non-empty string");
      }
      const agent = agents.get(sessionId);
      if (agent === undefined) {
        throw invalidParams(`no live DSH session "${sessionId}"; available: ${liveSessionIds().join(", ") || "none"}`);
      }
      return agent;
    }
    const configured = deps.config && deps.config.defaultSessionId;
    if (configured) {
      const agent = agents.get(configured);
      if (agent !== undefined) return agent;
    }
    const live = agents.list();
    if (live.length === 1) return live[0];
    if (live.length === 0) {
      throw invalidParams("no live DSH session to manage — open the DSH web GUI first, or pass sessionId");
    }
    throw invalidParams(`multiple live DSH sessions; pass sessionId to pick one (${liveSessionIds().join(", ")})`);
  }

  /** Services a fiber declared in inject but not yet resolvable. */
  function missingServices(fiber) {
    try {
      const names = Object.keys(fiber.inject || {});
      return names.filter((name) => deps.ctx.get(name) === undefined);
    } catch {
      return [];
    }
  }

  /** Resolve an Agent and return both the live object and its string id. */
  function requireAgent(sessionId) {
    const agent = resolveAgent(sessionId);
    return { agent, sessionId: String(agent.id) };
  }

  // ── shared JSON-safe rendering helpers ─────────────────────────────────

  function selfState(reference) {
    const status = reference && reference.latestRun && reference.latestRun.status;
    if (status === "awaiting-approval") return "awaiting-approval";
    if (status === "client-pending" || status === "starting-host") return "client-pending";
    if (status === "failed" || status === "rejected" || status === "cancelled") return "failed";
    if (status === "waiting") return "waiting";
    if (status === "running") return "running";
    if (reference && reference.activeRun !== undefined) return "running";
    return reference && reference.currentPackageId !== undefined ? "stopped" : "defined";
  }

  function pluginSummary(reference) {
    const latest = reference && reference.latestRun;
    const summary = {
      pluginId: String(reference.pluginId),
      name: reference.name,
      packageCount: reference.packages && reference.packages.length ? reference.packages.length : 1,
      state: selfState(reference),
    };
    if (reference.currentPackageId !== undefined) summary.currentPackageId = String(reference.currentPackageId);
    if (reference.nextPackageId !== undefined) summary.nextPackageId = String(reference.nextPackageId);
    if (reference.activeRun !== undefined) {
      summary.activeRun = {
        pluginRunId: String(reference.activeRun.pluginRunId),
        packageId: String(reference.activeRun.packageId),
      };
    }
    if (latest && latest.status === "awaiting-approval") {
      summary.pendingApproval = {
        pluginRunId: String(latest.pluginRunId),
        packageId: String(latest.packageId),
        mode: latest.mode,
      };
    }
    return summary;
  }

  function packageList(plugin) {
    return plugin.packages.map((pkg) => ({
      packageId: String(pkg.packageId),
      name: pkg.name,
      purpose: pkg.purpose,
      hasHostHalf: pkg.hasHostHalf === true,
      hasClientHalf: pkg.hasClientHalf === true,
      isCurrent: plugin.currentPackageId !== undefined && String(pkg.packageId) === String(plugin.currentPackageId),
      isNext: plugin.nextPackageId !== undefined && String(pkg.packageId) === String(plugin.nextPackageId),
    }));
  }

  /** Deep-copy an attempt object into scalar-only JSON (defensive). */
  function sanitize(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(sanitize);
    if (typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value)) {
        if (key === "fiber") continue; // live Cordis fiber — never cross the wire
        out[key] = sanitize(value[key]);
      }
      return out;
    }
    return String(value);
  }

  function inspectPackage(agent, pluginId, packageId) {
    const inspected = runner.inspectPackage(agent, pluginId, packageId);
    return {
      mode: "package",
      plugin: {
        pluginId: String(inspected.pluginId),
        name: inspected.name,
        purpose: inspected.purpose,
      },
      packageId: String(packageId),
      name: inspected.name,
      purpose: inspected.purpose,
      code: inspected.code,
      ...(inspected.currentPackageId === undefined ? {} : { currentPackageId: String(inspected.currentPackageId) }),
      ...(inspected.nextPackageId === undefined ? {} : { nextPackageId: String(inspected.nextPackageId) }),
      ...(inspected.activeRun === undefined
        ? {}
        : { activeRun: { pluginRunId: String(inspected.activeRun.pluginRunId), packageId: String(inspected.activeRun.packageId) } }),
      ...(inspected.latestRun === undefined ? {} : { latestRun: sanitize(inspected.latestRun) }),
    };
  }

  // ── tools ──────────────────────────────────────────────────────────────

  return {
    dsh_status: {
      description:
        "Report the dsh-cordis-mcp bridge status: server identity, MCP path, live DSH sessions, session resolution mode, and how many dynamic Cordis plugins exist for the resolved session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional target DSH session id (default: sole live session)." },
        },
      },
      handler(args) {
        const sessionId = args.sessionId;
        const live = agents.list().map((agent) => String(agent.id));
        let resolved = null;
        let resolutionError = null;
        try {
          resolved = requireAgent(sessionId).sessionId;
        } catch (error) {
          resolutionError = error instanceof Error ? error.message : String(error);
        }
        let pluginCount = 0;
        if (resolved !== null) {
          try {
            pluginCount = runner.listPlugins(agents.get(resolved)).length;
          } catch {
            pluginCount = -1;
          }
        }
        return {
          ok: true,
          server: SERVER_INFO,
          protocolPath: (deps.config && deps.config.path) || "/mcp",
          defaultSessionId: (deps.config && deps.config.defaultSessionId) || null,
          liveSessions: live,
          session: resolved,
          sessionResolutionError: resolutionError,
          pluginCount,
        };
      },
    },

    dsh_sessions: {
      description:
        "List the live DSH sessions (agents) this bridge can manage. Dynamic Cordis plugins are owned by a session; pass the chosen sessionId to the other dsh_* tools.",
      inputSchema: { type: "object", properties: {} },
      handler() {
        return { sessions: agents.list().map((agent) => ({ id: String(agent.id) })) };
      },
    },

    dsh_plugins_list: {
      description:
        "List every dynamic Cordis plugin owned by the target session with its state (defined / stopped / running / waiting / failed / client-pending / awaiting-approval) and version pointers. Equivalent to the DSH agent tool cordis_inspect_self with no arguments.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional target DSH session id." },
        },
      },
      handler(args) {
        const { agent } = requireAgent(args.sessionId);
        return {
          mode: "plugins",
          plugins: runner.listPlugins(agent).map((reference) => pluginSummary(reference)),
        };
      },
    },

    dsh_plugin_inspect: {
      description:
        "Inspect one dynamic Cordis plugin of the target session. With pluginId alone: version pointers, latest run, and every Package summary. With packageId too: additionally the immutable Host/Client source of that exact Package. Equivalent to the DSH agent tool cordis_inspect_self.",
      inputSchema: {
        type: "object",
        properties: {
          pluginId: { type: "string", description: "Stable dynamic Plugin id, e.g. probe-1." },
          packageId: { type: "string", description: "Optional exact immutable Package id, e.g. pkg-2." },
          sessionId: { type: "string", description: "Optional target DSH session id." },
        },
        required: ["pluginId"],
      },
      handler(args) {
        if (typeof args.pluginId !== "string" || args.pluginId.length === 0) {
          throw invalidParams("pluginId must be a non-empty string");
        }
        const { agent } = requireAgent(args.sessionId);
        if (args.packageId !== undefined) {
          if (typeof args.packageId !== "string" || args.packageId.length === 0) {
            throw invalidParams("packageId must be a non-empty string");
          }
          return inspectPackage(agent, args.pluginId, args.packageId);
        }
        const plugin = runner.inspectPlugin(agent, args.pluginId);
        return {
          mode: "plugin",
          ...pluginSummary(plugin),
          packages: packageList(plugin),
        };
      },
    },

    dsh_inspect_providers: {
      description:
        "List every Cordis Inspect provider known to this DSH host (host + client mirrors): platform, purpose, and each read-only method with its input/output schemas. Use dsh_inspect_query to run one of these methods. Equivalent to the DSH agent tool cordis_inspect_list.",
      inputSchema: { type: "object", properties: {} },
      handler() {
        return { providers: inspect.list() };
      },
    },

    dsh_inspect_query: {
      description:
        "Run one read-only Cordis Inspect provider query against the live DSH runtime: platform (host|client), exact provider id and method from dsh_inspect_providers, and optional JSON input. Host queries run locally; client queries wait for the browser page to answer. Equivalent to the DSH agent tool cordis_inspect_query.",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["host", "client"], description: "Runtime platform that owns the provider." },
          provider: { type: "string", description: "Exact provider id from dsh_inspect_providers." },
          method: { type: "string", description: "Exact method name declared by the provider." },
          input: { description: "Optional JSON input satisfying the method schema." },
          sessionId: { type: "string", description: "Optional target DSH session id." },
        },
        required: ["platform", "provider", "method"],
      },
      async handler(args) {
        if (args.platform !== "host" && args.platform !== "client") {
          throw invalidParams("platform must be 'host' or 'client'");
        }
        if (typeof args.provider !== "string" || typeof args.method !== "string") {
          throw invalidParams("provider and method must be strings");
        }
        const { agent } = requireAgent(args.sessionId);
        const data = await inspect.query(args.platform, args.provider, args.method, args.input, agent, undefined);
        return { platform: args.platform, provider: args.provider, method: args.method, data };
      },
    },

    dsh_plugin_define: {
      description:
        "Define an immutable Cordis Package on the target session. kind 'new' mints a plugin from a 3–6 lowercase-letter semantic prefix; kind 'existing' appends a Package to a plugin that session already owns. Provide at least one of code.host / code.client (plain JavaScript function bodies that return a Cordis Plugin). Define only records source and validates syntax — it does not activate anything; call dsh_plugin_run afterwards. Equivalent to the DSH agent tool cordis_define.",
      inputSchema: {
        type: "object",
        properties: {
          plugin: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["new", "existing"], description: "'new' mints a Plugin; 'existing' appends to one." },
              idPrefix: { type: "string", description: "kind=new: 3–6 lowercase English letters; the host adds a numeric suffix." },
              pluginId: { type: "string", description: "kind=existing: the plugin to append a Package to." },
            },
            required: ["kind"],
          },
          name: { type: "string", description: "Short, readable Package name." },
          purpose: { type: "string", description: "One-sentence, user-facing description of the Package purpose." },
          code: {
            type: "object",
            properties: {
              host: { type: "string", description: "Plain JS function body returning the Host-half Cordis Plugin." },
              client: { type: "string", description: "Plain JS function body returning the browser Client-half Cordis Plugin." },
            },
          },
          sessionId: { type: "string", description: "Optional target DSH session id." },
        },
        required: ["plugin", "name", "purpose"],
      },
      handler(args) {
        if (typeof args.name !== "string" || typeof args.purpose !== "string") {
          throw invalidParams("name and purpose must be strings");
        }
        const kind = args.plugin && args.plugin.kind;
        if (kind === "new") {
          if (typeof args.plugin.idPrefix !== "string") throw invalidParams("kind 'new' requires plugin.idPrefix");
        } else if (kind === "existing") {
          if (typeof args.plugin.pluginId !== "string") throw invalidParams("kind 'existing' requires plugin.pluginId");
        } else {
          throw invalidParams("plugin.kind must be 'new' or 'existing'");
        }
        const code = args.code === undefined || args.code === null ? {} : args.code;
        if (typeof code !== "object" || Array.isArray(code)) throw invalidParams("code must be an object");
        if (code.host === undefined && code.client === undefined) {
          throw invalidParams("provide code.host, code.client, or both");
        }
        if (code.host !== undefined && typeof code.host !== "string") throw invalidParams("code.host must be a string");
        if (code.client !== undefined && typeof code.client !== "string") throw invalidParams("code.client must be a string");
        const { sessionId } = requireAgent(args.sessionId);
        const plugin =
          kind === "new"
            ? { kind: "new", idPrefix: args.plugin.idPrefix }
            : { kind: "existing", pluginId: args.plugin.pluginId };
        const receipt = runner.define({
          sessionId,
          plugin,
          name: args.name,
          purpose: args.purpose,
          code: {
            ...(code.host === undefined ? {} : { host: code.host }),
            ...(code.client === undefined ? {} : { client: code.client }),
          },
        });
        return {
          pluginId: String(receipt.pluginId),
          packageId: String(receipt.packageId),
          name: receipt.name,
          purpose: receipt.purpose,
          hasHostHalf: receipt.hasHostHalf === true,
          hasClientHalf: receipt.hasClientHalf === true,
        };
      },
    },

    dsh_plugin_run: {
      description:
        "Activate one exact Package of a dynamic plugin. mode 'run' = first activation / restart current / rollback; mode 'update' = switch to a different Package when a current one exists. A Client half may need user approval in the DSH GUI (status awaiting-approval); an authorized one returns starting/running and completes asynchronously. Equivalent to the DSH agent tool cordis_run.",
      inputSchema: {
        type: "object",
        properties: {
          pluginId: { type: "string", description: "Stable dynamic Plugin id." },
          packageId: { type: "string", description: "Exact immutable Package id to activate." },
          mode: { type: "string", enum: ["run", "update"], description: "run = first/restart/rollback; update = switch versions." },
          sessionId: { type: "string", description: "Optional target DSH session id." },
        },
        required: ["pluginId", "packageId", "mode"],
      },
      async handler(args) {
        if (typeof args.pluginId !== "string" || typeof args.packageId !== "string") {
          throw invalidParams("pluginId and packageId must be strings");
        }
        if (args.mode !== "run" && args.mode !== "update") {
          throw invalidParams("mode must be 'run' or 'update'");
        }
        const { agent } = requireAgent(args.sessionId);
        const receipt = await runner.run(agent, args.pluginId, args.packageId, args.mode, undefined);
        if (receipt.ok !== true) {
          throw new Error(receipt.message || `run failed: ${receipt.reason || "unknown"}`);
        }
        const base = {
          status: receipt.status,
          pluginId: args.pluginId,
          packageId: args.packageId,
          pluginRunId: String(receipt.pluginRunId),
          mode: receipt.mode,
        };
        if (receipt.currentPackageId !== undefined) base.currentPackageId = String(receipt.currentPackageId);
        if (receipt.nextPackageId !== undefined) base.nextPackageId = String(receipt.nextPackageId);
        if (receipt.status !== "running") return base;
        // Running: report host/client activation detail without leaking live objects.
        let host = { status: "absent", waitingFor: [] };
        let client = { status: "absent", waitingFor: [] };
        try {
          const row = runner
            .snapshot(agent)
            .find((candidate) => String(candidate.pluginId) === args.pluginId);
          const fiber =
            row && row.activeRun && String(row.activeRun.pluginRunId) === String(receipt.pluginRunId)
              ? row.activeRun.fiber
              : undefined;
          if (fiber !== undefined) {
            const waiting = missingServices(fiber);
            host = { status: waiting.length === 0 ? "running" : "waiting", waitingFor: waiting };
          }
          if (Array.isArray(receipt.clientWaitingFor)) {
            client = {
              status: receipt.clientWaitingFor.length === 0 ? "running" : "waiting",
              waitingFor: receipt.clientWaitingFor,
            };
          }
        } catch {
          // Non-fatal: keep receipt-level status.
        }
        return { ...base, host, client };
      },
    },

    dsh_plugin_stop: {
      description:
        "Stop the current run of a dynamic plugin and cancel unfinished approval/activation requests. The Plugin, every Package, grants, and version pointers remain so it can run again later. Idempotent for an already-stopped plugin. Equivalent to the DSH agent tool cordis_stop.",
      inputSchema: {
        type: "object",
        properties: {
          pluginId: { type: "string", description: "Stable dynamic Plugin id." },
          sessionId: { type: "string", description: "Optional target DSH session id." },
        },
        required: ["pluginId"],
      },
      async handler(args) {
        if (typeof args.pluginId !== "string" || args.pluginId.length === 0) {
          throw invalidParams("pluginId must be a non-empty string");
        }
        const { agent } = requireAgent(args.sessionId);
        const receipt = await runner.stop(agent, args.pluginId);
        if (receipt.ok !== true && receipt.reason !== "not-running") {
          throw new Error(receipt.message || `stop failed: ${receipt.reason || "unknown"}`);
        }
        return { pluginId: args.pluginId };
      },
    },

    dsh_plugin_undefine: {
      description:
        "Permanently remove a dynamic plugin owned by the target session: stops it, cancels pending approval, deletes every Package, grant, and version pointer. Historical cards keep only a 'Plugin removed' record. Use dsh_plugin_stop instead when versions must remain available. Equivalent to the DSH agent tool cordis_undefine.",
      inputSchema: {
        type: "object",
        properties: {
          pluginId: { type: "string", description: "Stable dynamic Plugin id to remove permanently." },
          sessionId: { type: "string", description: "Optional target DSH session id." },
        },
        required: ["pluginId"],
      },
      async handler(args) {
        if (typeof args.pluginId !== "string" || args.pluginId.length === 0) {
          throw invalidParams("pluginId must be a non-empty string");
        }
        const { agent } = requireAgent(args.sessionId);
        const receipt = await runner.undefine(agent, args.pluginId);
        if (receipt.ok !== true) {
          throw new Error(receipt.message || `undefine failed: ${receipt.reason || "unknown"}`);
        }
        return { pluginId: args.pluginId, wasRunning: receipt.wasRunning === true };
      },
    },
  };
}
