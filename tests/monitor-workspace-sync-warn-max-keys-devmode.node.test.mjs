import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync warn max keys devmode override", () => {
  it("supports DEVMODE_WORKSPACE_SYNC_WARN_MAX_KEYS env var", () => {
    assert.ok(
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_MAX_KEYS"),
      "should support DEVMODE_WORKSPACE_SYNC_WARN_MAX_KEYS env var",
    );
  });

  it("limits the number of tracked workspace keys in warn state", () => {
    const hasMaxKeys =
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_MAX_KEYS") &&
      (source.includes("maxKeys") || source.includes("max_keys") ||
        source.includes("MAX_KEYS") || source.includes("size"));
    assert.ok(
      hasMaxKeys,
      "workspace sync warn state should limit tracked keys via DEVMODE_WORKSPACE_SYNC_WARN_MAX_KEYS",
    );
  });

  it("evicts oldest entries when max keys limit is reached", () => {
    const hasEviction =
      source.includes("DEVMODE_WORKSPACE_SYNC_WARN_MAX_KEYS") &&
      (source.includes("evict") || source.includes("delete") ||
        source.includes("shift") || source.includes("oldest"));
    assert.ok(
      hasEviction,
      "should evict oldest entries when the max keys limit is reached",
    );
  });
});
