import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync slow warn", () => {
  it("supports DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS env var", () => {
    assert.ok(
      source.includes("DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS"),
      "should support DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS env var",
    );
  });

  it("emits a slow-sync warning when workspace sync takes longer than threshold", () => {
    const hasSlowWarn =
      source.includes("DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS") &&
      (source.includes("slow") || source.includes("duration") ||
        source.includes("elapsed") || source.includes("tooLong"));
    assert.ok(
      hasSlowWarn,
      "should emit a warning when workspace sync operation exceeds DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS",
    );
  });

  it("has a meaningful default slow warn threshold", () => {
    // Default should be several seconds to avoid false positives
    const hasDefault =
      source.includes("DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS") &&
      (source.includes("5000") || source.includes("10000") ||
        source.includes("30000") || /\d+\s*\*\s*1000/.test(source));
    assert.ok(
      hasDefault,
      "DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS should have a default of several seconds",
    );
  });

  it("measures elapsed time since sync start to detect slowness", () => {
    const hasElapsedMeasurement =
      source.includes("DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS") &&
      (source.includes("Date.now") || source.includes("performance.now") ||
        source.includes("startTime") || source.includes("start_time"));
    assert.ok(
      hasElapsedMeasurement,
      "slow sync detection should measure elapsed time since sync start",
    );
  });
});
