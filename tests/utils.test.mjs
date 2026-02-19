import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeDedupKey,
  stripAnsi,
  isErrorLine,
  getErrorFingerprint,
  getMaxParallelFromArgs,
  parsePrNumberFromUrl,
  escapeHtml,
  formatHtmlLink,
} from "../utils.mjs";

describe("normalizeDedupKey", () => {
  it("normalizes numbers and collapses separators", () => {
    const input = "pid 1/2 at 12:34 attempt 9.8";
    const result = normalizeDedupKey(input);

    expect(result).toBe("pid N at N attempt N");
  });

  it("handles empty/falsey input and trims whitespace", () => {
    expect(normalizeDedupKey("")).toBe("");
    expect(normalizeDedupKey(null)).toBe("");
    expect(normalizeDedupKey("  42  ")).toBe("N");
  });
});

describe("stripAnsi", () => {
  it("removes ANSI escape sequences", () => {
    const input = "\u001b[31mERROR\u001b[0m";
    expect(stripAnsi(input)).toBe("ERROR");
  });

  it("removes bracketed ANSI residue without ESC", () => {
    const input = "[31mWARN[0m";
    expect(stripAnsi(input)).toBe("WARN");
  });

  it("handles empty input", () => {
    expect(stripAnsi("")).toBe("");
    expect(stripAnsi(undefined)).toBe("");
  });
});

describe("isErrorLine", () => {
  const errorPatterns = [/ERROR/i, /failed to build/i];
  const noisePatterns = [/ERROR: noop/i, /all good/i];

  it("returns false when noise patterns match", () => {
    const line = "ERROR: noop (ignored)";
    expect(isErrorLine(line, errorPatterns, noisePatterns)).toBe(false);
  });

  it("returns true when an error pattern matches", () => {
    const line = "Build failed to build target";
    expect(isErrorLine(line, errorPatterns, noisePatterns)).toBe(true);
  });

  it("returns false when no patterns match", () => {
    const line = "just a log line";
    expect(isErrorLine(line, errorPatterns, noisePatterns)).toBe(false);
  });
});

describe("getErrorFingerprint", () => {
  it("strips timestamps, attempt IDs, and branch names", () => {
    const line = "[12:34:56] Failed in ve/abc-123 1a2b3c4d";
    expect(getErrorFingerprint(line)).toBe("Failed in ve/<BRANCH> <ID>");
  });

  it("trims whitespace and leaves unrelated text intact", () => {
    const line = "  Something else happened  ";
    expect(getErrorFingerprint(line)).toBe("Something else happened");
  });
});

describe("getMaxParallelFromArgs", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null for non-array inputs", () => {
    expect(getMaxParallelFromArgs(null)).toBeNull();
    expect(getMaxParallelFromArgs("-MaxParallel 2")).toBeNull();
  });

  it("parses direct flag formats", () => {
    expect(getMaxParallelFromArgs(["--maxparallel=4"])).toBe(4);
    expect(getMaxParallelFromArgs(["--max-parallel:6"])).toBe(6);
  });

  it("parses separated flag formats", () => {
    expect(getMaxParallelFromArgs(["-MaxParallel", "3"])).toBe(3);
    expect(getMaxParallelFromArgs(["--max-parallel", "5"])).toBe(5);
  });

  it("falls back to env vars and ignores invalid values", () => {
    process.env.VK_MAX_PARALLEL = "";
    process.env.MAX_PARALLEL = "7";

    expect(getMaxParallelFromArgs(["--maxparallel=0"])).toBe(7);
  });

  it("returns null when flag is missing and env is invalid", () => {
    process.env.VK_MAX_PARALLEL = "-2";
    delete process.env.MAX_PARALLEL;

    expect(getMaxParallelFromArgs(["--other", "value"])).toBeNull();
  });
});

describe("parsePrNumberFromUrl", () => {
  it("extracts PR number from URL", () => {
    expect(
      parsePrNumberFromUrl("https://github.com/acme/virtengine/pull/123"),
    ).toBe(123);
  });

  it("returns null for malformed or empty URLs", () => {
    expect(parsePrNumberFromUrl("")).toBeNull();
    expect(parsePrNumberFromUrl("https://github.com/acme/repo/pull/abc")).toBeNull();
    expect(parsePrNumberFromUrl("not a url")).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    const input = `&"'><div>`;
    expect(escapeHtml(input)).toBe("&amp;&quot;&#39;&gt;&lt;div&gt;");
  });
});

describe("formatHtmlLink", () => {
  it("formats an anchor tag with escaped values", () => {
    const url = "https://example.com/?q=1&x=2";
    const label = "click <here>";
    expect(formatHtmlLink(url, label)).toBe(
      "<a href=\"https://example.com/?q=1&amp;x=2\">click &lt;here&gt;</a>",
    );
  });

  it("returns escaped label when URL is missing", () => {
    expect(formatHtmlLink("", "<none>")).toBe("&lt;none&gt;");
  });
});
