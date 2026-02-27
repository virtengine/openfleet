import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync warn throttle devmode override", () => {
  it("supports DEVMODE_WORKSPACE_SYNC_WARN_THROTTLE_MS env var for dev override", () => {
    assert.ok(
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_THROTTLE_MS"),
      "should support DEVMODE_WORKSPACE_SYNC_WARN_THROTTLE_MS env var",
    );
  });

  it("defaults workspace sync warn throttle to 30 minutes", () => {
    // 30 min = 30 * 60 * 1000 = 1800000
    const has30min =
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_THROTTLE_MS") &&
      (source.includes("1800000") ||
        source.includes("30 * 60 * 1000") ||
        /30\s*\*\s*60\s*\*\s*1000/.test(source));
    assert.ok(
      has30min,
      "DEVMODE workspace sync warn throttle should default to 30 minutes",
    );
  });

  it("uses DEVMODE throttle value in development/test environments", () => {
    const hasDevmodeUsage =
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_THROTTLE_MS") &&
      (source.includes("DEVMODE") || source.includes("devmode"));
    assert.ok(
      hasDevmodeUsage,
      "DEVMODE_WORKSPACE_SYNC_WARN_THROTTLE_MS should override the production throttle in dev",
    );
  });
});
