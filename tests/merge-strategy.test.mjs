import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  analyzeMergeStrategy,
  buildMergeStrategyPrompt,
  extractActionJson,
  resetMergeStrategyDedup,
} from "../merge-strategy.mjs";

describe("merge-strategy", () => {
  beforeEach(() => {
    resetMergeStrategyDedup();
  });

  describe("extractActionJson", () => {
    it("parses direct JSON", () => {
      const raw = '{"action":"merge_after_ci_pass","reason":"ok"}';
      expect(extractActionJson(raw)).toEqual({
        action: "merge_after_ci_pass",
        reason: "ok",
      });
    });

    it("parses JSON inside markdown fences", () => {
      const raw = "```json\n{\"action\":\"prompt\",\"message\":\"Fix it\"}\n```";
      expect(extractActionJson(raw)).toEqual({
        action: "prompt",
        message: "Fix it",
      });
    });

    it("parses JSON embedded in text", () => {
      const raw =
        "Some preface {\"action\":\"wait\",\"seconds\":120} trailing";
      expect(extractActionJson(raw)).toEqual({
        action: "wait",
        seconds: 120,
      });
    });

    it("returns null on invalid input", () => {
      expect(extractActionJson(null)).toBeNull();
      expect(extractActionJson("no json here")).toBeNull();
    });
  });

  describe("buildMergeStrategyPrompt", () => {
    it("includes key context sections and truncates file list", () => {
      const changedFiles = Array.from({ length: 51 }, (_, i) => `file-${i}.txt`);
      const prompt = buildMergeStrategyPrompt({
        attemptId: "abc",
        shortId: "abc",
        status: "completed",
        agentLastMessage: "All tests passed",
        prNumber: 12,
        prTitle: "feat: example",
        prState: "open",
        prUrl: "https://example.com",
        ciStatus: "pending",
        branch: "ve/example",
        filesChanged: 51,
        commitsAhead: 2,
        commitsBehind: 1,
        diffStat: "1 file changed",
        changedFiles,
        taskTitle: "Test task",
        taskDescription: "Do the thing",
        worktreeDir: "C:/repo/worktree",
      });

      expect(prompt).toContain("# Merge Strategy Decision");
      expect(prompt).toContain("**Task:** Test task");
      expect(prompt).toContain("**Status:** completed");
      expect(prompt).toContain("**Branch:** ve/example");
      expect(prompt).toContain("Agent's Last Message");
      expect(prompt).toContain("PR #12");
      expect(prompt).toContain("CI: pending");
      expect(prompt).toContain("Files changed: 51");
      expect(prompt).toContain("Commits ahead: 2");
      expect(prompt).toContain("Commits behind: 1");
      expect(prompt).toContain("file-0.txt");
      expect(prompt).toContain("... and 1 more");
      expect(prompt).toContain("Directory: C:/repo/worktree");
    });
  });

  describe("analyzeMergeStrategy", () => {
    it("returns parsed decision from Codex output", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse: '{"action":"merge_after_ci_pass","reason":"ok"}',
      });

      const result = await analyzeMergeStrategy(
        { attemptId: "a", shortId: "a", status: "completed" },
        { execCodex, logDir: null }
      );

      expect(result.action).toBe("merge_after_ci_pass");
      expect(result.reason).toBe("ok");
      expect(result.success).toBe(true);
      expect(execCodex).toHaveBeenCalledTimes(1);
    });

    it("falls back to manual_review on invalid action", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse: '{"action":"banana","reason":"??"}',
      });

      const result = await analyzeMergeStrategy(
        { attemptId: "b", shortId: "b", status: "completed" },
        { execCodex, logDir: null }
      );

      expect(result.action).toBe("manual_review");
      expect(result.reason).toContain("Invalid action");
    });

    it("dedups repeated analysis within cooldown", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse: '{"action":"wait","seconds":60}',
      });

      const ctx = { attemptId: "c", shortId: "c", status: "completed" };
      const first = await analyzeMergeStrategy(ctx, { execCodex, logDir: null });
      const second = await analyzeMergeStrategy(ctx, { execCodex, logDir: null });

      expect(first.action).toBe("wait");
      expect(second.action).toBe("noop");
      expect(second.reason).toContain("Already analyzed recently");
      expect(execCodex).toHaveBeenCalledTimes(1);
    });

    it("returns manual_review on Codex failure", async () => {
      const execCodex = vi.fn().mockRejectedValue(new Error("timeout"));

      const result = await analyzeMergeStrategy(
        { attemptId: "d", shortId: "d", status: "completed" },
        { execCodex, logDir: null }
      );

      expect(result.action).toBe("manual_review");
      expect(result.reason).toContain("Codex error");
      expect(result.success).toBe(false);
    });
  });
});
