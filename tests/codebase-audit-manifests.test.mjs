import { describe, it, expect } from "vitest";
import {
  buildSummary,
  summaryFromLine,
  upsertManagedBlock,
  buildClaudeManifest,
  buildAgentsManifest,
} from "../lib/codebase-audit-manifests.mjs";

describe("codebase-audit-manifests", () => {
  describe("buildSummary", () => {
    it("returns a string ending with a period", () => {
      const result = buildSummary(
        { absolutePath: "/repo/lib/foo.mjs", path: "lib/foo.mjs", category: "source" },
        () => "",
      );
      expect(result).toMatch(/\.$/);
    });

    it("uses test category role for test files", () => {
      const result = buildSummary(
        { absolutePath: "/repo/tests/foo.test.mjs", path: "tests/foo.test.mjs", category: "test" },
        () => "",
      );
      expect(result).toMatch(/Covers regression and behavior checks/);
    });

    it("detects cli basename role", () => {
      const result = buildSummary(
        { absolutePath: "/repo/cli.mjs", path: "cli.mjs", category: "source" },
        () => "",
      );
      expect(result).toMatch(/Routes the command-line entrypoint/);
    });

    it("detects files containing readFileSync as filesystem role", () => {
      const result = buildSummary(
        { absolutePath: "/repo/lib/loader.mjs", path: "lib/loader.mjs", category: "source" },
        () => "const x = readFileSync(p);",
      );
      expect(result).toMatch(/filesystem discovery/i);
    });

    it("detects files containing export function as having public API hint", () => {
      const result = buildSummary(
        { absolutePath: "/repo/lib/loader.mjs", path: "lib/loader.mjs", category: "source" },
        () => "export function doStuff() {}",
      );
      expect(result).toContain("its public API");
    });

    it("detects files containing describe( as having test coverage hint", () => {
      const result = buildSummary(
        { absolutePath: "/repo/tests/foo.test.mjs", path: "tests/foo.test.mjs", category: "test" },
        () => 'describe("suite", () => {});',
      );
      expect(result).toContain("test coverage");
    });

    it("includes up to 2 hints in detail", () => {
      const result = buildSummary(
        { absolutePath: "/repo/lib/loader.mjs", path: "lib/loader.mjs", category: "source" },
        () => 'export function x() {}\nreadFileSync("a");\ndescribe("t", () => {});',
      );
      expect(result).toContain("including");
      const match = result.match(/including (.+)\./);
      const parts = match[1].split(" and ");
      expect(parts.length).toBeLessThanOrEqual(2);
    });

    it("falls back to generic Owns X logic for Y for unknown files", () => {
      const result = buildSummary(
        { absolutePath: "/repo/lib/banana.mjs", path: "lib/banana.mjs", category: "source" },
        () => "const x = 1;",
      );
      expect(result).toMatch(/^Owns banana logic for lib\.$/);
    });

    it("handles file with config in the name", () => {
      const result = buildSummary(
        { absolutePath: "/repo/config/config.mjs", path: "config/config.mjs", category: "source" },
        () => "",
      );
      expect(result).toMatch(/Loads and normalizes configuration state/);
    });
  });

  describe("summaryFromLine", () => {
    it("returns fallback when line is null or empty", () => {
      expect(summaryFromLine(null, "default")).toBe("default");
      expect(summaryFromLine("", "default")).toBe("default");
    });

    it("strips // CLAUDE:SUMMARY prefix", () => {
      expect(summaryFromLine("// CLAUDE:SUMMARY This does stuff", "fallback")).toBe("This does stuff");
    });

    it("strips # BOSUN:SUMMARY prefix", () => {
      expect(summaryFromLine("# BOSUN:SUMMARY Another summary", "fallback")).toBe("Another summary");
    });

    it("returns fallback when line is only the prefix", () => {
      expect(summaryFromLine("// CLAUDE:SUMMARY ", "fallback")).toBe("fallback");
    });

    it("returns the trimmed content after prefix", () => {
      expect(summaryFromLine("// CLAUDE:SUMMARY   spaced out  ", "fallback")).toBe("spaced out");
    });
  });

  describe("upsertManagedBlock", () => {
    const block = "<!-- bosun-audit:begin -->\nContent\n<!-- bosun-audit:end -->";

    it("returns block with trailing newline when existing is null or empty", () => {
      expect(upsertManagedBlock(null, block)).toBe(`${block}\n`);
      expect(upsertManagedBlock("", block)).toBe(`${block}\n`);
    });

    it("appends block to existing content when no managed block exists", () => {
      const result = upsertManagedBlock("# Existing doc", block);
      expect(result).toContain("# Existing doc");
      expect(result).toContain(block);
      expect(result).toMatch(/# Existing doc\n\n/);
    });

    it("replaces existing managed block when markers are found", () => {
      const existing = "Preamble\n<!-- bosun-audit:begin -->\nOld stuff\n<!-- bosun-audit:end -->\nPostamble";
      const newBlock = "<!-- bosun-audit:begin -->\nNew stuff\n<!-- bosun-audit:end -->";
      const result = upsertManagedBlock(existing, newBlock);
      expect(result).toContain("New stuff");
      expect(result).not.toContain("Old stuff");
      expect(result).toContain("Preamble");
      expect(result).toContain("Postamble");
    });

    it("handles missing end marker gracefully by appending", () => {
      const existing = "Preamble\n<!-- bosun-audit:begin -->\nOrphan content";
      const result = upsertManagedBlock(existing, block);
      expect(result).toContain("Preamble");
      expect(result).toContain(block);
    });
  });

  describe("buildClaudeManifest", () => {
    const repoRoot = "/repo";
    const summarize = (entry) => `Summary for ${entry.path}`;

    function makeEntries(count) {
      return Array.from({ length: count }, (_, i) => ({
        path: `lib/file${i}.mjs`,
        summaryLine: null,
      }));
    }

    it("contains bosun-audit markers", () => {
      const result = buildClaudeManifest("/repo/lib", makeEntries(1), repoRoot, summarize);
      expect(result).toContain("<!-- bosun-audit:begin -->");
      expect(result).toContain("<!-- bosun-audit:end -->");
    });

    it("contains # CLAUDE.md heading", () => {
      const result = buildClaudeManifest("/repo/lib", makeEntries(1), repoRoot, summarize);
      expect(result).toContain("# CLAUDE.md");
    });

    it("lists entries under ## Files", () => {
      const entries = [{ path: "lib/foo.mjs", summaryLine: null }];
      const result = buildClaudeManifest("/repo/lib", entries, repoRoot, summarize);
      expect(result).toContain("## Files");
      expect(result).toContain("`foo.mjs`");
      expect(result).toContain("Summary for lib/foo.mjs");
    });

    it("caps entries at 12 and shows remaining count", () => {
      const entries = makeEntries(15);
      const result = buildClaudeManifest("/repo/lib", entries, repoRoot, summarize);
      expect(result).toContain("Remaining files: 3");
      const fileLines = result.split("\n").filter((l) => l.startsWith("- `file"));
      expect(fileLines.length).toBe(12);
    });

    it("uses summarizeFile fallback when summaryLine is missing", () => {
      const entries = [{ path: "lib/bar.mjs", summaryLine: null }];
      const result = buildClaudeManifest("/repo/lib", entries, repoRoot, summarize);
      expect(result).toContain("Summary for lib/bar.mjs");
    });

    it('uses "." for relative dir when dirPath equals repoRoot', () => {
      const entries = [{ path: "top.mjs", summaryLine: null }];
      const result = buildClaudeManifest("/repo", entries, repoRoot, summarize);
      expect(result).toContain('grep -R "CLAUDE:SUMMARY" .');
    });
  });

  describe("buildAgentsManifest", () => {
    const repoRoot = "/repo";
    const summarize = (entry) => `Agent summary for ${entry.path}`;

    function makeEntries(count) {
      return Array.from({ length: count }, (_, i) => ({
        path: `lib/file${i}.mjs`,
        summaryLine: null,
      }));
    }

    it("contains bosun-audit markers", () => {
      const result = buildAgentsManifest("/repo/lib", makeEntries(1), repoRoot, summarize);
      expect(result).toContain("<!-- bosun-audit:begin -->");
      expect(result).toContain("<!-- bosun-audit:end -->");
    });

    it("contains # AGENTS.md heading", () => {
      const result = buildAgentsManifest("/repo/lib", makeEntries(1), repoRoot, summarize);
      expect(result).toContain("# AGENTS.md");
    });

    it('uses "repository root" scope when dirPath equals repoRoot', () => {
      const result = buildAgentsManifest("/repo", makeEntries(1), repoRoot, summarize);
      expect(result).toContain("`repository root`");
    });

    it("caps entries at 8", () => {
      const entries = makeEntries(12);
      const result = buildAgentsManifest("/repo/lib", entries, repoRoot, summarize);
      const entryLines = result.split("\n").filter((l) => l.startsWith("- `file"));
      expect(entryLines.length).toBe(8);
    });

    it("contains validation section", () => {
      const result = buildAgentsManifest("/repo/lib", makeEntries(1), repoRoot, summarize);
      expect(result).toContain("## Validation");
      expect(result).toContain("bosun audit conformity");
      expect(result).toContain("bosun audit trim");
    });
  });
});
