import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("monitor epic PR guard rails", () => {
  const monitorPath = resolve(process.cwd(), "monitor.mjs");
  const source = readFileSync(monitorPath, "utf8");

  it("adds a git readiness preflight before epic PR creation", () => {
    expect(source).toContain("function getEpicMergeReadiness(");
    expect(source).toContain('reason: "no-commits"');
    expect(source).toContain('"rev-list", "--count"');
  });

  it("skips PR creation when there are no mergeable commits", () => {
    const match = source.match(
      /async function createEpicMergePr\([\s\S]*?\n\}\n\nasync function enableEpicAutoMerge/,
    );
    expect(match, "createEpicMergePr block should be present").toBeTruthy();
    const block = match ? match[0] : "";
    expect(block).toContain("const readiness = getEpicMergeReadiness(");
    expect(block).toContain('readiness.reason === "no-commits"');
    expect(block).toContain("skipped: true");
  });
});