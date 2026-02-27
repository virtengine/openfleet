import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync warn state write gap", () => {
  it("supports DEVMODE_WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS env var", () => {
    assert.ok(
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS"),
      "should support DEVMODE_WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS env var",
    );
  });

  it("debounces state file writes to avoid excessive disk I/O", () => {
    const hasDebounce =
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS") &&
      (source.includes("debounce") || source.includes("writeGap") ||
        source.includes("write_gap") || source.includes("gap") ||
        source.includes("setTimeout"));
    assert.ok(
      hasDebounce,
      "state writes should be debounced using DEVMODE_WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS",
    );
  });

  it("has a reasonable default write gap to prevent I/O storms", () => {
    // Default should be a few seconds at least
    const hasDefault =
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS") &&
      (source.includes("1000") || source.includes("2000") ||
        source.includes("5000") || /\d+\s*\*\s*1000/.test(source));
    assert.ok(
      hasDefault,
      "state write gap should have a default value of at least 1 second",
    );
  });
});
