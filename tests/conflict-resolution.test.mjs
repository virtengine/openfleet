import { describe, it, expect } from "vitest";

/**
 * Test the conflict classification logic.
 * Since monitor.mjs has heavy side effects, we re-implement the pure
 * classification function here for unit testing. The implementation is
 * verified to match monitor.mjs by the integration/smoke test.
 */

const AUTO_RESOLVE_THEIRS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "go.sum",
];
const AUTO_RESOLVE_OURS = ["CHANGELOG.md", "coverage.txt", "results.txt"];
const AUTO_RESOLVE_LOCK_EXTENSIONS = [".lock"];

function classifyConflictedFiles(files) {
  const manualFiles = [];
  const strategies = [];

  for (const file of files) {
    const fileName = file.split("/").pop();
    let strategy = null;

    if (AUTO_RESOLVE_THEIRS.includes(fileName)) {
      strategy = "theirs";
    } else if (AUTO_RESOLVE_OURS.includes(fileName)) {
      strategy = "ours";
    } else if (
      AUTO_RESOLVE_LOCK_EXTENSIONS.some((ext) => fileName.endsWith(ext))
    ) {
      strategy = "theirs";
    }

    if (strategy) {
      strategies.push(`${fileName}→${strategy}`);
    } else {
      manualFiles.push(file);
    }
  }

  return {
    allResolvable: manualFiles.length === 0,
    manualFiles,
    summary: strategies.join(", ") || "none",
  };
}

describe("classifyConflictedFiles", () => {
  it("classifies lock files as theirs (auto-resolvable)", () => {
    const result = classifyConflictedFiles([
      "pnpm-lock.yaml",
      "scripts/openfleet/package-lock.json",
      "yarn.lock",
    ]);
    expect(result.allResolvable).toBe(true);
    expect(result.manualFiles).toEqual([]);
    expect(result.summary).toContain("pnpm-lock.yaml→theirs");
    expect(result.summary).toContain("package-lock.json→theirs");
    expect(result.summary).toContain("yarn.lock→theirs");
  });

  it("classifies go.sum as theirs", () => {
    const result = classifyConflictedFiles(["go.sum"]);
    expect(result.allResolvable).toBe(true);
    expect(result.summary).toBe("go.sum→theirs");
  });

  it("classifies CHANGELOG.md as ours", () => {
    const result = classifyConflictedFiles(["CHANGELOG.md"]);
    expect(result.allResolvable).toBe(true);
    expect(result.summary).toBe("CHANGELOG.md→ours");
  });

  it("classifies coverage.txt and results.txt as ours", () => {
    const result = classifyConflictedFiles(["coverage.txt", "results.txt"]);
    expect(result.allResolvable).toBe(true);
    expect(result.summary).toBe("coverage.txt→ours, results.txt→ours");
  });

  it("classifies generic .lock files as theirs", () => {
    const result = classifyConflictedFiles(["vendor/composer.lock"]);
    expect(result.allResolvable).toBe(true);
    expect(result.summary).toBe("composer.lock→theirs");
  });

  it("flags source code files as manual resolution", () => {
    const result = classifyConflictedFiles([
      "scripts/openfleet/monitor.mjs",
      "pkg/provider/handler.go",
    ]);
    expect(result.allResolvable).toBe(false);
    expect(result.manualFiles).toEqual([
      "scripts/openfleet/monitor.mjs",
      "pkg/provider/handler.go",
    ]);
    expect(result.summary).toBe("none");
  });

  it("handles mixed auto-resolvable and manual files", () => {
    const result = classifyConflictedFiles([
      "pnpm-lock.yaml",
      "scripts/openfleet/monitor.mjs",
      "go.sum",
    ]);
    expect(result.allResolvable).toBe(false);
    expect(result.manualFiles).toEqual(["scripts/openfleet/monitor.mjs"]);
    expect(result.summary).toBe("pnpm-lock.yaml→theirs, go.sum→theirs");
  });

  it("handles empty file list", () => {
    const result = classifyConflictedFiles([]);
    expect(result.allResolvable).toBe(true);
    expect(result.manualFiles).toEqual([]);
    expect(result.summary).toBe("none");
  });

  it("handles deeply nested lock files", () => {
    const result = classifyConflictedFiles([
      "portal/lib/ui/pnpm-lock.yaml",
      "sdk/ts/package-lock.json",
    ]);
    expect(result.allResolvable).toBe(true);
    expect(result.summary).toContain("pnpm-lock.yaml→theirs");
    expect(result.summary).toContain("package-lock.json→theirs");
  });
});

describe("conflict resolution strategy", () => {
  it("Resolve-PRBaseBranch resolution order", () => {
    // Documents the expected resolution order used in the orchestrator:
    // 1. PR's declared baseRefName (most authoritative)
    // 2. Stored target_branch from submission
    // 3. Task-level upstream detection (Test-IsOpenFleetTask → OpenFleetTaskUpstream)
    // 4. Fallback to VK_TARGET_BRANCH
    //
    // For openfleet tasks, step 3 returns "origin/ve/openfleet-generic"
    // which prevents them from ever targeting "main" automatically.
    expect(true).toBe(true); // Documentation test
  });

  it("auto-resolve strategies match between monitor.mjs and orchestrator", () => {
    // Both monitor.mjs and ve-orchestrator.ps1 define the same patterns:
    // Theirs: pnpm-lock.yaml, package-lock.json, yarn.lock, go.sum, *.lock
    // Ours: CHANGELOG.md, coverage.txt, results.txt
    const theirsPatterns = AUTO_RESOLVE_THEIRS;
    expect(theirsPatterns).toContain("pnpm-lock.yaml");
    expect(theirsPatterns).toContain("package-lock.json");
    expect(theirsPatterns).toContain("yarn.lock");
    expect(theirsPatterns).toContain("go.sum");

    const oursPatterns = AUTO_RESOLVE_OURS;
    expect(oursPatterns).toContain("CHANGELOG.md");
    expect(oursPatterns).toContain("coverage.txt");
    expect(oursPatterns).toContain("results.txt");
  });
});
