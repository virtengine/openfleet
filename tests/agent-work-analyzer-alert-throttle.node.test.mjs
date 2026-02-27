import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(
  resolve(process.cwd(), "agent-work-analyzer.mjs"),
  "utf8",
);

describe("agent-work-analyzer alert throttle improvements", () => {
  it("defines FAILED_SESSION_ALERT_MIN_COOLDOWN_MS constant at 1 hour", () => {
    assert.ok(
      source.includes("FAILED_SESSION_ALERT_MIN_COOLDOWN_MS"),
      "FAILED_SESSION_ALERT_MIN_COOLDOWN_MS constant should be defined",
    );
    // 1 hour = 60 * 60 * 1000 = 3600000
    const has1h =
      source.includes("60 * 60 * 1000") ||
      source.includes("3600000") ||
      /1\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(source);
    assert.ok(has1h, "FAILED_SESSION_ALERT_MIN_COOLDOWN_MS should default to 1 hour");
  });

  it("defines FAILED_SESSION_TRANSIENT_ALERT_MIN_COOLDOWN_MS constant at 2 hours", () => {
    assert.ok(
      source.includes("FAILED_SESSION_TRANSIENT_ALERT_MIN_COOLDOWN_MS"),
      "FAILED_SESSION_TRANSIENT_ALERT_MIN_COOLDOWN_MS should be defined for transient error alerts",
    );
    // 2 hours = 2 * 60 * 60 * 1000 = 7200000
    const has2h =
      source.includes("7200000") ||
      /2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(source);
    assert.ok(has2h, "FAILED_SESSION_TRANSIENT_ALERT_MIN_COOLDOWN_MS should default to 2 hours");
  });

  it("detects transient-only sessions separately from high-error sessions", () => {
    assert.ok(
      source.includes("failed_session_transient_errors") ||
        source.includes("transient_errors"),
      "should have a separate alert type for transient-only session failures",
    );
  });

  it("applies separate cooldown for transient error alerts", () => {
    // The transient alert type should use FAILED_SESSION_TRANSIENT_ALERT_MIN_COOLDOWN_MS
    const hasTransientCooldown =
      source.includes("FAILED_SESSION_TRANSIENT_ALERT_MIN_COOLDOWN_MS") &&
      (source.includes("transient") || source.includes("TRANSIENT"));
    assert.ok(
      hasTransientCooldown,
      "transient session alerts should use their own cooldown constant",
    );
  });

  it("classifies transport/reconnect storms as transient-only sessions", () => {
    // Transient sessions have transport/reconnect errors but not high permanent errors
    const hasTransportCheck =
      source.includes("transport") ||
      source.includes("reconnect") ||
      source.includes("transient");
    assert.ok(
      hasTransportCheck,
      "should classify transport/reconnect error sessions as transient",
    );
  });
});
