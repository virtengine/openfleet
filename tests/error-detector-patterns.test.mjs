/**
 * Tests for error-detector.mjs pattern classification
 * Covers error pattern detection, classification, and edge cases
 */

import { describe, it, expect } from "vitest";
import {
  ErrorDetector,
  createErrorDetector,
  PLAN_STUCK_PATTERNS,
  RATE_LIMIT_PATTERNS,
  TOKEN_OVERFLOW_PATTERNS,
  API_ERROR_PATTERNS,
  SESSION_EXPIRED_PATTERNS,
  BUILD_FAILURE_PATTERNS,
  GIT_CONFLICT_PATTERNS,
} from "../error-detector.mjs";

describe("error-detector pattern exports", () => {
  describe("PLAN_STUCK_PATTERNS", () => {
    it("detects 'ready to start' patterns", () => {
      const test = "I'm ready to implement the changes now";
      const matched = PLAN_STUCK_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'would you like me to proceed' patterns", () => {
      const test = "Would you like me to proceed with the implementation?";
      const matched = PLAN_STUCK_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'here's the plan' patterns", () => {
      const test = "Here's the plan I've outlined for this task";
      const matched = PLAN_STUCK_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'awaiting' patterns", () => {
      const test = "awaiting your input on how to proceed with the next step";
      const matched = PLAN_STUCK_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects plan.md file path references", () => {
      const test = "created plan at /tmp/tasks/task-123/plan.md";
      const matched = PLAN_STUCK_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("is case insensitive", () => {
      const test = "READY TO BEGIN IMPLEMENTATION";
      const matched = PLAN_STUCK_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("rejects normal implementation output", () => {
      const test = "Successfully updated 5 files with the new feature";
      const matched = PLAN_STUCK_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(false);
    });
  });

  describe("RATE_LIMIT_PATTERNS", () => {
    it("detects 429 too many requests", () => {
      const test = "429 Error: too many requests to the API";
      const matched = RATE_LIMIT_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'rate limit exceeded'", () => {
      const test = "rate_limit_exceeded: Please wait before retrying";
      const matched = RATE_LIMIT_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'quota exceeded'", () => {
      const test = "quota exceeded for billing account";
      const matched = RATE_LIMIT_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects TPM (tokens per minute) limits", () => {
      const test = "exceeded tokens per minute TPM limit of 90000";
      const matched = RATE_LIMIT_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("is case insensitive", () => {
      const test = "RATE LIMIT EXCEEDED";
      const matched = RATE_LIMIT_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });
  });

  describe("TOKEN_OVERFLOW_PATTERNS", () => {
    it("detects 'context too long'", () => {
      const test = "context is too long, please reduce input";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'max context length exceeded'", () => {
      const test = "max context length exceeded by 500 tokens";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'conversation too long'", () => {
      const test = "conversation too long, cannot add more history";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects '413 Payload Too Large'", () => {
      const test = "HTTP 413 Payload Too Large";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'context_length_exceeded' (OpenAI format)", () => {
      const test = "error: context_length_exceeded";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'prompt_too_long' (Anthropic format)", () => {
      const test = "error_code: prompt_too_long";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'This model's maximum context length'", () => {
      const test = "This model's maximum context length is 4096 tokens";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects 'input too large'", () => {
      const test = "input too large for processing";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("is case insensitive", () => {
      const test = "CONTEXT_LENGTH_EXCEEDED";
      const matched = TOKEN_OVERFLOW_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });
  });

  describe("API_ERROR_PATTERNS", () => {
    it("detects network connection errors", () => {
      expect(API_ERROR_PATTERNS.some(p => p.test("ECONNREFUSED"))).toBe(true);
      expect(API_ERROR_PATTERNS.some(p => p.test("ETIMEDOUT"))).toBe(true);
      expect(API_ERROR_PATTERNS.some(p => p.test("ENOTFOUND"))).toBe(true);
    });

    it("detects HTTP 5xx server errors", () => {
      expect(API_ERROR_PATTERNS.some(p => p.test("500 Internal Server Error"))).toBe(true);
      expect(API_ERROR_PATTERNS.some(p => p.test("502 Bad Gateway"))).toBe(true);
      expect(API_ERROR_PATTERNS.some(p => p.test("503 Service Unavailable"))).toBe(true);
      expect(API_ERROR_PATTERNS.some(p => p.test("504 Gateway Timeout"))).toBe(true);
    });

    it("detects 408 Request Timeout", () => {
      const test = "408 Request Timeout";
      const matched = API_ERROR_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects fetch/network failures", () => {
      expect(API_ERROR_PATTERNS.some(p => p.test("fetch failed"))).toBe(true);
      expect(API_ERROR_PATTERNS.some(p => p.test("request failed"))).toBe(true);
    });
  });

  describe("SESSION_EXPIRED_PATTERNS", () => {
    it("detects session expiration", () => {
      const test = "session has expired, please authenticate again";
      const matched = SESSION_EXPIRED_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects missing thread/conversation", () => {
      const test = "thread not found in conversation history";
      const matched = SESSION_EXPIRED_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects token expiration", () => {
      const test = "authorization token has expired";
      const matched = SESSION_EXPIRED_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });
  });

  describe("BUILD_FAILURE_PATTERNS", () => {
    it("detects compilation errors", () => {
      expect(BUILD_FAILURE_PATTERNS.some(p => p.test("go build: failed"))).toBe(true);
      expect(BUILD_FAILURE_PATTERNS.some(p => p.test("compilation error"))).toBe(true);
    });

    it("detects golangci-lint errors", () => {
      const test = "golangci-lint error: ineffectual assignment";
      const matched = BUILD_FAILURE_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects npm errors", () => {
      expect(BUILD_FAILURE_PATTERNS.some(p => p.test("npm ERR!"))).toBe(true);
      expect(BUILD_FAILURE_PATTERNS.some(p => p.test("pnpm error"))).toBe(true);
    });
  });

  describe("GIT_CONFLICT_PATTERNS", () => {
    it("detects merge conflicts", () => {
      expect(GIT_CONFLICT_PATTERNS.some(p => p.test("merge conflict"))).toBe(true);
      expect(GIT_CONFLICT_PATTERNS.some(p => p.test("CONFLICT (content): Merge"))).toBe(true);
    });

    it("detects rebase conflicts", () => {
      const test = "error: Failed to merge in the changes. Rebase conflict";
      const matched = GIT_CONFLICT_PATTERNS.some(p => p.test(test));
      expect(matched).toBe(true);
    });

    it("detects cannot merge/rebase", () => {
      expect(GIT_CONFLICT_PATTERNS.some(p => p.test("cannot merge"))).toBe(true);
      expect(GIT_CONFLICT_PATTERNS.some(p => p.test("rebase failed"))).toBe(true);
    });
  });
});

describe("ErrorDetector class", () => {
  describe("instantiation", () => {
    it("creates an ErrorDetector instance with defaults", () => {
      const detector = new ErrorDetector();
      expect(detector).toBeDefined();
      expect(detector.maxConsecutiveErrors).toBe(5);
      expect(detector.cooldownMs).toBe(5 * 60 * 1000);
    });

    it("creates an ErrorDetector with custom options", () => {
      const detector = new ErrorDetector({
        maxConsecutiveErrors: 3,
        cooldownMs: 120000,
      });
      expect(detector.maxConsecutiveErrors).toBe(3);
      expect(detector.cooldownMs).toBe(120000);
    });
  });

  describe("classify method", () => {
    it("classifies plan stuck errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("Created plan at /tmp/plan.md - awaiting your feedback");
      expect(result.pattern).toBe("plan_stuck");
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.severity).toBeDefined();
    });

    it("classifies rate limit errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("429: rate_limit_exceeded");
      expect(result.pattern).toBe("rate_limit");
      expect(result.severity).toBe("medium");
    });

    it("classifies token overflow errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("context_length_exceeded: max tokens 4096");
      expect(result.pattern).toBe("token_overflow");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("classifies API errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("500 Internal Server Error: database timeout");
      expect(result.pattern).toBe("api_error");
      expect(result.severity).toBeDefined();
    });

    it("classifies build failures", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("npm ERR! code ERESOLVE: Unable to resolve dependency");
      expect(result.pattern).toBe("build_failure");
      expect(result.details).toBeDefined();
    });

    it("classifies git conflicts", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("CONFLICT (content): Merge conflict in package.json");
      expect(result.pattern).toBe("git_conflict");
      expect(result.severity).toBe("medium");
    });

    it("classifies session expired errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("session has expired, please authenticate again");
      expect(result.pattern).toBe("session_expired");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("returns 'unknown' for unclassified errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("Some random unrelated error message");
      expect(result.pattern).toBe("unknown");
      expect(result.confidence).toBeLessThan(1);
    });

    it("handles multiline logs", () => {
      const detector = new ErrorDetector();
      const multilineLog = `
        2024-01-15 10:30:45 ERROR: Request failed
        Status: 429
        Message: rate_limit_exceeded
        Retry-After: 60
      `;
      const result = detector.classify(multilineLog);
      expect(result.pattern).toBe("rate_limit");
    });

    it("handles stack traces", () => {
      const detector = new ErrorDetector();
      const stackTrace = `Error: context_length_exceeded
        at Object.<anonymous> (/app/src/index.ts:42:15)
        at Module._load (internal/modules/commonjs/loader.js:1170:22)`;
      const result = detector.classify(stackTrace);
      expect(result.pattern).toBe("token_overflow");
    });

    it("has remediation hints for common errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("rate_limit_exceeded");
      expect(result.remediation).toBeDefined();
    });
  });

  describe("classify with error and stderr", () => {
    it("analyzes both stdout and stderr", () => {
      const detector = new ErrorDetector();
      const result = detector.classify(
        "Process completed successfully",
        "Error: 429 rate_limit_exceeded"
      );
      expect(result.pattern).toBe("rate_limit");
    });

    it("handles empty output", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("", "");
      expect(result.pattern).toBe("unknown");
      expect(result.confidence).toBe(0);
    });

    it("handles null/undefined gracefully", () => {
      const detector = new ErrorDetector();
      const result = detector.classify(null);
      expect(result.pattern).toBe("unknown");
      
      const result2 = detector.classify(undefined);
      expect(result2.pattern).toBe("unknown");
    });
  });

  describe("edge cases", () => {
    it("prioritizes more specific matches", () => {
      const detector = new ErrorDetector();
      // Both rate_limit and api_error patterns could match
      const result = detector.classify("429 rate_limit_exceeded");
      expect(result.pattern).toBe("rate_limit");
    });

    it("handles case-insensitive patterns", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("RATE_LIMIT_EXCEEDED");
      expect(result.pattern).toBe("rate_limit");
    });

    it("handles special characters in errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("[ERROR] 429!!! Rate limit exceeded!!!!");
      expect(result.pattern).toBe("rate_limit");
    });

    it("truncates very long raw matches", () => {
      const detector = new ErrorDetector();
      const longError = "rate_limit_exceeded: " + "x".repeat(1000);
      const result = detector.classify(longError);
      expect(result.rawMatch).toBeDefined();
      expect(result.rawMatch.length).toBeLessThan(1000);
    });
  });
});

describe("createErrorDetector factory", () => {
  it("creates a properly configured ErrorDetector instance", () => {
    const detector = createErrorDetector({
      maxConsecutiveErrors: 2,
    });
    expect(detector).toBeInstanceOf(ErrorDetector);
    expect(detector.maxConsecutiveErrors).toBe(2);
  });

  it("factory with no options uses defaults", () => {
    const detector = createErrorDetector();
    expect(detector).toBeInstanceOf(ErrorDetector);
  });
});

describe("error classification accuracy", () => {
  describe("real-world API errors", () => {
    it("classifies OpenAI rate limit errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("RateLimitError: 429 You exceeded your current quota");
      expect(result.pattern).toBe("rate_limit");
    });

    it("classifies Anthropic context length errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("error_type: invalid_request_error, error_code: prompt_too_long");
      // This could match either token_overflow or request_error patterns depending on order
      expect(result.pattern).toMatch(/token_overflow|api_error|request_error/);
    });

    it("classifies Azure API errors", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("deployment not found: 'gpt-35-turbo' is unavailable");
      // This is a request error, not api_error
      expect(result.pattern).toMatch(/request_error|api_error|model_error|unknown/);
    });
  });

  describe("false positive prevention", () => {
    it("doesn't match 'rate' in normal text", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("The speed of the car is impressive");
      // Should not match rate_limit
      expect(result.pattern).not.toBe("rate_limit");
    });

    it("doesn't match 'context' in normal sentences", () => {
      const detector = new ErrorDetector();
      const result = detector.classify("In this context, we need to understand the requirements");
      // Should not match token_overflow
      expect(result.pattern).not.toBe("token_overflow");
    });
  });

  describe("performance", () => {
    it("classifies errors quickly", () => {
      const detector = new ErrorDetector();
      const start = performance.now();
      
      for (let i = 0; i < 1000; i++) {
        detector.classify("rate_limit_exceeded");
      }
      
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5000); // Should complete 1000 classifications in < 5 seconds
    });
  });
});
