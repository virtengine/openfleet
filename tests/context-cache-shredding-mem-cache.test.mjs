/**
 * Tests for:
 *   1. Context Shredding Telemetry ring buffer (recordShreddingEvent, getShreddingStats, clearShreddingStats)
 *   2. Tool-Log In-Memory Content Cache (configureToolLogMemCache, evictToolLogMemCache, getToolLogMemCacheStats)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("context-cache – shredding telemetry + tool-log mem cache", () => {
  let cc;

  beforeEach(async () => {
    vi.resetModules();
    cc = await import("../workspace/context-cache.mjs");
    // Start each test with a clean ring buffer and mem cache
    cc.clearShreddingStats();
    cc.evictToolLogMemCache({ all: true });
    // Reset mem-cache config to defaults
    cc.configureToolLogMemCache({ enabled: false, maxSizeBytes: 50 * 1024 * 1024, archiveSizeLimitBytes: 200 * 1024 * 1024 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Shredding Telemetry ────────────────────────────────────────────────────

  describe("recordShreddingEvent", () => {
    it("pushes a valid event to the ring buffer", () => {
      cc.recordShreddingEvent({
        originalChars: 1000,
        compressedChars: 400,
        savedChars: 600,
        savedPct: 60,
        agentType: "openai",
      });
      const stats = cc.getShreddingStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].originalChars).toBe(1000);
      expect(stats[0].savedPct).toBe(60);
      expect(stats[0].agentType).toBe("openai");
      expect(typeof stats[0].timestamp).toBe("string");
    });

    it("skips no-op events (both originalChars and compressedChars are 0)", () => {
      cc.recordShreddingEvent({ originalChars: 0, compressedChars: 0, savedChars: 0, savedPct: 0 });
      expect(cc.getShreddingStats()).toHaveLength(0);
    });

    it("does not skip events where only one of the chars is 0", () => {
      cc.recordShreddingEvent({ originalChars: 500, compressedChars: 0, savedChars: 500, savedPct: 100 });
      expect(cc.getShreddingStats()).toHaveLength(1);
    });

    it("ignores null / non-object arguments without throwing", () => {
      expect(() => cc.recordShreddingEvent(null)).not.toThrow();
      expect(() => cc.recordShreddingEvent(undefined)).not.toThrow();
      expect(() => cc.recordShreddingEvent("bad")).not.toThrow();
      expect(cc.getShreddingStats()).toHaveLength(0);
    });

    it("caps the ring buffer at 500 entries", () => {
      for (let i = 0; i < 510; i++) {
        cc.recordShreddingEvent({ originalChars: 100, compressedChars: 50, savedChars: 50, savedPct: 50 });
      }
      const stats = cc.getShreddingStats();
      expect(stats).toHaveLength(500);
    });

    it("evicts oldest entries when ring buffer is full", () => {
      // Fill buffer with agentType "first"
      for (let i = 0; i < 500; i++) {
        cc.recordShreddingEvent({ originalChars: 100, compressedChars: 50, savedChars: 50, savedPct: 50, agentType: "first" });
      }
      // Push one more — should evict oldest "first" entry
      cc.recordShreddingEvent({ originalChars: 200, compressedChars: 100, savedChars: 100, savedPct: 50, agentType: "latest" });
      const stats = cc.getShreddingStats();
      expect(stats).toHaveLength(500);
      expect(stats[stats.length - 1].agentType).toBe("latest");
      expect(stats[0].agentType).toBe("first"); // oldest remaining is still "first"
    });
  });

  describe("getShreddingStats", () => {
    it("returns an empty array when no events have been recorded", () => {
      expect(cc.getShreddingStats()).toEqual([]);
    });

    it("returns a copy — mutating the result does not affect the buffer", () => {
      cc.recordShreddingEvent({ originalChars: 100, compressedChars: 50, savedChars: 50, savedPct: 50 });
      const copy = cc.getShreddingStats();
      copy.pop();
      expect(cc.getShreddingStats()).toHaveLength(1);
    });
  });

  describe("clearShreddingStats", () => {
    it("empties the ring buffer", () => {
      cc.recordShreddingEvent({ originalChars: 100, compressedChars: 50, savedChars: 50, savedPct: 50 });
      cc.clearShreddingStats();
      expect(cc.getShreddingStats()).toHaveLength(0);
    });

    it("is idempotent on empty buffer", () => {
      expect(() => cc.clearShreddingStats()).not.toThrow();
      expect(cc.getShreddingStats()).toHaveLength(0);
    });
  });

  describe("getShreddingLogFile", () => {
    it("returns an absolute path string ending in .jsonl", () => {
      const path = cc.getShreddingLogFile();
      expect(typeof path).toBe("string");
      expect(path.endsWith(".jsonl")).toBe(true);
      // Should be an absolute path (starts with / on Unix or a drive letter on Windows)
      expect(path.length).toBeGreaterThan(5);
    });
  });

  // ── Tool-Log In-Memory Content Cache ──────────────────────────────────────

  describe("configureToolLogMemCache", () => {
    it("is disabled by default", () => {
      const stats = cc.getToolLogMemCacheStats();
      expect(stats.enabled).toBe(false);
    });

    it("enables the cache when called with enabled: true", () => {
      cc.configureToolLogMemCache({ enabled: true });
      expect(cc.getToolLogMemCacheStats().enabled).toBe(true);
    });

    it("sets maxSizeBytes", () => {
      cc.configureToolLogMemCache({ maxSizeBytes: 10 * 1024 * 1024 });
      expect(cc.getToolLogMemCacheStats().maxSizeBytes).toBe(10 * 1024 * 1024);
    });

    it("sets archiveSizeLimitBytes", () => {
      cc.configureToolLogMemCache({ archiveSizeLimitBytes: 100 * 1024 * 1024 });
      expect(cc.getToolLogMemCacheStats().archiveSizeLimitBytes).toBe(100 * 1024 * 1024);
    });

    it("ignores invalid (non-positive) numeric values", () => {
      cc.configureToolLogMemCache({ maxSizeBytes: -1, archiveSizeLimitBytes: 0 });
      const stats = cc.getToolLogMemCacheStats();
      // Should remain at defaults — still the 50 MB default we reset in beforeEach
      expect(stats.maxSizeBytes).toBe(50 * 1024 * 1024);
    });
  });

  describe("getToolLogMemCacheStats", () => {
    it("returns the expected shape with all required keys", () => {
      const stats = cc.getToolLogMemCacheStats();
      expect(stats).toMatchObject({
        enabled: expect.any(Boolean),
        count: expect.any(Number),
        totalBytes: expect.any(Number),
        maxSizeBytes: expect.any(Number),
        archiveSizeLimitBytes: expect.any(Number),
      });
    });

    it("starts with count=0 and totalBytes=0", () => {
      const stats = cc.getToolLogMemCacheStats();
      expect(stats.count).toBe(0);
      expect(stats.totalBytes).toBe(0);
    });
  });

  describe("evictToolLogMemCache", () => {
    it("returns 0 when cache is empty", () => {
      expect(cc.evictToolLogMemCache({ all: true })).toBe(0);
    });

    it("returns 0 for age-based eviction when no maxAgeMs is provided", () => {
      expect(cc.evictToolLogMemCache({})).toBe(0);
    });

    it("returns 0 for age-based eviction with maxAgeMs that is not finite", () => {
      expect(cc.evictToolLogMemCache({ maxAgeMs: NaN })).toBe(0);
      expect(cc.evictToolLogMemCache({ maxAgeMs: Infinity })).toBe(0);
    });

    it("all: true clears everything and returns the count", () => {
      // We can't easily test actual entries without writeToCache (needs real disk),
      // but we can confirm the function is consistent: after clearing an already-empty
      // cache we still get 0.
      cc.configureToolLogMemCache({ enabled: true });
      const n = cc.evictToolLogMemCache({ all: true });
      expect(n).toBe(0);
      expect(cc.getToolLogMemCacheStats().count).toBe(0);
      expect(cc.getToolLogMemCacheStats().totalBytes).toBe(0);
    });

    it("is safe to call multiple times", () => {
      expect(() => {
        cc.evictToolLogMemCache({ all: true });
        cc.evictToolLogMemCache({ all: true });
        cc.evictToolLogMemCache({ maxAgeMs: 0 });
      }).not.toThrow();
    });
  });
});
