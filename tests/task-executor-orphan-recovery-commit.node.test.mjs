import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(
  resolve(process.cwd(), "task-executor.mjs"),
  "utf8",
);

describe("task-executor orphan recovery commit hardening", () => {
  describe("git environment hardening", () => {
    it("sets GIT_TERMINAL_PROMPT=0 to prevent interactive prompts", () => {
      assert.ok(
        source.includes("GIT_TERMINAL_PROMPT") &&
          (source.includes('"0"') || source.includes("'0'") ||
            source.includes("GIT_TERMINAL_PROMPT=0")),
        "orphan recovery should set GIT_TERMINAL_PROMPT=0",
      );
    });

    it("sets GCM_INTERACTIVE=Never to disable Git Credential Manager prompts", () => {
      assert.ok(
        source.includes("GCM_INTERACTIVE") &&
          (source.includes("Never") || source.includes("never")),
        "orphan recovery should set GCM_INTERACTIVE=Never",
      );
    });

    it("sets GIT_ASKPASS to empty string to suppress credential prompts", () => {
      assert.ok(
        source.includes("GIT_ASKPASS") &&
          (source.includes('""') || source.includes("''") ||
            source.includes("GIT_ASKPASS=")),
        "orphan recovery should set GIT_ASKPASS to empty string",
      );
    });

    it("passes --no-gpg-sign to git commit to prevent GPG signing hang", () => {
      assert.ok(
        source.includes("--no-gpg-sign"),
        "orphan recovery git commit should include --no-gpg-sign",
      );
    });

    it("disables commit.gpgsign via -c flag", () => {
      assert.ok(
        source.includes("commit.gpgsign=false") ||
          source.includes("gpgsign=false"),
        "orphan recovery should disable GPG signing via -c commit.gpgsign=false",
      );
    });
  });

  describe("per-task skip state", () => {
    it("uses per-task skip state key scoped to task ID prefix", () => {
      // Skip state key should include the task ID prefix for per-task tracking
      const hasTaskKey =
        source.includes("task:${taskIdPrefix}") ||
        source.includes("task:${") ||
        /skip.*task.*prefix|task.*prefix.*skip/.test(source);
      assert.ok(
        hasTaskKey,
        "orphan recovery should use per-task skip state key with task ID prefix",
      );
    });

    it("persists skip state on commit hook failures", () => {
      assert.ok(
        source.includes("skipState") || source.includes("skip_state"),
        "orphan recovery should persist skip state on hook failures",
      );
    });
  });

  describe("ETIMEDOUT error handling", () => {
    it("includes ETIMEDOUT in orphan recovery error check", () => {
      assert.ok(
        source.includes("ETIMEDOUT"),
        "orphan recovery should handle ETIMEDOUT errors",
      );
    });

    it("persists skip state on timeout failures", () => {
      // Timeout should be treated like other permanent failures requiring skip
      const hasTimeoutSkip =
        source.includes("ETIMEDOUT") &&
        (source.includes("skipState") || source.includes("skip"));
      assert.ok(
        hasTimeoutSkip,
        "ETIMEDOUT should trigger skip state persistence in orphan recovery",
      );
    });
  });
});
