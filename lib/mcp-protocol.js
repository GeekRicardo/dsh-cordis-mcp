// dsh-cordis-mcp — pure Model Context Protocol layer (streamable HTTP subset).
//
// This module is deliberately free of any DSH/Cordis dependency so it can be
// unit-tested standalone. It implements the JSON-RPC 2.0 subset a Claude Code
// HTTP client needs:
//
//   initialize            → serverInfo + negotiated protocolVersion
//   notifications/initialized → no response (202 at the HTTP layer)
//   ping                  → {}
//   tools/list            → tool payloads
//   tools/call            → { content, isError }
//   anything else         → JSON-RPC error -32601
//
// Responses are returned as plain JSON (the streamable HTTP spec permits a
// single application/json response for one request); the HTTP layer decides
// the wire format. Notifications resolve to `null`.

export const PROTOCOL_VERSION = "2025-06-18";

// Versions we can answer an `initialize` with. The client's own version is
// echoed back when it is one of these, otherwise our newest supported one.
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

// JSON-RPC 2.0 error codes.
export const CODE_PARSE_ERROR = -32700;
export const CODE_INVALID_REQUEST = -32600;
export const CODE_METHOD_NOT_FOUND = -32601;
export const CODE_INVALID_PARAMS = -32602;
export const CODE_INTERNAL_ERROR = -32603;

/** Error carrying a JSON-RPC error code. Throw it from a tool handler. */
export class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

export function invalidParams(message) {
  return new McpError(CODE_INVALID_PARAMS, message);
}

/**
 * Handle one decoded JSON-RPC message.
 *
 * @param {unknown} message - parsed request body (any JSON value).
 * @param {Record<string, {description: string, inputSchema: object, handler: (args: object) => Promise<unknown>|unknown}>} tools
 * @param {{name: string, version: string}} serverInfo
 * @returns {null | {id: unknown, result: unknown} | {id: unknown, error: {code: number, message: string, data?: unknown}}}
 *   - `null` for notifications (caller answers 202 with an empty body).
 *   - otherwise a JSON-RPC response object ready for JSON.stringify.
 */
export async function handleRequest(message, tools, serverInfo) {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return errorResponse(undefined, CODE_INVALID_REQUEST, "Request must be a JSON-RPC 2.0 object");
  }
  if (message.jsonrpc !== "2.0") {
    return errorResponse(message.id, CODE_INVALID_REQUEST, 'Request must declare "jsonrpc": "2.0"');
  }
  if (typeof message.method !== "string") {
    return errorResponse(message.id, CODE_INVALID_REQUEST, "Request must declare a string `method`");
  }

  const id = message.id;
  const isNotification = id === undefined || id === null;
  const params = message.params === undefined ? {} : message.params;

  try {
    switch (message.method) {
      case "initialize": {
        if (isNotification) return null;
        const requested = params && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : PROTOCOL_VERSION;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSION;
        return {
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: serverInfo.name,
              version: serverInfo.version,
            },
          },
        };
      }
      case "notifications/initialized":
        return null;
      case "ping":
        return isNotification ? null : { id, result: {} };
      case "tools/list":
        if (isNotification) return null;
        return { id, result: { tools: toolPayloads(tools) } };
      case "tools/call": {
        if (isNotification) return null;
        if (typeof params.name !== "string" || params.name.length === 0) {
          return errorResponse(id, CODE_INVALID_PARAMS, "tools/call requires a string `name`");
        }
        const tool = tools[params.name];
        if (tool === undefined) {
          return errorResponse(id, CODE_METHOD_NOT_FOUND, `Unknown tool: ${params.name}`);
        }
        const args = params.arguments === undefined || params.arguments === null
          ? {}
          : params.arguments;
        if (typeof args !== "object" || Array.isArray(args)) {
          return errorResponse(id, CODE_INVALID_PARAMS, "tools/call `arguments` must be an object");
        }
        return callTool(tool, id, args);
      }
      default:
        return errorResponse(id, CODE_METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  } catch (error) {
    return errorResponse(id, CODE_INTERNAL_ERROR, internalMessage(error));
  }
}

/** Run one tool handler and shape the `tools/call` result. */
async function callTool(tool, id, args) {
  let value;
  try {
    value = await tool.handler(args);
  } catch (error) {
    if (error instanceof McpError) {
      return errorResponse(id, error.code, error.message, error.data);
    }
    return {
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: internalMessage(error) }],
      },
    };
  }
  return {
    id,
    result: {
      content: [{ type: "text", text: stringifyJson(value) }],
    },
  };
}

function toolPayloads(tools) {
  return Object.keys(tools).map((name) => {
    const tool = tools[name];
    const payload = {
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    return payload;
  });
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { id, error };
}

function internalMessage(error) {
  if (error instanceof Error && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Stringify a tool result for the `text` content block. */
export function stringifyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
