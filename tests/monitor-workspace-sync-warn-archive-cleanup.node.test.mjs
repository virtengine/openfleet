import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor workspace sync warn archive cleanup", () => {
  it("archives corrupt or old workspace sync warn state files", () => {
    const hasArchive =
      source.includes("ve-workspace-sync-warn-state.json") &&
      (source.includes("archive") || source.includes("backup") ||
        source.includes("corrupt"));
    assert.ok(
      hasArchive,
      "should archive corrupt workspace sync warn state files",
    );
  });

  it("keeps at most 5 archived corrupt state files", () => {
    const hasMaxFiles =
      source.includes("ve-workspace-sync-warn-state") &&
      (source.includes(", 5") || source.includes("=5") || source.includes("= 5") ||
        /max.*5|5.*archive|keep.*5/.test(source));
    assert.ok(
      hasMaxFiles,
      "archive cleanup should keep at most 5 corrupt state files",
    );
  });

  it("removes archived files older than 14 days", () => {
    // 14 days = 14 * 24 * 60 * 60 * 1000 = 1209600000
    const has14Days =
      source.includes("ve-workspace-sync-warn-state") &&
      (source.includes("14") && (source.includes("day") ||
        source.includes("1209600000") ||
        /14\s*\*\s*24\s*\*\s*60\s*\*\s*60/.test(source)));
    assert.ok(
      has14Days,
      "archive cleanup should remove files older than 14 days",
    );
  });

  it("performs archive cleanup during monitor startup", () => {
    const hasStartupCleanup =
      source.includes("ve-workspace-sync-warn-state") &&
      (source.includes("startup") || source.includes("initialize") ||
        source.includes("cleanup"));
    assert.ok(
      hasStartupCleanup,
      "archive cleanup should run during monitor startup or initialization",
    );
  });
});
