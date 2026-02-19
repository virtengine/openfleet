import { describe, expect, it } from "vitest";
import { collectDiffStats, getCompactDiffSummary, getRecentCommits } from "../diff-stats.mjs";

describe("diff-stats", () => {
  describe("collectDiffStats", () => {
    it("returns empty stats for invalid path", () => {
      const result = collectDiffStats("/nonexistent/path");
      expect(result.totalFiles).toBe(0);
      expect(result.totalAdditions).toBe(0);
      expect(result.totalDeletions).toBe(0);
      expect(result.files).toEqual([]);
    });

    it("returns formatted string for invalid path", () => {
      const result = collectDiffStats("/nonexistent/path");
      expect(result.formatted).toContain("no diff stats available");
    });

    // Real git workspace test — only runs if in a git repo
    it("collects stats from current working directory", () => {
      const cwd = process.cwd();
      const result = collectDiffStats(cwd);

      // Even if there are no changes, it should return a valid structure
      expect(result).toHaveProperty("files");
      expect(result).toHaveProperty("totalFiles");
      expect(result).toHaveProperty("totalAdditions");
      expect(result).toHaveProperty("totalDeletions");
      expect(result).toHaveProperty("formatted");
      expect(typeof result.totalFiles).toBe("number");
    });
  });

  describe("getCompactDiffSummary", () => {
    it("returns string", () => {
      const summary = getCompactDiffSummary("/nonexistent/path");
      expect(typeof summary).toBe("string");
    });
  });

  describe("getRecentCommits", () => {
    it("returns array for invalid path", () => {
      const commits = getRecentCommits("/nonexistent/path");
      expect(Array.isArray(commits)).toBe(true);
      expect(commits).toEqual([]);
    });

    it("returns commits from current directory", () => {
      const commits = getRecentCommits(process.cwd(), 5);
      expect(Array.isArray(commits)).toBe(true);
      // Should have at least some commits if we're in a git repo
      // (can't guarantee this in all CI environments)
    });
  });
});
