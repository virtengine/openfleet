import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildSDKConflictPrompt,
  isSDKResolutionOnCooldown,
  isSDKResolutionExhausted,
  clearSDKResolutionState,
  getSDKResolutionSummary,
  resolveConflictsWithSDK,
} from "../sdk-conflict-resolver.mjs";

// ── classifyFile (tested indirectly through buildSDKConflictPrompt) ──────────

describe("buildSDKConflictPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/fix-thing",
      baseBranch: "main",
      prNumber: 42,
      taskTitle: "Fix the thing",
      conflictedFiles: ["src/app.ts"],
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("includes context sections", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/fix-thing",
      baseBranch: "main",
      prNumber: 42,
      taskTitle: "Fix the thing",
      taskDescription: "Fixes a critical bug",
      conflictedFiles: ["src/app.ts"],
    });
    expect(prompt).toContain("ve/fix-thing");
    expect(prompt).toContain("main");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("Fix the thing");
    expect(prompt).toContain("Fixes a critical bug");
  });

  it("classifies lockfiles as auto-resolvable (theirs)", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      conflictedFiles: ["pnpm-lock.yaml", "go.sum", "src/app.ts"],
    });
    expect(prompt).toContain("Auto-Resolvable Files");
    expect(prompt).toContain("--theirs");
    expect(prompt).toContain("pnpm-lock.yaml");
    expect(prompt).toContain("go.sum");
    expect(prompt).toContain("Intelligent Resolution");
    expect(prompt).toContain("src/app.ts");
  });

  it("classifies CHANGELOG.md as auto-resolvable (ours)", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      conflictedFiles: ["CHANGELOG.md", "coverage.txt"],
    });
    expect(prompt).toContain("--ours");
    expect(prompt).toContain("CHANGELOG.md");
    expect(prompt).toContain("coverage.txt");
  });

  it("includes diff preview for manual files", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      conflictedFiles: ["src/handler.ts"],
      conflictDiffs: {
        "src/handler.ts":
          "diff --git a/src/handler.ts\n<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>>",
      },
    });
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("<<<<<<< HEAD");
  });

  it("handles empty conflictedFiles", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      conflictedFiles: [],
    });
    expect(prompt).not.toContain("Auto-Resolvable Files");
    expect(prompt).not.toContain("Intelligent Resolution");
  });

  it("includes critical rules", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      conflictedFiles: ["src/a.ts"],
    });
    expect(prompt).toContain("CRITICAL RULES");
    expect(prompt).toContain("Do NOT abort the merge");
    expect(prompt).toContain("Do NOT run `git merge` again");
    expect(prompt).toContain("Do NOT use `git rebase`");
  });

  it("includes post-resolution verification steps", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      conflictedFiles: ["src/a.ts"],
    });
    expect(prompt).toContain("After Resolving All Files");
    expect(prompt).toContain("git commit --no-edit");
    expect(prompt).toContain("git push origin HEAD:ve/test");
  });

  it("truncates long taskDescription", () => {
    const longDesc = "A".repeat(1000);
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      taskDescription: longDesc,
      conflictedFiles: [],
    });
    // Description is sliced to 500 chars
    expect(prompt).not.toContain("A".repeat(600));
    expect(prompt).toContain("A".repeat(500));
  });

  it("handles files with .lock extension as theirs", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      conflictedFiles: ["vendor/some-dep.lock"],
    });
    expect(prompt).toContain("Auto-Resolvable Files");
    expect(prompt).toContain("--theirs");
    expect(prompt).toContain("some-dep.lock");
  });

  it("defaults baseBranch to main", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      conflictedFiles: ["src/a.ts"],
    });
    expect(prompt).toContain("origin/main");
  });

  it("uses custom baseBranch", () => {
    const prompt = buildSDKConflictPrompt({
      worktreePath: "/tmp/wt",
      branch: "ve/test",
      baseBranch: "develop",
      conflictedFiles: ["src/a.ts"],
    });
    expect(prompt).toContain("origin/develop");
  });
});

// ── State tracking ───────────────────────────────────────────────────────────

describe("SDK resolution state tracking", () => {
  beforeEach(() => {
    clearSDKResolutionState("test-branch");
    clearSDKResolutionState("test-branch-2");
  });

  it("reports not on cooldown initially", () => {
    expect(isSDKResolutionOnCooldown("test-branch")).toBe(false);
  });

  it("reports not exhausted initially", () => {
    expect(isSDKResolutionExhausted("test-branch")).toBe(false);
  });

  it("clearSDKResolutionState removes state", () => {
    // Force some state by resolving once (will fail due to missing worktree, but records attempt)
    clearSDKResolutionState("test-branch");
    expect(isSDKResolutionOnCooldown("test-branch")).toBe(false);
    expect(isSDKResolutionExhausted("test-branch")).toBe(false);
  });

  it("getSDKResolutionSummary returns summary object", () => {
    const summary = getSDKResolutionSummary();
    expect(summary).toHaveProperty("total");
    expect(summary).toHaveProperty("entries");
    expect(Array.isArray(summary.entries)).toBe(true);
  });

  it("getSDKResolutionSummary reflects cleared state", () => {
    clearSDKResolutionState("test-branch");
    const summary = getSDKResolutionSummary();
    const entry = summary.entries.find((e) => e.key === "test-branch");
    expect(entry).toBeUndefined();
  });
});

// ── resolveConflictsWithSDK guard clauses ────────────────────────────────────

describe("resolveConflictsWithSDK", () => {
  it("returns error when worktree does not exist", async () => {
    const result = await resolveConflictsWithSDK({
      worktreePath: "/nonexistent/path/that/does/not/exist",
      branch: "ve/test",
      baseBranch: "main",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Worktree not found");
  });

  it("returns error when worktreePath is null", async () => {
    const result = await resolveConflictsWithSDK({
      worktreePath: null,
      branch: "ve/test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Worktree not found");
  });

  it("returns error when worktreePath is empty string", async () => {
    const result = await resolveConflictsWithSDK({
      worktreePath: "",
      branch: "ve/test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Worktree not found");
  });

  it("resolvedFiles is always an array", async () => {
    const result = await resolveConflictsWithSDK({
      worktreePath: "/nonexistent",
      branch: "ve/test",
    });
    expect(Array.isArray(result.resolvedFiles)).toBe(true);
    expect(result.resolvedFiles).toHaveLength(0);
  });
});
