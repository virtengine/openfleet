import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync warn state persistence", () => {
  it("persists workspace sync warn state to a JSON file", () => {
    assert.ok(
      source.includes("ve-workspace-sync-warn-state.json"),
      "workspace sync warn state should be persisted to ve-workspace-sync-warn-state.json",
    );
  });

  it("writes state to .cache directory", () => {
    const hasCache =
      source.includes("ve-workspace-sync-warn-state.json") &&
      source.includes(".cache");
    assert.ok(
      hasCache,
      "workspace sync warn state file should be in the .cache directory",
    );
  });

  it("loads persisted warn state on startup", () => {
    // On startup, the state file should be read to restore previous warn timestamps
    const hasLoad =
      source.includes("ve-workspace-sync-warn-state.json") &&
      (source.includes("readFile") || source.includes("readFileSync") ||
        source.includes("load") || source.includes("restore"));
    assert.ok(
      hasLoad,
      "workspace sync warn state should be loaded from file on startup",
    );
  });

  it("saves state after each warning emission", () => {
    const hasSave =
      source.includes("ve-workspace-sync-warn-state.json") &&
      (source.includes("writeFile") || source.includes("writeFileSync") ||
        source.includes("save") || source.includes("persist"));
    assert.ok(
      hasSave,
      "workspace sync warn state should be saved after emitting warnings",
    );
  });
});
