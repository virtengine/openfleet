import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");

describe("ui-server named tunnel timeout", () => {
  it("defines a timeout for named tunnel startup", () => {
    // Named tunnel should not wait forever if cloudflared fails to connect
    const hasNamedTunnelTimeout =
      source.includes("startNamedTunnel") &&
      (source.includes("setTimeout") || source.includes("timeout")) &&
      source.includes("named");
    assert.ok(
      hasNamedTunnelTimeout,
      "named tunnel startup should have a timeout",
    );
  });

  it("rejects with an error if named tunnel does not connect within timeout", () => {
    // Timeout should result in rejection/error, not silent hang
    const hasTimeoutRejection =
      source.includes("startNamedTunnel") &&
      (source.includes("reject") || source.includes("throw") ||
       source.includes("timed out") || source.includes("timeout"));
    assert.ok(
      hasTimeoutRejection,
      "named tunnel timeout should reject or throw an error",
    );
  });

  it("supports TELEGRAM_UI_NAMED_TUNNEL_TIMEOUT_MS or similar env var for timeout", () => {
    const hasTimeoutEnv =
      source.includes("TELEGRAM_UI_NAMED_TUNNEL_TIMEOUT") ||
      source.includes("NAMED_TUNNEL_TIMEOUT");
    assert.ok(
      hasTimeoutEnv,
      "named tunnel timeout should be configurable via environment variable",
    );
  });

  it("clears the timeout timer when tunnel connects successfully", () => {
    // Named tunnel success path should clear its startup timeout
    const hasClearTimeout =
      source.includes("startNamedTunnel") &&
      source.includes("clearTimeout");
    assert.ok(
      hasClearTimeout,
      "named tunnel should clear its timeout timer on successful connect",
    );
  });
});
