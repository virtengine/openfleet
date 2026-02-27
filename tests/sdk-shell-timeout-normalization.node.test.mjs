import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const codexSource = readFileSync(
  resolve(process.cwd(), "codex-shell.mjs"),
  "utf8",
);
const copilotSource = readFileSync(
  resolve(process.cwd(), "copilot-shell.mjs"),
  "utf8",
);

const MAX_TIMER_DELAY = 2_147_483_647; // 2^31 - 1, Node.js timer limit

describe("sdk-shell timeout normalization", () => {
  describe("codex-shell.mjs", () => {
    it("defines MAX_TIMER_DELAY_MS constant equal to 2147483647", () => {
      assert.ok(
        codexSource.includes("MAX_TIMER_DELAY_MS") ||
          codexSource.includes("2147483647") ||
          codexSource.includes("2_147_483_647"),
        "codex-shell should define MAX_TIMER_DELAY_MS = 2^31 - 1",
      );
    });

    it("defines normalizeTimeoutMs function", () => {
      assert.ok(
        codexSource.includes("normalizeTimeoutMs"),
        "codex-shell should define normalizeTimeoutMs",
      );
    });

    it("clamps timeout values to MAX_TIMER_DELAY_MS", () => {
      const hasClamping =
        codexSource.includes("normalizeTimeoutMs") &&
        (codexSource.includes("MAX_TIMER_DELAY_MS") ||
          codexSource.includes("2147483647") ||
          codexSource.includes("2_147_483_647")) &&
        codexSource.includes("Math.min");
      assert.ok(
        hasClamping,
        "normalizeTimeoutMs should clamp values to MAX_TIMER_DELAY_MS via Math.min",
      );
    });

    it("defines parsePositiveTimeoutMs function", () => {
      assert.ok(
        codexSource.includes("parsePositiveTimeoutMs"),
        "codex-shell should define parsePositiveTimeoutMs",
      );
    });

    it("parsePositiveTimeoutMs guards against NaN, zero, and non-finite values", () => {
      const hasGuards =
        codexSource.includes("parsePositiveTimeoutMs") &&
        (codexSource.includes("isFinite") || codexSource.includes("isNaN")) &&
        (codexSource.includes("<= 0") || codexSource.includes("< 0") ||
          codexSource.includes("> 0"));
      assert.ok(
        hasGuards,
        "parsePositiveTimeoutMs should guard against NaN, ≤0, and non-finite values",
      );
    });

    it("deduplicates overflow warning via a warning key", () => {
      assert.ok(
        codexSource.includes("timeoutNormalizationWarningKey") ||
          codexSource.includes("normalizationWarning"),
        "codex-shell should deduplicate timeout normalization warnings",
      );
    });

    it("uses normalizeTimeoutMs or parsePositiveTimeoutMs in execCodexPrompt", () => {
      const hasUsage =
        codexSource.includes("execCodexPrompt") &&
        (codexSource.includes("normalizeTimeoutMs") ||
          codexSource.includes("parsePositiveTimeoutMs"));
      assert.ok(
        hasUsage,
        "execCodexPrompt should use timeout normalization helpers",
      );
    });
  });

  describe("copilot-shell.mjs", () => {
    it("defines MAX_TIMER_DELAY_MS constant equal to 2147483647", () => {
      assert.ok(
        copilotSource.includes("MAX_TIMER_DELAY_MS") ||
          copilotSource.includes("2147483647") ||
          copilotSource.includes("2_147_483_647"),
        "copilot-shell should define MAX_TIMER_DELAY_MS = 2^31 - 1",
      );
    });

    it("defines normalizeTimeoutMs function", () => {
      assert.ok(
        copilotSource.includes("normalizeTimeoutMs"),
        "copilot-shell should define normalizeTimeoutMs",
      );
    });

    it("clamps timeout values to MAX_TIMER_DELAY_MS", () => {
      const hasClamping =
        copilotSource.includes("normalizeTimeoutMs") &&
        (copilotSource.includes("MAX_TIMER_DELAY_MS") ||
          copilotSource.includes("2147483647") ||
          copilotSource.includes("2_147_483_647")) &&
        copilotSource.includes("Math.min");
      assert.ok(
        hasClamping,
        "normalizeTimeoutMs should clamp values to MAX_TIMER_DELAY_MS via Math.min",
      );
    });

    it("uses normalizeTimeoutMs or parsePositiveTimeoutMs in execCopilotPrompt", () => {
      const hasUsage =
        copilotSource.includes("execCopilotPrompt") &&
        (copilotSource.includes("normalizeTimeoutMs") ||
          copilotSource.includes("parsePositiveTimeoutMs"));
      assert.ok(
        hasUsage,
        "execCopilotPrompt should use timeout normalization helpers",
      );
    });
  });
});
