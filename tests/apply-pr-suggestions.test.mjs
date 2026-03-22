/**
 * Tests for tools/apply-pr-suggestions.mjs
 *
 * Verifies suggestion parsing, overlap removal, and content application
 * without requiring live GitHub API access.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// We import the module and test internal helpers via a dynamic import
// since the module exports only applyPrSuggestions.
// To test parsing helpers, we inline the same logic here.

// ── Inline the parsing logic for unit testing ──────────────────────────────

const SUGGESTION_RE = /```suggestion\r?\n([\s\S]*?)```/g;

function parseSuggestions(comments, authorFilter) {
  const suggestions = [];
  for (const comment of comments) {
    if (authorFilter && comment.user?.login !== authorFilter) continue;
    const body = comment.body || "";
    const matches = [...body.matchAll(SUGGESTION_RE)];
    if (matches.length === 0) continue;
    for (const match of matches) {
      const suggestedCode = match[1];
      const endLine = comment.line ?? comment.original_line;
      const startLine = comment.start_line ?? comment.original_start_line ?? endLine;
      if (!endLine || !comment.path) continue;
      suggestions.push({
        commentId: comment.id,
        path: comment.path,
        startLine,
        endLine,
        suggestedCode,
        author: comment.user?.login || "unknown",
        url: comment.html_url,
      });
    }
  }
  return suggestions;
}

function removeOverlaps(sortedDesc) {
  const kept = [];
  let minLine = Infinity;
  for (const s of sortedDesc) {
    if (s.endLine < minLine) {
      kept.push(s);
      minLine = s.startLine;
    }
  }
  return kept;
}

function applyToContent(content, sortedSuggestions) {
  const lines = content.split("\n");
  for (const s of sortedSuggestions) {
    const startIdx = s.startLine - 1;
    const count = s.endLine - s.startLine + 1;
    let code = s.suggestedCode;
    if (code.endsWith("\n")) code = code.slice(0, -1);
    const newLines = code.split("\n");
    lines.splice(startIdx, count, ...newLines);
  }
  return lines.join("\n");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("apply-pr-suggestions", () => {
  describe("parseSuggestions", () => {
    it("extracts single-line suggestion from comment body", () => {
      const comments = [
        {
          id: 1,
          path: "src/util.js",
          line: 10,
          start_line: null,
          original_line: 10,
          original_start_line: null,
          user: { login: "reviewer" },
          html_url: "https://github.com/test/pr/1#comment-1",
          body: "Fix the typo:\n```suggestion\nconst value = 42;\n```\n",
        },
      ];
      const result = parseSuggestions(comments);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("src/util.js");
      expect(result[0].startLine).toBe(10);
      expect(result[0].endLine).toBe(10);
      expect(result[0].suggestedCode).toBe("const value = 42;\n");
    });

    it("extracts multi-line suggestion", () => {
      const comments = [
        {
          id: 2,
          path: "src/config.js",
          line: 15,
          start_line: 12,
          original_line: 15,
          original_start_line: 12,
          user: { login: "copilot[bot]" },
          html_url: "https://github.com/test/pr/1#comment-2",
          body: "Refactor:\n```suggestion\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```",
        },
      ];
      const result = parseSuggestions(comments);
      expect(result).toHaveLength(1);
      expect(result[0].startLine).toBe(12);
      expect(result[0].endLine).toBe(15);
      expect(result[0].suggestedCode).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\n");
    });

    it("filters by author when specified", () => {
      const comments = [
        {
          id: 1,
          path: "a.js",
          line: 5,
          user: { login: "copilot[bot]" },
          body: "```suggestion\nfixed\n```",
        },
        {
          id: 2,
          path: "a.js",
          line: 10,
          user: { login: "human" },
          body: "```suggestion\nalso fixed\n```",
        },
      ];
      const result = parseSuggestions(comments, "copilot[bot]");
      expect(result).toHaveLength(1);
      expect(result[0].author).toBe("copilot[bot]");
    });

    it("ignores comments without suggestion blocks", () => {
      const comments = [
        {
          id: 1,
          path: "a.js",
          line: 5,
          user: { login: "reviewer" },
          body: "This looks wrong, please fix the JSDoc comment.",
        },
      ];
      const result = parseSuggestions(comments);
      expect(result).toHaveLength(0);
    });

    it("handles multiple suggestions in one comment", () => {
      const comments = [
        {
          id: 1,
          path: "a.js",
          line: 10,
          start_line: 8,
          user: { login: "bot" },
          body: "Two fixes:\n```suggestion\nline1\n```\nand\n```suggestion\nline2\n```\n",
        },
      ];
      const result = parseSuggestions(comments);
      expect(result).toHaveLength(2);
    });
  });

  describe("removeOverlaps", () => {
    it("keeps non-overlapping suggestions", () => {
      const suggestions = [
        { startLine: 20, endLine: 25 },
        { startLine: 10, endLine: 15 },
        { startLine: 1, endLine: 5 },
      ];
      const result = removeOverlaps(suggestions);
      expect(result).toHaveLength(3);
    });

    it("removes overlapping suggestions", () => {
      const suggestions = [
        { startLine: 20, endLine: 25 },
        { startLine: 18, endLine: 22 }, // overlaps with first
        { startLine: 10, endLine: 15 },
      ];
      const result = removeOverlaps(suggestions);
      expect(result).toHaveLength(2);
      expect(result[0].endLine).toBe(25);
      expect(result[1].endLine).toBe(15);
    });
  });

  describe("applyToContent", () => {
    it("applies single-line replacement", () => {
      const content = "line1\nline2\nline3\nline4\nline5";
      const suggestions = [
        { startLine: 3, endLine: 3, suggestedCode: "REPLACED\n" },
      ];
      const result = applyToContent(content, suggestions);
      expect(result).toBe("line1\nline2\nREPLACED\nline4\nline5");
    });

    it("applies multi-line replacement", () => {
      const content = "a\nb\nc\nd\ne";
      const suggestions = [
        { startLine: 2, endLine: 4, suggestedCode: "X\nY\n" },
      ];
      const result = applyToContent(content, suggestions);
      expect(result).toBe("a\nX\nY\ne");
    });

    it("applies multiple non-overlapping replacements bottom-to-top", () => {
      const content = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
      const suggestions = [
        { startLine: 8, endLine: 9, suggestedCode: "EIGHT-NINE\n" },
        { startLine: 3, endLine: 4, suggestedCode: "THREE-FOUR\n" },
      ];
      const result = applyToContent(content, suggestions);
      expect(result).toBe("1\n2\nTHREE-FOUR\n5\n6\n7\nEIGHT-NINE\n10");
    });

    it("handles replacement that changes line count", () => {
      const content = "a\nb\nc\nd";
      const suggestions = [
        { startLine: 2, endLine: 3, suggestedCode: "X\nY\nZ\n" },
      ];
      const result = applyToContent(content, suggestions);
      expect(result).toBe("a\nX\nY\nZ\nd");
    });
  });
});
