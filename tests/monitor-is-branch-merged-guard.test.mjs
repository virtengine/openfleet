import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const monitorPath = resolve(__dirname, "../monitor.mjs");
const source = readFileSync(monitorPath, "utf8");

function extractIsBranchMergedBlock() {
  const start = source.indexOf("async function isBranchMerged");
  const end = source.indexOf("const mergedTaskCache", start);
  if (start < 0 || end < 0 || end <= start) return "";
  return source.slice(start, end);
}

describe("monitor branch-merged guard", () => {
  it("checks open PRs before considering merged PR state", () => {
    const block = extractIsBranchMergedBlock();
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("--state open");
    expect(block).toContain("--state merged");
    expect(block.indexOf("--state open")).toBeLessThan(
      block.indexOf("--state merged"),
    );
  });

  it("scopes merged PR lookup to base branch when available", () => {
    const block = extractIsBranchMergedBlock();
    expect(block).toContain('--base "${baseInfo.name}"');
  });

  it("revalidates merged-branch cache before short-circuiting task finalization", () => {
    expect(source).toContain("isMergedBranchCacheEntryStillValid");
    expect(source).toContain(
      "Branch ${branch} removed from merged cache after revalidation",
    );
  });

  it("prunes stale merged-task cache entries for active tasks", () => {
    expect(source).toContain(
      "Pruned ${prunedMergedTaskCacheCount} stale merged-task cache entr",
    );
  });
});
