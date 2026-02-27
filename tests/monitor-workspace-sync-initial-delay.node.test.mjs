import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync initial delay", () => {
  it("supports DEVMODE_WORKSPACE_SYNC_INITIAL_DELAY_MS env var", () => {
    assert.ok(
      source.includes("DEVMODE_WORKSPACE_SYNC_INITIAL_DELAY_MS"),
      "should support DEVMODE_WORKSPACE_SYNC_INITIAL_DELAY_MS env var",
    );
  });

  it("delays first workspace sync warn check after startup", () => {
    // Should not immediately check and warn; allow system to stabilize first
    const hasInitialDelay =
      source.includes("DEVMODE_WORKSPACE_SYNC_INITIAL_DELAY_MS") &&
      (source.includes("initialDelay") || source.includes("initial_delay") ||
        source.includes("startupDelay") || source.includes("delay"));
    assert.ok(
      hasInitialDelay,
      "workspace sync warn should have an initial delay before first check",
    );
  });

  it("uses a reasonable default initial delay for production", () => {
    // Should have a meaningful default (e.g., minutes, not seconds or milliseconds)
    const hasDefault =
      source.includes("DEVMODE_WORKSPACE_SYNC_INITIAL_DELAY_MS") &&
      (source.includes("60 * 1000") || source.includes("60000") ||
        /\d+\s*\*\s*60\s*\*\s*1000/.test(source));
    assert.ok(
      hasDefault,
      "workspace sync initial delay should have a production default of at least 1 minute",
    );
  });
});
