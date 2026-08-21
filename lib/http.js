// dsh-cordis-mcp — HTTP layer for the MCP endpoint.
//
// Rides the DSH `webServer` route registration: the handler receives the raw
// Node `req`/`res` (same shape dsh-balance uses for /dsh-balance/status), so
// this module implements MCP streamable-HTTP on top of plain node:http
// semantics without importing any Node builtin itself.
//
// Security posture (this endpoint can define/run/remove plugins — treat it as
// shell access):
//   - only loopback Host headers are accepted;
//   - cross-site browser requests (sec-fetch-site: cross-site) are rejected;
//   - no CORS headers are ever emitted, so a browser page cannot read replies;
//   - a bearer token (Authorization or X-DSH-MCP-Token) is MANDATORY for every
//     request: the token comes from a `getToken()` provider that the host
//     wires to Settings/env/auto-generated, and a missing provider config
//     answers 503 so the endpoint can never be reached unauthenticated;
//   - the token is compared without an early return on the first differing
//     character, so a wrong token costs the same time whatever its prefix.

import {
  CODE_INVALID_REQUEST,
  CODE_PARSE_ERROR,
  handleRequest,
  stringifyJson,
} from "./mcp-protocol.js";

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isTrustedHost(req) {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = host.split(":")[0];
  if (hostname.startsWith("[") && hostname.endsWith("]")) return isLoopbackHostname(hostname);
  return isLoopbackHostname(hostname);
}

/**
 * Compare two strings without returning early on the first differing character.
 *
 * `a !== b` bails out at the first mismatching byte, so the time it takes to
 * reject a guess grows with how much of the token the guess got right — the
 * classic oracle for recovering a secret one character at a time. This walks
 * the full length of the longer string every time and folds the length
 * difference into the same accumulator, so the answer depends on no early exit.
 * (The loop count itself still follows the longer input's length; that leaks
 * the *length* of a guess, which the guesser already knows.)
 *
 * node:crypto's `timingSafeEqual` would be the usual tool, but this module is
 * deliberately free of Node builtin imports so it stays unit-testable as a
 * plain function of `req`/`res` shapes.
 */
export function timingSafeEqualString(a, b) {
  const left = typeof a === "string" ? a : "";
  const right = typeof b === "string" ? b : "";
  const span = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < span; i += 1) {
    const l = i < left.length ? left.charCodeAt(i) : 0;
    const r = i < right.length ? right.charCodeAt(i) : 0;
    diff |= l ^ r;
  }
  return diff === 0;
}

function writeJson(res, status, body, extraHeaders) {
  const payload = typeof body === "string" ? body : stringifyJson(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

/**
 * Build the webServer route handler for one MCP endpoint.
 *
 * Authentication is mandatory. `security.getToken` is called per request so a
 * token configured in Settings mid-flight takes effect immediately; it may be
 * async. A static `security.token` string is still accepted as a shorthand.
 *
 * @param {object} options
 * @param {Record<string, {description: string, inputSchema: object, handler: Function}>} options.tools
 * @param {{name: string, version: string}} options.serverInfo
 * @param {{getToken?: () => (string | null | undefined) | Promise<string | null | undefined>, token?: string, maxBodyBytes?: number, requireLoopback?: boolean}} [options.security]
 * @returns {async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRouteHandler({ tools, serverInfo, security }) {
  const getToken =
    security && typeof security.getToken === "function"
      ? security.getToken
      : () => (security && security.token ? String(security.token) : undefined);
  const maxBodyBytes = (security && security.maxBodyBytes) || DEFAULT_MAX_BODY_BYTES;
  const requireLoopback = security === undefined || security.requireLoopback !== false;

  return async function mcpRouteHandler(req, res) {
    if (requireLoopback && !isTrustedHost(req)) {
      writeJson(res, 403, { error: "forbidden", message: "dsh-cordis-mcp only accepts loopback requests" });
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      writeJson(res, 403, { error: "forbidden", message: "cross-site requests are not allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      // Preflights carry no credentials by design; answer before auth.
      // Deliberately no CORS headers: this endpoint must stay unreadable from
      // other origins. An empty 204 still lets same-origin tooling preflight.
      res.writeHead(204, { "content-length": "0" });
      res.end();
      return;
    }
    let token;
    try {
      token = await getToken();
    } catch {
      token = undefined;
    }
    if (typeof token !== "string" || token.length === 0) {
      // The endpoint is never open: without a configured token we refuse to
      // serve at all rather than degrade to unauthenticated access.
      writeJson(res, 503, {
        error: "auth-not-configured",
        message: "MCP auth token is not configured; set it in DSH Settings → dsh-cordis-mcp",
      });
      return;
    }
    const auth = req.headers.authorization || "";
    const alt = req.headers["x-dsh-mcp-token"] || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    // Both headers are always compared — no `||` short-circuit — so the reply
    // time doesn't depend on which header carried the guess either.
    const bearerOk = timingSafeEqualString(bearer, token);
    const altOk = timingSafeEqualString(Array.isArray(alt) ? alt[0] : alt, token);
    if (!bearerOk && !altOk) {
      writeJson(res, 401, { error: "unauthorized", message: "missing or invalid bearer token" });
      return;
    }

    if (req.method !== "POST") {
      writeJson(res, 405, {
        jsonrpc: "2.0",
        id: null,
        error: { code: CODE_INVALID_REQUEST, message: "dsh-cordis-mcp accepts POST only" },
      });
      return;
    }

    let bodyText;
    try {
      bodyText = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error && error.code === "BODY_TOO_LARGE") {
        writeJson(res, 413, {
          jsonrpc: "2.0",
          id: null,
          error: { code: CODE_PARSE_ERROR, message: `request body exceeds ${maxBodyBytes} bytes` },
        });
        return;
      }
      writeJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: CODE_PARSE_ERROR, message: "failed to read request body" },
      });
      return;
    }

    let message;
    try {
      message = bodyText.length === 0 ? {} : JSON.parse(bodyText);
    } catch {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: CODE_PARSE_ERROR, message: "request body is not valid JSON" },
      });
      return;
    }

    const response = await handleRequest(message, tools, serverInfo);
    if (response === null) {
      // Notification: 202 Accepted, empty body.
      res.writeHead(202, { "content-length": "0" });
      res.end();
      return;
    }
    writeJson(res, 200, {
      jsonrpc: "2.0",
      ...response,
    });
  };
}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Drain the rest instead of destroying the socket so the 413 response
        // can still be delivered to the client cleanly.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}
