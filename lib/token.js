// dsh-cordis-mcp — pure auth-token helpers (no DSH/Cordis dependencies).
//
// The MCP endpoint is never open: authentication is mandatory. The effective
// token comes from Settings (user-configured in the DSH settings page), falls
// back to the DSH_MCP_TOKEN environment variable, and if neither exists the
// host auto-generates one and persists it into Settings so it stays stable
// across restarts and is visible on the settings page.

import { randomBytes } from "node:crypto";

/**
 * Generate a URL-safe random token.
 * @param {number} bytes - entropy bytes; 24 → 32 base64url chars.
 * @returns {string}
 */
export function generateToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Resolve the configured token, in order: Settings value, then env value.
 * Empty/whitespace values count as unset. Returns null when neither exists.
 *
 * @param {{settingsToken?: unknown, envToken?: unknown}} input
 * @returns {string | null}
 */
export function resolveConfiguredToken({ settingsToken, envToken }) {
  if (typeof settingsToken === "string" && settingsToken.trim().length > 0) {
    return settingsToken.trim();
  }
  if (typeof envToken === "string" && envToken.trim().length > 0) {
    return envToken.trim();
  }
  return null;
}
