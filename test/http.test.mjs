import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

import { handleRequest, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../lib/mcp-protocol.js";
import { createRouteHandler, timingSafeEqualString } from "../lib/http.js";

const TOKEN = "test-token-123";

const tools = {
  echo: {
    description: "Echo.",
    inputSchema: { type: "object" },
    handler: async (args) => ({ echoed: args }),
  },
  boom: {
    description: "Fails.",
    inputSchema: { type: "object" },
    handler: async () => {
      throw new Error("kaboom");
    },
  },
};

const serverInfo = { name: "dsh-cordis-mcp", version: "1.0.0" };

let server;
let base;
let port;

function startServer(security) {
  return new Promise((resolve) => {
    server = createServer(createRouteHandler({ tools, serverInfo, security }));
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      base = `http://127.0.0.1:${port}/mcp`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

function post(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function authedPost(url, body, headers = {}) {
  return post(url, body, { authorization: `Bearer ${TOKEN}`, ...headers });
}

async function rpc(method, params, id = 1, headers = {}) {
  const res = await authedPost(base, { jsonrpc: "2.0", id, method, params }, headers);
  return { status: res.status, body: await res.json() };
}

/** Raw node:http request so we can set headers fetch forbids (Host). */
function rawPost(path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// ── auth is mandatory ──────────────────────────────────────────────────────

test("without a token provider the endpoint refuses with 503 (never open)", async () => {
  await startServer({ getToken: () => null });
  try {
    const res = await post(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "auth-not-configured");
  } finally {
    await stopServer();
  }
});

test("without credentials the endpoint answers 401; with the token it works", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const denied = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(denied.status, 401);

    const ok = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).result, {});

    const alt = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { "x-dsh-mcp-token": TOKEN });
    assert.equal(alt.status, 200);
  } finally {
    await stopServer();
  }
});

test("getToken is evaluated per request, so a mid-flight change takes effect immediately", async () => {
  let current = "first-token";
  await startServer({ getToken: () => current });
  try {
    const a = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer first-token" });
    assert.equal(a.status, 200);

    current = "second-token";
    const stale = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer first-token" });
    assert.equal(stale.status, 401);

    const fresh = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer second-token" });
    assert.equal(fresh.status, 200);
  } finally {
    await stopServer();
  }
});

test("async getToken provider is awaited", async () => {
  await startServer({ getToken: () => Promise.resolve(TOKEN) });
  try {
    const ok = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(ok.status, 200);
  } finally {
    await stopServer();
  }
});

// ── protocol behavior (authenticated) ──────────────────────────────────────

test("initialize returns serverInfo and negotiated version", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const { status, body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    assert.equal(status, 200);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.result.serverInfo.name, "dsh-cordis-mcp");
    assert.equal(body.result.protocolVersion, "2025-06-18");
  } finally {
    await stopServer();
  }
});

test("full Claude Code handshake: initialize → initialized → tools/list → tools/call", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0" } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-03-26");

    const ack = await authedPost(base, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(ack.status, 202);
    assert.equal((await ack.text()).length, 0);

    const list = await rpc("tools/list", undefined, 2);
    assert.equal(list.status, 200);
    const names = list.body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["boom", "echo"]);
    assert.ok(list.body.result.tools[0].inputSchema);

    const call = await rpc("tools/call", { name: "echo", arguments: { hello: "world" } }, 3);
    assert.equal(call.status, 200);
    assert.deepEqual(JSON.parse(call.body.result.content[0].text), { echoed: { hello: "world" } });

    const boom = await rpc("tools/call", { name: "boom", arguments: {} }, 4);
    assert.equal(boom.body.result.isError, true);
    assert.match(boom.body.result.content[0].text, /kaboom/);
  } finally {
    await stopServer();
  }
});

test("GET and unknown methods are rejected with the right codes", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const get = await fetch(base, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(get.status, 405);

    const unknown = await rpc("resources/list", undefined, 5);
    assert.equal(unknown.body.error.code, -32601);

    const badJson = await authedPost(base, "{not json");
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error.code, -32700);
  } finally {
    await stopServer();
  }
});

test("non-loopback Host and cross-site requests are rejected before auth", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const evilHost = await rawPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { host: "evil.example.com", authorization: `Bearer ${TOKEN}` });
    assert.equal(evilHost.status, 403);

    const crossSite = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { "sec-fetch-site": "cross-site" });
    assert.equal(crossSite.status, 403);
  } finally {
    await stopServer();
  }
});

test("OPTIONS preflight gets 204 with no CORS headers", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await fetch(base, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await stopServer();
  }
});

test("oversized body is rejected with 413", async () => {
  await startServer({ getToken: () => TOKEN, maxBodyBytes: 128 });
  try {
    const res = await rawPost("/mcp", "x".repeat(1024), { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 413);
    assert.match(res.body, /exceeds/);
  } finally {
    await stopServer();
  }
});

test("handleRequest is importable for direct protocol tests", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, tools, serverInfo);
  assert.deepEqual(response, { id: 1, result: {} });
});

// ── constant-time token comparison ─────────────────────────────────────────

test("timingSafeEqualString matches only on equal strings", () => {
  assert.equal(timingSafeEqualString("abc", "abc"), true);
  assert.equal(timingSafeEqualString("", ""), true);
  assert.equal(timingSafeEqualString("abc", "abd"), false);
  assert.equal(timingSafeEqualString("abc", "abcd"), false, "a prefix is not a match");
  assert.equal(timingSafeEqualString("abcd", "abc"), false, "an extension is not a match");
  assert.equal(timingSafeEqualString("abc", ""), false);
});

test("timingSafeEqualString treats non-strings as empty rather than throwing", () => {
  assert.equal(timingSafeEqualString(undefined, "abc"), false);
  assert.equal(timingSafeEqualString(["abc"], "abc"), false);
  assert.equal(timingSafeEqualString(undefined, ""), true, "both sides collapse to the empty string");
});

test("a token that shares a long prefix is still rejected", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const near = `${TOKEN.slice(0, TOKEN.length - 1)}X`;
    const res = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: `Bearer ${near}` });
    assert.equal(res.status, 401);
  } finally {
    await stopServer();
  }
});

test("a repeated x-dsh-mcp-token header cannot smuggle a match", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    // node:http folds repeated non-special headers into "a, b"; the handler
    // must compare that folded value, not silently accept it.
    const res = await rawPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, {
      "x-dsh-mcp-token": ["wrong", TOKEN],
    });
    assert.equal(res.status, 401);
  } finally {
    await stopServer();
  }
});

// ── Origin validation (DNS-rebinding guard) ────────────────────────────────

test("a request with no Origin is allowed — that is the non-browser client", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await rawPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
  } finally {
    await stopServer();
  }
});

test("a foreign Origin is refused even with a valid token", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await rawPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, {
      authorization: `Bearer ${TOKEN}`,
      origin: "https://attacker.example",
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /Origin/);
  } finally {
    await stopServer();
  }
});

test("a loopback Origin on another port is refused", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await rawPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, {
      authorization: `Bearer ${TOKEN}`,
      origin: `http://127.0.0.1:${port === 65535 ? 1024 : port + 1}`,
    });
    assert.equal(res.status, 403);
  } finally {
    await stopServer();
  }
});

test("the opaque Origin \"null\" is refused", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await rawPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, {
      authorization: `Bearer ${TOKEN}`,
      origin: "null",
    });
    assert.equal(res.status, 403);
  } finally {
    await stopServer();
  }
});

test("the endpoint's own Origin is allowed", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await rawPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, {
      authorization: `Bearer ${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    assert.equal(res.status, 200);
  } finally {
    await stopServer();
  }
});

// ── MCP-Protocol-Version ───────────────────────────────────────────────────

test("a version header we speak is echoed back on the response", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      "mcp-protocol-version": "2025-03-26",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("mcp-protocol-version"), "2025-03-26");
  } finally {
    await stopServer();
  }
});

test("no version header still answers, stamped with the newest version we speak", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("mcp-protocol-version"), PROTOCOL_VERSION);
  } finally {
    await stopServer();
  }
});

test("a version header we do not speak is a 400 naming the ones we do", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await authedPost(base, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      "mcp-protocol-version": "1999-01-01",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "unsupported-protocol-version");
    assert.deepEqual(body.supported, SUPPORTED_PROTOCOL_VERSIONS);
  } finally {
    await stopServer();
  }
});

test("a notification carries the version stamp too", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await authedPost(base, { jsonrpc: "2.0", method: "notifications/initialized" }, {
      "mcp-protocol-version": "2024-11-05",
    });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("mcp-protocol-version"), "2024-11-05");
  } finally {
    await stopServer();
  }
});

// ── HTTP-level headers ─────────────────────────────────────────────────────

test("401 names the auth scheme in WWW-Authenticate", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") || "", /^Bearer /);
  } finally {
    await stopServer();
  }
});

test("405 lists the methods this endpoint accepts", async () => {
  await startServer({ getToken: () => TOKEN });
  try {
    const res = await fetch(base, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
  } finally {
    await stopServer();
  }
});
