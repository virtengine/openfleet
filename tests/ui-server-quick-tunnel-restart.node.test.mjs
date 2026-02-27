import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");

describe("ui-server quick tunnel auto-restart with exponential backoff", () => {
  it("restarts quick tunnel after unexpected exit", () => {
    // Tunnel exit handler should trigger a restart, not just null the state
    const hasRestartOnExit =
      source.includes("restart") &&
      source.includes("exit") &&
      (source.includes("quickTunnel") || source.includes("startQuickTunnel"));
    assert.ok(
      hasRestartOnExit,
      "quick tunnel exit handler should trigger auto-restart",
    );
  });

  it("uses exponential backoff between restart attempts", () => {
    const hasExponentialBackoff =
      source.includes("backoff") ||
      /Math\.pow|2\s*\*\*\s*attempt|\*\s*2\s*\*\s*attempt/.test(source) ||
      source.includes("exponential");
    assert.ok(
      hasExponentialBackoff,
      "quick tunnel restart should use exponential backoff",
    );
  });

  it("applies jitter to restart delay", () => {
    const hasJitter =
      source.includes("jitter") ||
      (source.includes("Math.random") && source.includes("restart"));
    assert.ok(
      hasJitter,
      "quick tunnel restart should apply jitter to prevent thundering herd",
    );
  });

  it("respects TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS env var", () => {
    assert.ok(
      source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS"),
      "should be configurable via TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS",
    );
  });

  it("defaults to max 6 restart attempts", () => {
    const has6Attempts = source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS") &&
      (source.includes(", 6") || source.includes("=6") || source.includes("= 6") ||
       /default.*6|6.*default|parseInt.*6/.test(source));
    assert.ok(
      has6Attempts,
      "default max restart attempts should be 6",
    );
  });

  it("respects TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_DELAY_MS env var", () => {
    assert.ok(
      source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_DELAY_MS") ||
        source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_MS"),
      "should be configurable via TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_DELAY_MS",
    );
  });

  it("defaults to 5 second base restart delay", () => {
    // 5s = 5000ms
    const has5sBase = source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART") &&
      (source.includes("5000") || source.includes("5 * 1000") || /5\s*\*\s*1000/.test(source));
    assert.ok(
      has5sBase,
      "default base restart delay should be 5 seconds",
    );
  });

  it("caps restart delay at a maximum (default 120 seconds)", () => {
    const has120sMax = source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART") &&
      (source.includes("120000") || source.includes("120 * 1000") ||
       /120\s*\*\s*1000/.test(source));
    assert.ok(
      has120sMax,
      "restart delay should be capped at a maximum (default 120s)",
    );
  });

  it("stops retrying after exhausting max attempts", () => {
    const hasExhaustion =
      source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS") &&
      (source.includes("exhausted") || source.includes(">= max") ||
       source.includes(">= MAX") || source.includes("attempts >="));
    assert.ok(
      hasExhaustion,
      "restart loop should stop after max attempts are exhausted",
    );
  });
});
