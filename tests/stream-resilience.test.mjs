import { describe, it, expect } from "vitest";
import {
  MAX_STREAM_RETRIES,
  isTransientStreamError,
  streamRetryDelay,
} from "../infra/stream-resilience.mjs";

describe("stream-resilience", () => {
  // ── MAX_STREAM_RETRIES ──────────────────────────────────────────────
  describe("MAX_STREAM_RETRIES", () => {
    it("is a finite positive number", () => {
      expect(Number.isFinite(MAX_STREAM_RETRIES)).toBe(true);
      expect(MAX_STREAM_RETRIES).toBeGreaterThan(0);
    });

    it("falls within bounds [1, 20]", () => {
      expect(MAX_STREAM_RETRIES).toBeGreaterThanOrEqual(1);
      expect(MAX_STREAM_RETRIES).toBeLessThanOrEqual(20);
    });
  });

  // ── isTransientStreamError ──────────────────────────────────────────
  describe("isTransientStreamError", () => {
    it("returns true for stream disconnected error (Error object)", () => {
      expect(isTransientStreamError(new Error("stream disconnected"))).toBe(true);
    });

    it("returns true for stream disconnected (string)", () => {
      expect(isTransientStreamError("stream disconnected")).toBe(true);
    });

    it("returns true for response.failed", () => {
      expect(isTransientStreamError(new Error("response.failed during call"))).toBe(true);
    });

    it("returns true for stream closed before completion", () => {
      expect(isTransientStreamError(new Error("stream closed before completion"))).toBe(true);
    });

    it("returns true for connection reset / ECONNRESET", () => {
      expect(isTransientStreamError(new Error("connection reset by peer"))).toBe(true);
      expect(isTransientStreamError(new Error("read ECONNRESET"))).toBe(true);
    });

    it("returns true for socket hang up", () => {
      expect(isTransientStreamError(new Error("socket hang up"))).toBe(true);
    });

    it("returns true for ETIMEDOUT", () => {
      expect(isTransientStreamError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
    });

    it("returns true for EPIPE", () => {
      expect(isTransientStreamError(new Error("write EPIPE"))).toBe(true);
    });

    it("returns true for 502 Bad Gateway", () => {
      expect(isTransientStreamError(new Error("502 Bad Gateway"))).toBe(true);
    });

    it("returns true for 503 Service Unavailable", () => {
      expect(isTransientStreamError(new Error("503 Service Unavailable"))).toBe(true);
    });

    it("returns true for 504 Gateway Timeout", () => {
      expect(isTransientStreamError(new Error("504 Gateway Timeout"))).toBe(true);
    });

    it("returns true for rate_limit_exceeded", () => {
      expect(isTransientStreamError(new Error("rate_limit_exceeded"))).toBe(true);
    });

    it("returns true for overloaded_error", () => {
      expect(isTransientStreamError(new Error("overloaded_error"))).toBe(true);
    });

    it("returns true for upstream connect error", () => {
      expect(isTransientStreamError(new Error("upstream connect error or disconnect"))).toBe(true);
    });

    it('returns true for "model is currently overloaded"', () => {
      expect(isTransientStreamError(new Error("model is currently overloaded"))).toBe(true);
    });

    it("returns false for null/undefined", () => {
      expect(isTransientStreamError(null)).toBe(false);
      expect(isTransientStreamError(undefined)).toBe(false);
    });

    it("returns false for regular Error with unrelated message", () => {
      expect(isTransientStreamError(new Error("something completely different"))).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isTransientStreamError("")).toBe(false);
    });

    it('returns false for non-transient errors like "invalid_request 502"', () => {
      expect(isTransientStreamError(new Error("invalid_request 502"))).toBe(false);
    });

    it('returns false for auth errors like "401 Unauthorized"', () => {
      expect(isTransientStreamError(new Error("401 Unauthorized"))).toBe(false);
    });

    it("returns true for case-insensitive matches", () => {
      expect(isTransientStreamError(new Error("STREAM DISCONNECTED"))).toBe(true);
      expect(isTransientStreamError(new Error("Socket Hang Up"))).toBe(true);
      expect(isTransientStreamError(new Error("ECONNRESET"))).toBe(true);
    });
  });

  // ── streamRetryDelay ────────────────────────────────────────────────
  describe("streamRetryDelay", () => {
    it("returns a positive number for attempt 0", () => {
      const delay = streamRetryDelay(0);
      expect(delay).toBeGreaterThan(0);
    });

    it("returns increasing delays for successive attempts (on average)", () => {
      const samples = 50;
      let avg0 = 0;
      let avg3 = 0;
      for (let i = 0; i < samples; i++) {
        avg0 += streamRetryDelay(0);
        avg3 += streamRetryDelay(3);
      }
      avg0 /= samples;
      avg3 /= samples;
      expect(avg3).toBeGreaterThan(avg0);
    });

    it("delay is bounded (never exceeds max)", () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const delay = streamRetryDelay(attempt);
        // Max config is 300_000 and jitter can add at most 25%, so 375_000 is a safe upper bound
        expect(delay).toBeLessThanOrEqual(375_000);
      }
    });

    it("returns a number type", () => {
      expect(typeof streamRetryDelay(0)).toBe("number");
      expect(typeof streamRetryDelay(5)).toBe("number");
    });
  });
});
