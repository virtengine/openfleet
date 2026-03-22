import { describe, expect, it } from "vitest";
import {
  collectDiffStats,
  getCompactDiffSummary,
  getRecentCommits,
  parseUnifiedDiff,
} from "../git/diff-stats.mjs";

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

    it("accepts explicit range overrides", () => {
      const result = collectDiffStats("/nonexistent/path", {
        range: "abc123^..abc123",
        includePatch: true,
      });
      expect(result.totalFiles).toBe(0);
      expect(result.files).toEqual([]);
    });
  });

  describe("parseUnifiedDiff", () => {
    it("parses hunks with line numbers and statuses", () => {
      const files = parseUnifiedDiff([
        "diff --git a/src/example.js b/src/example.js",
        "index 1111111..2222222 100644",
        "--- a/src/example.js",
        "+++ b/src/example.js",
        "@@ -1,3 +1,4 @@",
        " const value = 1;",
        "-console.log(value);",
        "+console.log(value + 1);",
        "+console.log('done');",
        " export default value;",
      ].join("\n"));

      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe("src/example.js");
      expect(files[0].status).toBe("modified");
      expect(files[0].additions).toBe(2);
      expect(files[0].deletions).toBe(1);
      expect(files[0].hunks).toHaveLength(1);
      expect(files[0].hunks[0].lines[0]).toMatchObject({
        type: "context",
        oldNumber: 1,
        newNumber: 1,
      });
      expect(files[0].hunks[0].lines[1]).toMatchObject({
        type: "deletion",
        oldNumber: 2,
        newNumber: null,
      });
      expect(files[0].hunks[0].lines[2]).toMatchObject({
        type: "addition",
        oldNumber: null,
        newNumber: 2,
      });
    });

    it("detects renamed files", () => {
      const files = parseUnifiedDiff([
        "diff --git a/src/old-name.js b/src/new-name.js",
        "similarity index 91%",
        "rename from src/old-name.js",
        "rename to src/new-name.js",
        "--- a/src/old-name.js",
        "+++ b/src/new-name.js",
        "@@ -1 +1 @@",
        "-export const name = 'old';",
        "+export const name = 'new';",
      ].join("\n"));

      expect(files).toHaveLength(1);
      expect(files[0].status).toBe("renamed");
      expect(files[0].oldFilename).toBe("src/old-name.js");
      expect(files[0].newFilename).toBe("src/new-name.js");
      expect(files[0].filename).toBe("src/new-name.js");
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
  });
});
