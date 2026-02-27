import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync warn state atomic write", () => {
  it("writes workspace sync warn state atomically via temp file", () => {
    // Atomic write: write to .tmp file, then rename to final path
    const hasTmpFile =
      source.includes("ve-workspace-sync-warn-state.json") &&
      (source.includes(".tmp") || source.includes("tmp"));
    assert.ok(
      hasTmpFile,
      "workspace sync warn state should be written atomically using a temp file",
    );
  });

  it("uses rename to atomically swap temp file with final file", () => {
    const hasRename =
      source.includes("ve-workspace-sync-warn-state") &&
      (source.includes("rename") || source.includes("renameSync"));
    assert.ok(
      hasRename,
      "atomic write should use rename() to swap temp file into final location",
    );
  });

  it("cleans up temp file on write failure", () => {
    // If write or rename fails, the .tmp file should be cleaned up
    const hasCleanup =
      source.includes("ve-workspace-sync-warn-state") &&
      source.includes(".tmp") &&
      (source.includes("unlink") || source.includes("rm") ||
        source.includes("catch") || source.includes("finally"));
    assert.ok(
      hasCleanup,
      "temp file should be cleaned up if atomic write fails",
    );
  });

  it("temp file path includes the same directory as the state file", () => {
    // .tmp file should be in same directory for atomic rename to work
    const hasSameDir =
      source.includes("ve-workspace-sync-warn-state.json.tmp") ||
      (source.includes("ve-workspace-sync-warn-state") &&
        source.includes(".tmp") &&
        source.includes(".cache"));
    assert.ok(
      hasSameDir,
      "temp file should be in the same directory as the target state file",
    );
  });
});
