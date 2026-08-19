import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL_VERSION,
  CODE_METHOD_NOT_FOUND,
  CODE_INVALID_REQUEST,
  CODE_INVALID_PARAMS,
  McpError,
  handleRequest,
} from "../lib/mcp-protocol.js";

const serverInfo = { name: "dsh-cordis-mcp", version: "1.0.0" };

const echoTool = {
  description: "Echo arguments back.",
  inputSchema: { type: "object" },
  handler: async (args) => ({ echoed: args }),
};

const boomTool = {
  description: "Always fails.",
  inputSchema: { type: "object" },
  handler: async () => {
    throw new Error("kaboom");
  },
};

const invalidTool = {
  description: "Invalid params.",
  inputSchema: { type: "object" },
  handler: () => {
    throw new McpError(CODE_INVALID_PARAMS, "bad input");
  },
};

const tools = { echo: echoTool, boom: boomTool, invalid: invalidTool };

test("initialize echoes a supported protocol version", async () => {
  const response = await handleRequest(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } },
    tools,
    serverInfo,
  );
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2025-03-26");
  assert.equal(response.result.serverInfo.name, "dsh-cordis-mcp");
  assert.deepEqual(response.result.capabilities, { tools: {} });
});

test("initialize falls back to the newest supported version", async () => {
  const response = await handleRequest(
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } },
    tools,
    serverInfo,
  );
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
});

test("initialize without protocolVersion uses the default", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 3, method: "initialize" }, tools, serverInfo);
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
});

test("notifications resolve to null (no response)", async () => {
  const initialized = await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, tools, serverInfo);
  assert.equal(initialized, null);
  const pingNotification = await handleRequest({ jsonrpc: "2.0", method: "ping" }, tools, serverInfo);
  assert.equal(pingNotification, null);
  const callNotification = await handleRequest({ jsonrpc: "2.0", method: "tools/call", params: { name: "echo", arguments: { a: 1 } } }, tools, serverInfo);
  assert.equal(callNotification, null);
});

test("ping returns an empty result", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 7, method: "ping" }, tools, serverInfo);
  assert.deepEqual(response.result, {});
});

test("tools/list returns the tool payloads", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 8, method: "tools/list" }, tools, serverInfo);
  assert.equal(response.result.tools.length, 3);
  const names = response.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["boom", "echo", "invalid"]);
  assert.equal(response.result.tools[0].inputSchema.type, "object");
});

test("tools/call returns a text content block", async () => {
  const response = await handleRequest(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo", arguments: { hello: "world" } } },
    tools,
    serverInfo,
  );
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(response.result.content[0].text), { echoed: { hello: "world" } });
});

test("tools/call handler throw becomes isError content, not a protocol error", async () => {
  const response = await handleRequest(
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "boom", arguments: {} } },
    tools,
    serverInfo,
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /kaboom/);
});

test("tools/call McpError becomes a JSON-RPC error with its code", async () => {
  const response = await handleRequest(
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "invalid", arguments: {} } },
    tools,
    serverInfo,
  );
  assert.equal(response.error.code, CODE_INVALID_PARAMS);
  assert.equal(response.error.message, "bad input");
});

test("tools/call with missing name and unknown tool", async () => {
  const noName = await handleRequest({ jsonrpc: "2.0", id: 12, method: "tools/call", params: {} }, tools, serverInfo);
  assert.equal(noName.error.code, CODE_INVALID_PARAMS);
  const unknown = await handleRequest(
    { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "nope", arguments: {} } },
    tools,
    serverInfo,
  );
  assert.equal(unknown.error.code, CODE_METHOD_NOT_FOUND);
});

test("unknown method is a -32601 error", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 14, method: "resources/list" }, tools, serverInfo);
  assert.equal(response.error.code, CODE_METHOD_NOT_FOUND);
});

test("malformed requests are invalid-request errors", async () => {
  for (const bad of [null, 42, "x", [], { id: 1, method: "ping" }, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }]) {
    const response = await handleRequest(bad, tools, serverInfo);
    assert.equal(response.error.code, CODE_INVALID_REQUEST, `expected invalid request for ${JSON.stringify(bad)}`);
  }
});

test("internal tool exceptions surface as internal-error JSON-RPC responses", async () => {
  const exploding = {
    description: "throws synchronously",
    inputSchema: { type: "object" },
    handler: () => {
      throw new TypeError("sync boom");
    },
  };
  const response = await handleRequest(
    { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "x", arguments: {} } },
    { x: exploding },
    serverInfo,
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /sync boom/);
});
