import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

import { handleRequest } from "../lib/mcp-protocol.js";
import { createRouteHandler } from "../lib/http.js";

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

async function rpc(method, params, id = 1) {
  const res = await post(base, { jsonrpc: "2.0", id, method, params });
  return { status: res.status, body: await res.json() };
}

/**
 * Raw node:http request so we can set headers fetch forbids (Host) and send
 * bodies the server rejects mid-stream.
 */
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

test("initialize returns serverInfo and negotiated version", async () => {
  await startServer();
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
  await startServer();
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0" } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-03-26");

    const ack = await post(base, { jsonrpc: "2.0", method: "notifications/initialized" });
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
  await startServer();
  try {
    const get = await fetch(base);
    assert.equal(get.status, 405);

    const unknown = await rpc("resources/list", undefined, 5);
    assert.equal(unknown.body.error.code, -32601);

    const badJson = await post(base, "{not json");
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error.code, -32700);
  } finally {
    await stopServer();
  }
});

test("token gate: 401 without, 200 with", async () => {
  await startServer({ token: "s3cret" });
  try {
    const denied = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(denied.status, 401);

    const authHeader = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer s3cret" });
    assert.equal(authHeader.status, 200);
    assert.deepEqual((await authHeader.json()).result, {});

    const altHeader = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { "x-dsh-mcp-token": "s3cret" });
    assert.equal(altHeader.status, 200);
  } finally {
    await stopServer();
  }
});

test("non-loopback Host and cross-site requests are rejected", async () => {
  await startServer();
  try {
    const evilHost = await rawPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { host: "evil.example.com" });
    assert.equal(evilHost.status, 403);

    const crossSite = await post(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { "sec-fetch-site": "cross-site" });
    assert.equal(crossSite.status, 403);
  } finally {
    await stopServer();
  }
});

test("OPTIONS preflight gets 204 with no CORS headers", async () => {
  await startServer();
  try {
    const res = await fetch(base, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await stopServer();
  }
});

test("oversized body is rejected with 413", async () => {
  await startServer({ maxBodyBytes: 128 });
  try {
    const res = await rawPost("/mcp", "x".repeat(1024));
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
