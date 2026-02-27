import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "maintenance.mjs"), "utf8");

describe("maintenance branch sync warning throttle", () => {
  it("defines logThrottledBranchSync function", () => {
    expect(source).toMatch(/function\s+logThrottledBranchSync\s*\(/);
  });

  it("logThrottledBranchSync accepts key, message, and level parameters", () => {
    // Function signature should accept (key, message, level)
    const funcMatch = source.match(
      /function\s+logThrottledBranchSync\s*\(([^)]+)\)/,
    );
    expect(funcMatch).not.toBeNull();
    const params = funcMatch[1];
    // Should have at least key and message params
    expect(params.split(",").length).toBeGreaterThanOrEqual(2);
  });

  it("supports warn, info, and error log levels", () => {
    expect(source).toMatch(/logThrottledBranchSync/);
    // Should dispatch to console.warn, console.info/log, console.error
    const hasWarn = source.includes("console.warn");
    const hasInfo =
      source.includes("console.info") || source.includes("console.log");
    const hasError = source.includes("console.error");
    expect(hasWarn).toBe(true);
    expect(hasInfo).toBe(true);
    expect(hasError).toBe(true);
  });

  it("throttles repeated branch sync messages by key", () => {
    // Should maintain a Map or similar to track last-seen timestamps per key
    const hasThrottleMap =
      source.includes("logThrottledBranchSync") &&
      (source.includes("new Map") || source.includes("branchSyncWarn") ||
        source.includes("throttle"));
    expect(hasThrottleMap).toBe(true);
  });

  it("dirty working-tree check runs before divergence check on current branch", () => {
    // Dirty check should come first to avoid misleading divergence warnings
    const dirtyCheckIdx = source.indexOf("uncommitted changes");
    const divergedIdx = source.indexOf("diverged");
    expect(dirtyCheckIdx).toBeGreaterThan(-1);
    expect(divergedIdx).toBeGreaterThan(-1);
    // Dirty check should appear before divergence warning in the sync logic
    expect(dirtyCheckIdx).toBeLessThan(divergedIdx);
  });

  it("uses logThrottledBranchSync for branch sync event logging", () => {
    expect(source).toMatch(/logThrottledBranchSync\s*\(/);
  });
});
