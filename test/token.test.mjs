import { test } from "node:test";
import assert from "node:assert/strict";

import { generateToken, resolveConfiguredToken } from "../lib/token.js";

test("generateToken returns a 32-char base64url token", () => {
  const token = generateToken();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(token, generateToken(), "tokens must be unique");
});

test("generateToken honors a custom byte count", () => {
  assert.match(generateToken(12), /^[A-Za-z0-9_-]{16}$/);
});

test("resolveConfiguredToken prefers the settings token over env", () => {
  assert.equal(
    resolveConfiguredToken({ settingsToken: "settings-token", envToken: "env-token" }),
    "settings-token",
  );
});

test("resolveConfiguredToken falls back to env when settings is empty", () => {
  assert.equal(resolveConfiguredToken({ settingsToken: "", envToken: "env-token" }), "env-token");
  assert.equal(resolveConfiguredToken({ settingsToken: "   ", envToken: "env-token" }), "env-token");
  assert.equal(resolveConfiguredToken({ settingsToken: undefined, envToken: "env-token" }), "env-token");
});

test("resolveConfiguredToken returns null when both are unset", () => {
  assert.equal(resolveConfiguredToken({ settingsToken: "", envToken: "" }), null);
  assert.equal(resolveConfiguredToken({ settingsToken: undefined, envToken: undefined }), null);
  assert.equal(resolveConfiguredToken({}), null);
});

test("resolveConfiguredToken trims configured values", () => {
  assert.equal(resolveConfiguredToken({ settingsToken: "  abc  ", envToken: "x" }), "abc");
});
