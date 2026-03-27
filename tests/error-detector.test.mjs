import { describe, it, expect, beforeEach } from "vitest";

import {
  PLAN_STUCK_PATTERNS,
  RATE_LIMIT_PATTERNS,
  TOKEN_OVERFLOW_PATTERNS,
  REQUEST_ERROR_PATTERNS,
  AUTH_ERROR_PATTERNS,
  MODEL_ERROR_PATTERNS,
  CONTENT_POLICY_PATTERNS,
  CODEX_SANDBOX_PATTERNS,
  PUSH_FAILURE_PATTERNS,
  PERMISSION_WAIT_PATTERNS,
  EMPTY_RESPONSE_PATTERNS,
  TEST_FAILURE_PATTERNS,
  LINT_FAILURE_PATTERNS,
  OOM_KILL_PATTERNS,
  OOM_PATTERNS,
  PATTERN_SEVERITY,
  ErrorDetector,
  createErrorDetector,
} from "../infra/error-detector.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDetector(overrides = {}) {
  return new ErrorDetector({
    maxConsecutiveErrors: 5,
    cooldownMs: 300_000,
    rateLimitCooldownMs: 60_000,
    ...overrides,
  });
}

function someMatch(patterns, text) {
  return patterns.some((rx) => rx.test(text));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("error-detector", () => {
  // ────────────────────────────────────────────────────────────────────────
  // Pattern arrays
  // ────────────────────────────────────────────────────────────────────────

  describe("pattern arrays", () => {
    const allPatternArrays = [
      ["PLAN_STUCK_PATTERNS", PLAN_STUCK_PATTERNS],
      ["RATE_LIMIT_PATTERNS", RATE_LIMIT_PATTERNS],
      ["TOKEN_OVERFLOW_PATTERNS", TOKEN_OVERFLOW_PATTERNS],
      ["REQUEST_ERROR_PATTERNS", REQUEST_ERROR_PATTERNS],
      ["AUTH_ERROR_PATTERNS", AUTH_ERROR_PATTERNS],
      ["MODEL_ERROR_PATTERNS", MODEL_ERROR_PATTERNS],
      ["CONTENT_POLICY_PATTERNS", CONTENT_POLICY_PATTERNS],
      ["CODEX_SANDBOX_PATTERNS", CODEX_SANDBOX_PATTERNS],
      ["PUSH_FAILURE_PATTERNS", PUSH_FAILURE_PATTERNS],
      ["PERMISSION_WAIT_PATTERNS", PERMISSION_WAIT_PATTERNS],
      ["EMPTY_RESPONSE_PATTERNS", EMPTY_RESPONSE_PATTERNS],
      ["TEST_FAILURE_PATTERNS", TEST_FAILURE_PATTERNS],
      ["LINT_FAILURE_PATTERNS", LINT_FAILURE_PATTERNS],
      ["OOM_KILL_PATTERNS", OOM_KILL_PATTERNS],
      ["OOM_PATTERNS", OOM_PATTERNS],
    ];

    it.each(allPatternArrays)(
      "%s is a non-empty array of RegExp",
      (_name, arr) => {
        expect(Array.isArray(arr)).toBe(true);
        expect(arr.length).toBeGreaterThan(0);
        for (const rx of arr) {
          expect(rx).toBeInstanceOf(RegExp);
        }
      },
    );

    it("PATTERN_SEVERITY maps all pattern types to valid severity strings", () => {
      const validSeverities = ["low", "medium", "high", "critical"];
      expect(Object.keys(PATTERN_SEVERITY).length).toBeGreaterThan(0);
      for (const [key, val] of Object.entries(PATTERN_SEVERITY)) {
        expect(validSeverities).toContain(val);
      }
    });

    it("PLAN_STUCK_PATTERNS match 'ready to start implementing'", () => {
      expect(someMatch(PLAN_STUCK_PATTERNS, "ready to start implementing")).toBe(true);
    });

    it("RATE_LIMIT_PATTERNS match '429 Too Many Requests'", () => {
      expect(someMatch(RATE_LIMIT_PATTERNS, "429 Too Many Requests")).toBe(true);
    });

    it("TOKEN_OVERFLOW_PATTERNS match 'context_length_exceeded'", () => {
      expect(someMatch(TOKEN_OVERFLOW_PATTERNS, "context_length_exceeded")).toBe(true);
    });

    it("AUTH_ERROR_PATTERNS match '401 Unauthorized'", () => {
      expect(someMatch(AUTH_ERROR_PATTERNS, "401 Unauthorized")).toBe(true);
    });

    it("MODEL_ERROR_PATTERNS match 'model not found'", () => {
      expect(someMatch(MODEL_ERROR_PATTERNS, "model not found")).toBe(true);
    });

    it("CONTENT_POLICY_PATTERNS match 'content_policy_violation'", () => {
      expect(someMatch(CONTENT_POLICY_PATTERNS, "content_policy_violation")).toBe(true);
    });

    it("REQUEST_ERROR_PATTERNS match '400 Bad Request'", () => {
      expect(someMatch(REQUEST_ERROR_PATTERNS, "400 Bad Request")).toBe(true);
    });

    it("CODEX_SANDBOX_PATTERNS match 'sandbox error'", () => {
      expect(someMatch(CODEX_SANDBOX_PATTERNS, "sandbox error")).toBe(true);
    });

    it("PUSH_FAILURE_PATTERNS match 'git push failed'", () => {
      expect(someMatch(PUSH_FAILURE_PATTERNS, "git push failed")).toBe(true);
    });

    it("TEST_FAILURE_PATTERNS match 'tests failed'", () => {
      expect(someMatch(TEST_FAILURE_PATTERNS, "tests failed")).toBe(true);
    });

    it("LINT_FAILURE_PATTERNS match 'eslint error'", () => {
      expect(someMatch(LINT_FAILURE_PATTERNS, "eslint error")).toBe(true);
    });

    it("OOM_KILL_PATTERNS match 'SIGKILL'", () => {
      expect(someMatch(OOM_KILL_PATTERNS, "SIGKILL")).toBe(true);
    });

    it("OOM_PATTERNS match 'heap out of memory'", () => {
      expect(someMatch(OOM_PATTERNS, "heap out of memory")).toBe(true);
    });

    it("PERMISSION_WAIT_PATTERNS match 'waiting for input'", () => {
      expect(someMatch(PERMISSION_WAIT_PATTERNS, "waiting for input")).toBe(true);
    });

    it("EMPTY_RESPONSE_PATTERNS match empty/whitespace strings", () => {
      expect(someMatch(EMPTY_RESPONSE_PATTERNS, "   ")).toBe(true);
      expect(someMatch(EMPTY_RESPONSE_PATTERNS, "")).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // ErrorDetector.classify
  // ────────────────────────────────────────────────────────────────────────

  describe("ErrorDetector.classify", () => {
    let detector;

    beforeEach(() => {
      detector = makeDetector();
    });

    it("returns object with pattern, confidence, details, rawMatch, severity", () => {
      const result = detector.classify("some error text");
      expect(result).toHaveProperty("pattern");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("details");
      expect(result).toHaveProperty("rawMatch");
      expect(result).toHaveProperty("severity");
    });

    it("classifies 'ready to start' as plan_stuck", () => {
      const result = detector.classify("I'm ready to start implementing the changes");
      expect(result.pattern).toBe("plan_stuck");
    });

    it("classifies '429 rate limit' as rate_limit", () => {
      const result = detector.classify("Error: 429 rate limit exceeded");
      expect(result.pattern).toBe("rate_limit");
    });

    it("classifies 'context_length_exceeded' as token_overflow", () => {
      const result = detector.classify("Error: context_length_exceeded");
      expect(result.pattern).toBe("token_overflow");
    });

    it("classifies '401 Unauthorized' as auth_error", () => {
      const result = detector.classify("HTTP 401 Unauthorized");
      expect(result.pattern).toBe("auth_error");
    });

    it("classifies 'SIGKILL' as oom_kill", () => {
      const result = detector.classify("Process exited with SIGKILL");
      expect(result.pattern).toBe("oom_kill");
    });

    it("classifies unknown text as 'unknown' pattern", () => {
      const result = detector.classify("everything is fine, no errors here");
      expect(result.pattern).toBe("unknown");
    });

    it("classifies empty input as 'unknown'", () => {
      const result = detector.classify("");
      expect(result.pattern).toBe("unknown");
    });

    it("handles error in second parameter (stderr)", () => {
      const result = detector.classify("", "Error: 429 Too Many Requests");
      expect(result.pattern).toBe("rate_limit");
    });

    it("auth_error takes precedence over api_error for '401 Unauthorized'", () => {
      // 401 could match both auth and api patterns; auth should win
      const result = detector.classify("401 Unauthorized");
      expect(result.pattern).toBe("auth_error");
      expect(result.pattern).not.toBe("api_error");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // ErrorDetector.recordError
  // ────────────────────────────────────────────────────────────────────────

  describe("ErrorDetector.recordError", () => {
    let detector;

    beforeEach(() => {
      detector = makeDetector({ maxConsecutiveErrors: 3 });
    });

    it("returns block action after max consecutive errors", () => {
      const classification = detector.classify("some unknown error");
      detector.recordError("task-1", classification);
      detector.recordError("task-1", classification);
      const result = detector.recordError("task-1", classification);
      expect(result.action).toBe("block");
    });

    it("returns retry_with_prompt for plan_stuck", () => {
      const classification = detector.classify("ready to start implementing");
      const result = detector.recordError("task-1", classification);
      expect(result.action).toBe("retry_with_prompt");
      expect(result.prompt).toBeDefined();
    });

    it("returns cooldown for rate_limit", () => {
      const classification = detector.classify("429 Too Many Requests");
      const result = detector.recordError("task-1", classification);
      expect(result.action).toBe("cooldown");
      expect(result.cooldownMs).toBeDefined();
    });

    it("returns new_session for token_overflow", () => {
      const classification = detector.classify("context_length_exceeded");
      const result = detector.recordError("task-1", classification);
      expect(result.action).toBe("new_session");
    });

    it("returns manual for missing taskId", () => {
      const classification = detector.classify("some error");
      const result = detector.recordError(null, classification);
      expect(result.action).toBe("manual");
    });

    it("increments consecutive error count", () => {
      const classification = detector.classify("some unknown error");
      const r1 = detector.recordError("task-1", classification);
      const r2 = detector.recordError("task-1", classification);
      expect(r2.errorCount).toBe(r1.errorCount + 1);
    });

    it("fires onErrorDetected callback", () => {
      let callbackData = null;
      const det = makeDetector({
        onErrorDetected: (data) => {
          callbackData = data;
        },
      });
      const classification = det.classify("429 Too Many Requests");
      det.recordError("task-1", classification);
      expect(callbackData).not.toBeNull();
      expect(callbackData.taskId).toBe("task-1");
      expect(callbackData.classification).toBe(classification);
      expect(callbackData.errorCount).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // ErrorDetector.resetTask (recordSuccess equivalent)
  // ────────────────────────────────────────────────────────────────────────

  describe("ErrorDetector.resetTask", () => {
    let detector;

    beforeEach(() => {
      detector = makeDetector();
    });

    it("resets consecutive error count", () => {
      const classification = detector.classify("some unknown error");
      detector.recordError("task-1", classification);
      detector.recordError("task-1", classification);
      detector.resetTask("task-1");

      // After reset, recording a new error should start at count 1
      const result = detector.recordError("task-1", classification);
      expect(result.errorCount).toBe(1);
    });

    it("increments totalRecoveries", () => {
      const classification = detector.classify("some unknown error");
      detector.recordError("task-1", classification);
      detector.recordError("task-1", classification);

      const statsBefore = detector.getStats();
      detector.resetTask("task-1");
      const statsAfter = detector.getStats();

      expect(statsAfter.totalRecoveries).toBeGreaterThan(
        statsBefore.totalRecoveries,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // createErrorDetector
  // ────────────────────────────────────────────────────────────────────────

  describe("createErrorDetector", () => {
    it("returns an ErrorDetector instance", () => {
      const det = createErrorDetector();
      expect(det).toBeInstanceOf(ErrorDetector);
    });

    it("accepts custom options", () => {
      const det = createErrorDetector({ maxConsecutiveErrors: 10 });
      expect(det.maxConsecutiveErrors).toBe(10);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // getStats (getTaskStats / getGlobalStats)
  // ────────────────────────────────────────────────────────────────────────

  describe("getStats", () => {
    let detector;

    beforeEach(() => {
      detector = makeDetector();
    });

    it("returns null-equivalent for unknown task in taskBreakdown", () => {
      const stats = detector.getStats();
      expect(stats.taskBreakdown["nonexistent-task"]).toBeUndefined();
    });

    it("returns totalErrors and totalRecoveries", () => {
      const classification = detector.classify("some unknown error");
      detector.recordError("task-1", classification);
      detector.resetTask("task-1");

      const stats = detector.getStats();
      expect(stats).toHaveProperty("totalErrors");
      expect(stats).toHaveProperty("totalRecoveries");
      expect(stats.totalErrors).toBe(1);
      expect(stats.totalRecoveries).toBeGreaterThan(0);
    });
  });
});
