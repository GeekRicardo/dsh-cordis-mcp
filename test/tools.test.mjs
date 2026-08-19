import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTools } from "../lib/tools.js";

// ── mock deps ──────────────────────────────────────────────────────────────

function makeFakeAgent(id) {
  return { id };
}

function makeDeps(overrides = {}) {
  const agents = new Map();
  const state = {
    plugins: new Map(), // pluginId -> {pluginId, sessionId, packages: Map, currentPackageId, nextPackageId, run, latestRun}
    defineCalls: [],
    runCalls: [],
    stopCalls: [],
    undefineCalls: [],
  };

  const runner = {
    listPlugins(agent) {
      const out = [];
      for (const plugin of state.plugins.values()) {
        if (plugin.sessionId !== agent.id) continue;
        out.push({
          pluginId: plugin.pluginId,
          name: plugin.packages.get(plugin.currentPackageId || [...plugin.packages.keys()].at(-1)).name,
          packages: [...plugin.packages.values()].map((p) => ({ packageId: p.packageId, name: p.name, purpose: p.purpose, hasHostHalf: p.hasHostHalf, hasClientHalf: p.hasClientHalf })),
          currentPackageId: plugin.currentPackageId,
          nextPackageId: plugin.nextPackageId,
          activeRun: plugin.run,
          latestRun: plugin.latestRun,
        });
      }
      return out;
    },
    inspectPlugin(agent, pluginId) {
      const plugin = state.plugins.get(pluginId);
      if (!plugin || plugin.sessionId !== agent.id) throw new Error(`dynamic plugin "${pluginId}" does not exist`);
      return {
        pluginId: plugin.pluginId,
        name: plugin.packages.get(plugin.currentPackageId || [...plugin.packages.keys()].at(-1)).name,
        packages: [...plugin.packages.values()].map((p) => ({ packageId: p.packageId, name: p.name, purpose: p.purpose, hasHostHalf: p.hasHostHalf, hasClientHalf: p.hasClientHalf })),
        currentPackageId: plugin.currentPackageId,
        nextPackageId: plugin.nextPackageId,
        activeRun: plugin.run,
        latestRun: plugin.latestRun,
      };
    },
    inspectPackage(agent, pluginId, packageId) {
      const plugin = state.plugins.get(pluginId);
      if (!plugin || plugin.sessionId !== agent.id) throw new Error(`dynamic plugin "${pluginId}" does not exist`);
      const pkg = plugin.packages.get(packageId);
      if (!pkg) throw new Error(`dynamic package "${packageId}" does not exist`);
      return {
        pluginId,
        packageId,
        name: pkg.name,
        purpose: pkg.purpose,
        code: pkg.code || {},
        currentPackageId: plugin.currentPackageId,
        nextPackageId: plugin.nextPackageId,
        activeRun: plugin.run,
        latestRun: plugin.latestRun,
      };
    },
    define(request) {
      state.defineCalls.push(request);
      let plugin;
      if (request.plugin.kind === "new") {
        plugin = { pluginId: `${request.plugin.idPrefix}-1`, sessionId: request.sessionId, packages: new Map(), run: undefined, latestRun: undefined };
        state.plugins.set(plugin.pluginId, plugin);
      } else {
        plugin = state.plugins.get(request.plugin.pluginId);
        if (!plugin || plugin.sessionId !== request.sessionId) throw new Error(`dynamic plugin "${request.plugin.pluginId}" does not exist`);
      }
      const packageId = `pkg-${plugin.packages.size + 1}`;
      plugin.packages.set(packageId, {
        packageId,
        name: request.name,
        purpose: request.purpose,
        hasHostHalf: request.code.host !== undefined,
        hasClientHalf: request.code.client !== undefined,
        code: request.code,
      });
      return {
        pluginId: plugin.pluginId,
        packageId,
        name: request.name,
        purpose: request.purpose,
        hasHostHalf: request.code.host !== undefined,
        hasClientHalf: request.code.client !== undefined,
      };
    },
    async run(agent, pluginId, packageId, mode) {
      state.runCalls.push({ agentId: agent.id, pluginId, packageId, mode });
      const plugin = state.plugins.get(pluginId);
      if (!plugin) return { ok: false, reason: "plugin-missing", message: "missing" };
      const receipt = {
        ok: true,
        status: "running",
        pluginRunId: `run-${state.runCalls.length}`,
        mode,
        currentPackageId: packageId,
        nextPackageId: packageId,
      };
      plugin.currentPackageId = packageId;
      plugin.nextPackageId = packageId;
      plugin.run = { pluginRunId: receipt.pluginRunId, packageId, fiber: { inject: {} } };
      plugin.latestRun = { status: "running", pluginRunId: receipt.pluginRunId, packageId, mode };
      return receipt;
    },
    async stop(agent, pluginId) {
      state.stopCalls.push({ agentId: agent.id, pluginId });
      const plugin = state.plugins.get(pluginId);
      if (!plugin) return { ok: false, reason: "plugin-missing", message: "missing" };
      if (!plugin.run) return { ok: false, reason: "not-running", message: "not running" };
      plugin.run = undefined;
      plugin.latestRun = { status: "stopped", pluginRunId: "x", packageId: plugin.currentPackageId, mode: "run" };
      return { ok: true };
    },
    async undefine(agent, pluginId) {
      state.undefineCalls.push({ agentId: agent.id, pluginId });
      const plugin = state.plugins.get(pluginId);
      if (!plugin) return { ok: false, reason: "plugin-missing", message: "missing" };
      const wasRunning = plugin.run !== undefined;
      state.plugins.delete(pluginId);
      return { ok: true, wasRunning };
    },
    snapshot() {
      return [...state.plugins.values()].map((plugin) => ({
        pluginId: plugin.pluginId,
        currentPackageId: plugin.currentPackageId,
        nextPackageId: plugin.nextPackageId,
        packages: [...plugin.packages.values()],
        activeRun: plugin.run,
        latestRun: plugin.latestRun,
      }));
    },
  };

  const ctx = {
    get() {
      return undefined;
    },
  };

  const deps = {
    runner,
    agents: {
      list: () => [...agents.values()],
      get: (id) => agents.get(id),
    },
    inspect: {
      list: () => [{ platform: "host", id: "Service", methods: [{ name: "listService" }] }],
      query: async (platform, provider, method, input) => ({ platform, provider, method, input }),
    },
    ctx,
    config: overrides.config || {},
    _state: state,
    _agents: agents,
  };
  return deps;
}

function registerPlugin(deps, pluginId, sessionId, pkgNames = [{ packageId: "pkg-1", name: "demo" }]) {
  const packages = new Map();
  for (const p of pkgNames) {
    packages.set(p.packageId, { packageId: p.packageId, name: p.name, purpose: "purpose", hasHostHalf: true, hasClientHalf: false, code: { host: "return {}" } });
  }
  deps._state.plugins.set(pluginId, {
    pluginId,
    sessionId,
    packages,
    currentPackageId: pkgNames[0].packageId,
    nextPackageId: pkgNames[0].packageId,
    run: undefined,
    latestRun: undefined,
  });
}

// ── session resolution ─────────────────────────────────────────────────────

test("session defaults to the sole live agent", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  const tools = buildTools(deps);
  const result = tools.dsh_plugins_list.handler({});
  assert.deepEqual(result, { mode: "plugins", plugins: [] });
});

test("explicit sessionId wins over the default", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  deps._agents.set("s2", makeFakeAgent("s2"));
  registerPlugin(deps, "demo-1", "s2");
  const tools = buildTools(deps);
  const result = tools.dsh_plugins_list.handler({ sessionId: "s2" });
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].pluginId, "demo-1");
});

test("ambiguous sessions without sessionId is an actionable error", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  deps._agents.set("s2", makeFakeAgent("s2"));
  const tools = buildTools(deps);
  assert.throws(() => tools.dsh_plugins_list.handler({}), /multiple live DSH sessions/);
});

test("configured default session is used when sessions are ambiguous", () => {
  const deps = makeDeps({ config: { defaultSessionId: "s2" } });
  deps._agents.set("s1", makeFakeAgent("s1"));
  deps._agents.set("s2", makeFakeAgent("s2"));
  registerPlugin(deps, "demo-1", "s2");
  const tools = buildTools(deps);
  const result = tools.dsh_plugins_list.handler({});
  assert.equal(result.plugins.length, 1);
});

test("unknown explicit sessionId is an actionable error", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  const tools = buildTools(deps);
  assert.throws(() => tools.dsh_plugins_list.handler({ sessionId: "nope" }), /no live DSH session/);
});

test("no live sessions is an actionable error", () => {
  const tools = buildTools(makeDeps());
  assert.throws(() => tools.dsh_plugins_list.handler({}), /no live DSH session/);
});

// ── list / inspect ─────────────────────────────────────────────────────────

test("dsh_plugins_list renders plugin summaries", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  registerPlugin(deps, "demo-1", "s1");
  const tools = buildTools(deps);
  const result = tools.dsh_plugins_list.handler({ sessionId: "s1" });
  assert.equal(result.plugins[0].pluginId, "demo-1");
  assert.equal(result.plugins[0].state, "stopped");
  assert.equal(result.plugins[0].packageCount, 1);
  assert.equal(result.plugins[0].currentPackageId, "pkg-1");
});

test("dsh_plugin_inspect lists packages; with packageId returns code", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  registerPlugin(deps, "demo-1", "s1");
  const tools = buildTools(deps);
  const plugin = tools.dsh_plugin_inspect.handler({ pluginId: "demo-1", sessionId: "s1" });
  assert.equal(plugin.mode, "plugin");
  assert.equal(plugin.packages[0].packageId, "pkg-1");
  const pkg = tools.dsh_plugin_inspect.handler({ pluginId: "demo-1", packageId: "pkg-1", sessionId: "s1" });
  assert.equal(pkg.mode, "package");
  assert.equal(pkg.code.host, "return {}");
  assert.throws(() => tools.dsh_plugin_inspect.handler({ pluginId: "nope", sessionId: "s1" }), /does not exist/);
  // sole live agent resolves implicitly
  const implicit = tools.dsh_plugin_inspect.handler({ pluginId: "demo-1", packageId: "pkg-1" });
  assert.equal(implicit.mode, "package");
});

// ── inspect providers / query ──────────────────────────────────────────────

test("dsh_inspect_providers returns the provider directory", () => {
  const tools = buildTools(makeDeps());
  const result = tools.dsh_inspect_providers.handler({});
  assert.equal(result.providers[0].id, "Service");
});

test("dsh_inspect_query validates platform and forwards", async () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  const tools = buildTools(deps);
  const result = await tools.dsh_inspect_query.handler({ platform: "host", provider: "Service", method: "listService", input: {}, sessionId: "s1" });
  assert.equal(result.method, "listService");
  await assert.rejects(tools.dsh_inspect_query.handler({ platform: "bogus", provider: "Service", method: "x", sessionId: "s1" }), /platform must be/);
});

// ── define ─────────────────────────────────────────────────────────────────

test("dsh_plugin_define kind new mints a plugin", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  const tools = buildTools(deps);
  const result = tools.dsh_plugin_define.handler({
    plugin: { kind: "new", idPrefix: "demo" },
    name: "Demo",
    purpose: "A demo package",
    code: { host: "return { apply() {} }" },
    sessionId: "s1",
  });
  assert.equal(result.pluginId, "demo-1");
  assert.equal(result.packageId, "pkg-1");
  assert.equal(result.hasHostHalf, true);
  assert.equal(result.hasClientHalf, false);
  const defineCall = deps._state.defineCalls[0];
  assert.equal(defineCall.sessionId, "s1");
  assert.equal(defineCall.code.host, "return { apply() {} }");
});

test("dsh_plugin_define kind existing appends a package", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  registerPlugin(deps, "demo-1", "s1");
  const tools = buildTools(deps);
  const result = tools.dsh_plugin_define.handler({
    plugin: { kind: "existing", pluginId: "demo-1" },
    name: "v2",
    purpose: "Second package",
    code: { client: "return { apply() {} }" },
    sessionId: "s1",
  });
  assert.equal(result.packageId, "pkg-2");
  assert.equal(result.hasClientHalf, true);
});

test("dsh_plugin_define validation errors", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  const tools = buildTools(deps);
  assert.throws(() => tools.dsh_plugin_define.handler({ plugin: { kind: "new" }, name: "x", purpose: "y", code: { host: "z" }, sessionId: "s1" }), /idPrefix/);
  assert.throws(() => tools.dsh_plugin_define.handler({ plugin: { kind: "bogus" }, name: "x", purpose: "y", code: { host: "z" }, sessionId: "s1" }), /must be 'new' or 'existing'/);
  assert.throws(() => tools.dsh_plugin_define.handler({ plugin: { kind: "new", idPrefix: "demo" }, name: "x", purpose: "y", sessionId: "s1" }), /code\.host, code\.client, or both/);
});

// ── run ────────────────────────────────────────────────────────────────────

test("dsh_plugin_run activates and reports running + host status", async () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  registerPlugin(deps, "demo-1", "s1");
  const tools = buildTools(deps);
  const result = await tools.dsh_plugin_run.handler({ pluginId: "demo-1", packageId: "pkg-1", mode: "run", sessionId: "s1" });
  assert.equal(result.status, "running");
  assert.equal(result.pluginRunId, "run-1");
  assert.equal(result.currentPackageId, "pkg-1");
  assert.equal(result.host.status, "running");
  assert.deepEqual(result.host.waitingFor, []);
  const runCall = deps._state.runCalls[0];
  assert.equal(runCall.mode, "run");
  assert.equal(runCall.agentId, "s1");
});

test("dsh_plugin_run validates mode", async () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  registerPlugin(deps, "demo-1", "s1");
  const tools = buildTools(deps);
  await assert.rejects(
    tools.dsh_plugin_run.handler({ pluginId: "demo-1", packageId: "pkg-1", mode: "sideways", sessionId: "s1" }),
    /mode must be 'run' or 'update'/,
  );
});

test("dsh_plugin_run surfaces run refusal as an error", async () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  const tools = buildTools(deps);
  await assert.rejects(
    tools.dsh_plugin_run.handler({ pluginId: "ghost", packageId: "pkg-1", mode: "run", sessionId: "s1" }),
    /missing/,
  );
});

// ── stop / undefine ────────────────────────────────────────────────────────

test("dsh_plugin_stop stops a running plugin and tolerates not-running", async () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  registerPlugin(deps, "demo-1", "s1");
  const tools = buildTools(deps);
  await tools.dsh_plugin_run.handler({ pluginId: "demo-1", packageId: "pkg-1", mode: "run", sessionId: "s1" });
  const stopped = await tools.dsh_plugin_stop.handler({ pluginId: "demo-1", sessionId: "s1" });
  assert.deepEqual(stopped, { pluginId: "demo-1" });
  const again = await tools.dsh_plugin_stop.handler({ pluginId: "demo-1", sessionId: "s1" });
  assert.deepEqual(again, { pluginId: "demo-1" });
  await assert.rejects(tools.dsh_plugin_stop.handler({ pluginId: "ghost", sessionId: "s1" }), /missing/);
});

test("dsh_plugin_undefine removes the plugin and reports wasRunning", async () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  registerPlugin(deps, "demo-1", "s1");
  const tools = buildTools(deps);
  const result = await tools.dsh_plugin_undefine.handler({ pluginId: "demo-1", sessionId: "s1" });
  assert.deepEqual(result, { pluginId: "demo-1", wasRunning: false });
  assert.equal(deps._state.plugins.has("demo-1"), false);
});

// ── status / sessions ──────────────────────────────────────────────────────

test("dsh_sessions lists live session ids", () => {
  const deps = makeDeps();
  deps._agents.set("s1", makeFakeAgent("s1"));
  deps._agents.set("s2", makeFakeAgent("s2"));
  const tools = buildTools(deps);
  assert.deepEqual(tools.dsh_sessions.handler({}), { sessions: [{ id: "s1" }, { id: "s2" }] });
});

test("dsh_status reports resolution and plugin count", () => {
  const deps = makeDeps({ config: { path: "/mcp", defaultSessionId: "s1" } });
  deps._agents.set("s1", makeFakeAgent("s1"));
  registerPlugin(deps, "demo-1", "s1");
  const tools = buildTools(deps);
  const result = tools.dsh_status.handler({});
  assert.equal(result.ok, true);
  assert.equal(result.session, "s1");
  assert.equal(result.pluginCount, 1);
  assert.equal(result.protocolPath, "/mcp");
});

test("buildTools refuses missing services", () => {
  assert.throws(() => buildTools({}), /dynamicCordisRunner/);
});
