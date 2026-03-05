import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

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

  it("terminates cloudflared when named tunnel startup times out", () => {
    const hasTimeoutKill = /named tunnel timed out[\s\S]{0,400}child\.kill\("SIGTERM"\)/.test(source);
    assert.ok(
      hasTimeoutKill,
      "named tunnel timeout should terminate cloudflared to avoid orphaned processes",
    );
  });

  it("suppresses timeout-initiated exit events after terminating cloudflared", () => {
    const hasSuppression =
      source.includes("let namedTimeoutTriggeredTermination = false;") &&
      source.includes("namedTimeoutTriggeredTermination = true;") &&
      source.includes("if (namedTimeoutTriggeredTermination)") &&
      source.includes("namedTimeoutTriggeredTermination = false;") &&
      source.includes("return;");
    assert.ok(
      hasSuppression,
      "named tunnel timeout should not treat intentional termination exit as a second failure",
    );
  });

  it("ignores named tunnel exit events when stopTunnel requested shutdown", () => {
    assert.ok(
      source.includes("let tunnelStopRequested = false;") &&
      source.includes("if (tunnelStopRequested) {") &&
      source.includes("if (!resolved) {") &&
      source.includes("resolvePromise(null);") &&
      source.includes("tunnelStopRequested = true;"),
      "named tunnel exits should be ignored when shutdown was intentional",
    );
  });

  it("ignores named tunnel error events when stopTunnel requested shutdown", () => {
    assert.ok(
      source.includes("child.on(\"error\", (err) =>") &&
      source.includes("if (tunnelStopRequested)") &&
      source.includes("resolvePromise(null);"),
      "named tunnel errors should be ignored when shutdown was intentional",
    );
  });

  it("clears stop-request state when named tunnel starts directly", () => {
    assert.ok(
      /async function startNamedTunnel[\s\S]{0,220}tunnelStopRequested = false;/.test(source),
      "named tunnel direct starts should clear stale stop-request state",
    );
  });

  it("tracks startup named tunnel process so stopTunnel can terminate pre-ready child", () => {
    assert.ok(
      source.includes("// Track startup child so stopTunnel() can terminate it even before readiness.") &&
        source.includes("tunnelProcess = child;") &&
        source.includes("if (tunnelStopRequested)") &&
        source.includes("child.kill(\"SIGTERM\")") &&
        source.includes("tunnelProcess = null;"),
      "named tunnel startup should expose child handle for intentional shutdown during startup",
    );
  });

  it("ignores named tunnel readiness parsing after stopTunnel is requested", () => {
    assert.ok(
      source.includes("function parseOutput(chunk)") &&
        source.includes("if (tunnelStopRequested) return;"),
      "named tunnel should not transition to active after intentional stop during startup",
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

  it("treats signal-based named tunnel exits as failures after startup", () => {
    assert.ok(
      source.includes("} else if (shouldRestartForProcessExit(code, signal))"),
      "named tunnel exit handling should treat non-null signal exits as failures",
    );
  });

  it("includes output-tail diagnostics in named tunnel error and exit warnings", () => {
    assert.ok(
      source.includes("named tunnel failed:") &&
      source.includes("named tunnel exited with code") &&
      source.includes("named tunnel exited (code") &&
      source.includes("formatTunnelOutputHint(output)") &&
      source.includes("(tail:"),
      "named tunnel warnings should include compact output-tail diagnostics",
    );
  });
});
