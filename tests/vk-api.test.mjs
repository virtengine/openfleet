import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Force VK backend so fetchVk() doesn't short-circuit when config says "github"
process.env.KANBAN_BACKEND = "vk";

// Mock fetch globally before importing monitor
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock console methods to avoid noise in test output
const mockConsoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
const mockConsoleError = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});

// Import monitor once at module level
const monitor = await import("../monitor.mjs");
const {
  fetchVk,
  updateTaskStatus,
  getTaskAgeMs,
  safeRecoverTask,
  recoverySkipCache,
} = monitor;

describe("fetchVk", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    mockConsoleWarn.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe("successful requests", () => {
    it("should make successful GET request with JSON response", async () => {
      const mockData = { tasks: [{ id: 1, title: "Test" }] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => mockData,
      });

      const result = await fetchVk("/api/tasks");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/tasks"),
        expect.objectContaining({
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(result).toEqual(mockData);
    });

    it("should make successful POST request with body", async () => {
      const requestBody = { status: "in_progress" };
      const mockResponse = { success: true };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => mockResponse,
      });

      const result = await fetchVk("/api/tasks/123", {
        method: "POST",
        body: requestBody,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/tasks/123"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(requestBody),
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it("should make successful PUT request (not PATCH)", async () => {
      const requestBody = { status: "completed" };
      const mockResponse = { success: true };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => mockResponse,
      });

      const result = await fetchVk("/api/tasks/456", {
        method: "PUT",
        body: requestBody,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/tasks/456"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(requestBody),
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it("should handle path without leading slash", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({}),
      });

      await fetchVk("api/tasks");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/tasks"),
        expect.any(Object),
      );
    });

    it("should use custom timeout when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({}),
      });

      await fetchVk("/api/tasks", { timeoutMs: 5000 });

      const call = mockFetch.mock.calls[0];
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("error handling", () => {
    it("should return null on 4xx status code", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      });

      const result = await fetchVk("/api/tasks/999");

      expect(result).toBeNull();
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("404"),
      );
    });

    it("should return null on 5xx status code", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const result = await fetchVk("/api/tasks");

      expect(result).toBeNull();
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("500"),
      );
    });

    it("should handle non-JSON response (HTML error page)", async () => {
      const htmlResponse = "<html><body><h1>404 Not Found</h1></body></html>";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: async () => htmlResponse,
      });

      const result = await fetchVk("/api/tasks");

      expect(result).toBeNull();
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("non-JSON response"),
      );
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("text/html"),
      );
    });

    it("should handle empty content-type as non-JSON", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: async () => "plain text response",
      });

      const result = await fetchVk("/api/tasks");

      expect(result).toBeNull();
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("non-JSON response"),
      );
    });

    it("should handle timeout/abort", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      mockFetch.mockRejectedValueOnce(abortError);

      const result = await fetchVk("/api/tasks", { timeoutMs: 100 });

      expect(result).toBeNull();
      // Abort errors are intentionally silenced (not logged)
      expect(mockConsoleWarn).not.toHaveBeenCalled();
    });

    it("should handle network errors", async () => {
      const networkError = new Error("Network request failed");
      mockFetch.mockRejectedValueOnce(networkError);

      const result = await fetchVk("/api/tasks");

      expect(result).toBeNull();
      expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it("should handle JSON parse errors in response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => {
          throw new Error("Invalid JSON");
        },
      });

      const result = await fetchVk("/api/tasks");

      expect(result).toBeNull();
      expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it("should truncate long error messages in logs", async () => {
      const longText = "A".repeat(500);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => longText,
      });

      await fetchVk("/api/tasks");

      // fetchVk truncates the response text to 200 chars via .slice(0, 200)
      const expectedTruncated = "A".repeat(200);
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        expect.stringContaining(expectedTruncated),
      );
      // Full 500-char text should NOT appear in the log
      expect(mockConsoleWarn).not.toHaveBeenCalledWith(
        expect.stringContaining(longText),
      );
    });
  });

  describe("request validation", () => {
    it("should not include body in GET requests", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({}),
      });

      await fetchVk("/api/tasks", {
        method: "GET",
        body: { should: "be ignored" },
      });

      const call = mockFetch.mock.calls[0];
      expect(call[1].body).toBeUndefined();
    });

    it("should uppercase method names", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({}),
      });

      await fetchVk("/api/tasks", { method: "post" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("should always set Content-Type header to application/json", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({}),
      });

      await fetchVk("/api/tasks");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
  });
});

describe("updateTaskStatus", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    mockConsoleWarn.mockClear();
  });

  it("should update task status successfully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true }),
    });

    const result = await updateTaskStatus(123, "completed");

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/tasks/123"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ status: "completed" }),
      }),
    );
  });

  it("should use PUT method not PATCH", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true }),
    });

    await updateTaskStatus(456, "in_progress");

    const call = mockFetch.mock.calls[0];
    expect(call[1].method).toBe("PUT");
    expect(call[1].method).not.toBe("PATCH");
  });

  it("should return false when API returns success: false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: false, error: "Invalid status" }),
    });

    const result = await updateTaskStatus(789, "invalid_status");

    expect(result).toBe(false);
  });

  it("should return false when fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Server Error",
    });

    const result = await updateTaskStatus(999, "completed");

    expect(result).toBe(false);
  });

  it("should return false when network error occurs", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await updateTaskStatus(111, "completed");

    expect(result).toBe(false);
  });

  it("should handle various status values", async () => {
    const statuses = ["pending", "in_progress", "completed", "failed"];

    for (const status of statuses) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({ success: true }),
      });

      const result = await updateTaskStatus(1, status);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ status }),
        }),
      );
    }
  });

  it("should use 10 second timeout", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true }),
    });

    await updateTaskStatus(123, "completed");

    const call = mockFetch.mock.calls[0];
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("should send correct request body structure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true }),
    });

    await updateTaskStatus(123, "completed");

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);

    expect(body).toEqual({ status: "completed" });
    expect(Object.keys(body)).toHaveLength(1);
  });
});

describe("VK API integration scenarios", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    mockConsoleWarn.mockClear();
  });

  it("should handle task status update failure with retry", async () => {
    // First attempt fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    const firstResult = await updateTaskStatus(123, "completed");
    expect(firstResult).toBe(false);

    // Second attempt succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true }),
    });

    const secondResult = await updateTaskStatus(123, "completed");
    expect(secondResult).toBe(true);
  });

  it("should handle VK returning HTML error page instead of JSON", async () => {
    const htmlError = `
      <!DOCTYPE html>
      <html>
        <head><title>502 Bad Gateway</title></head>
        <body>
          <h1>502 Bad Gateway</h1>
          <p>nginx/1.18.0</p>
        </body>
      </html>
    `;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "text/html; charset=utf-8"]]),
      text: async () => htmlError,
    });

    const result = await fetchVk("/api/tasks");

    expect(result).toBeNull();
    expect(mockConsoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("non-JSON response"),
    );
    expect(mockConsoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("text/html"),
    );
  });

  it("should handle concurrent status updates", async () => {
    const taskIds = [1, 2, 3, 4, 5];

    // Mock all responses
    taskIds.forEach(() => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({ success: true }),
      });
    });

    const results = await Promise.all(
      taskIds.map((id) => updateTaskStatus(id, "completed")),
    );

    expect(results).toEqual([true, true, true, true, true]);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("should handle API returning malformed success response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ ok: true }), // Wrong field name
    });

    const result = await updateTaskStatus(123, "completed");

    expect(result).toBe(false); // success !== true
  });

  it("should validate request body is properly JSON-stringified", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true }),
    });

    await updateTaskStatus(123, "completed");

    const call = mockFetch.mock.calls[0];
    const body = call[1].body;

    // Should be a string, not an object
    expect(typeof body).toBe("string");

    // Should be valid JSON
    expect(() => JSON.parse(body)).not.toThrow();

    // Should match expected structure
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ status: "completed" });
  });

  it("should handle response with wrong content-type but valid JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => '{"success": true}',
    });

    const result = await fetchVk("/api/tasks/123");

    expect(result).toEqual({ success: true });
    expect(mockConsoleWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("non-JSON response"),
    );
  });
});

describe("getTaskAgeMs", () => {
  it("returns age from updated_at", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const age = getTaskAgeMs({
      updated_at: twoHoursAgo,
      created_at: "2020-01-01T00:00:00Z",
    });
    // Should be approximately 2 hours (within 5s tolerance)
    expect(age).toBeGreaterThan(2 * 60 * 60 * 1000 - 5000);
    expect(age).toBeLessThan(2 * 60 * 60 * 1000 + 5000);
  });

  it("falls back to created_at when updated_at is missing", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const age = getTaskAgeMs({ created_at: oneHourAgo });
    expect(age).toBeGreaterThan(60 * 60 * 1000 - 5000);
    expect(age).toBeLessThan(60 * 60 * 1000 + 5000);
  });

  it("returns 0 for null/undefined task", () => {
    expect(getTaskAgeMs(null)).toBe(0);
    expect(getTaskAgeMs(undefined)).toBe(0);
  });

  it("returns 0 when no timestamps", () => {
    expect(getTaskAgeMs({})).toBe(0);
    expect(getTaskAgeMs({ title: "test" })).toBe(0);
  });

  it("returns 0 for invalid date strings", () => {
    expect(getTaskAgeMs({ updated_at: "not-a-date" })).toBe(0);
  });

  it("returns 0 for future timestamps", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(getTaskAgeMs({ updated_at: future })).toBe(0);
  });
});

describe("safeRecoverTask + recoverySkipCache", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    mockConsoleWarn.mockClear();
    mockConsoleError.mockClear();
    recoverySkipCache.clear();
  });

  it("caches task as skipped when live status is already todo", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ data: { status: "todo" } }),
    });

    const result = await safeRecoverTask("task-1", "Test Task", "stale");
    expect(result).toBe(false);
    expect(recoverySkipCache.has("task-1")).toBe(true);
    expect(recoverySkipCache.get("task-1").resolvedStatus).toBe("todo");
  });

  it("caches task as skipped when live status is cancelled", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ data: { status: "cancelled" } }),
    });

    const result = await safeRecoverTask("task-2", "Cancelled Task", "stale");
    expect(result).toBe(false);
    expect(recoverySkipCache.has("task-2")).toBe(true);
    expect(recoverySkipCache.get("task-2").resolvedStatus).toBe("cancelled");
  });

  it("caches task as skipped when live status is done", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ data: { status: "done" } }),
    });

    const result = await safeRecoverTask("task-3", "Done Task", "stale");
    expect(result).toBe(false);
    expect(recoverySkipCache.has("task-3")).toBe(true);
    expect(recoverySkipCache.get("task-3").resolvedStatus).toBe("done");
  });

  it("does NOT cache when task is successfully recovered (moved to todo)", async () => {
    // First call: safeRecoverTask fetches live status = inprogress
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ data: { status: "inprogress" } }),
    });
    // Second call: updateTaskStatus PUT
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true }),
    });

    const result = await safeRecoverTask("task-4", "Active Task", "stale");
    expect(result).toBe(true);
    // Should NOT be in cache — task was moved, so it needs re-evaluation
    expect(recoverySkipCache.has("task-4")).toBe(false);
  });

  it("caches fetch-failed with backoff when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const result = await safeRecoverTask("task-5", "Failing Task", "stale");
    expect(result).toBe(false);
    // Implementation now caches fetch failures for backoff (5 min TTL)
    expect(recoverySkipCache.has("task-5")).toBe(true);
    expect(recoverySkipCache.get("task-5").resolvedStatus).toBe("fetch-failed");
  });

  it("updateTaskStatus clears recoverySkipCache on success", async () => {
    // Pre-populate cache
    recoverySkipCache.set("task-clear", {
      resolvedStatus: "todo",
      timestamp: Date.now(),
    });
    expect(recoverySkipCache.has("task-clear")).toBe(true);

    // Successful updateTaskStatus should clear it
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true }),
    });
    await updateTaskStatus("task-clear", "inprogress");
    expect(recoverySkipCache.has("task-clear")).toBe(false);
  });

  it("updateTaskStatus does NOT clear cache on failure", async () => {
    recoverySkipCache.set("task-keep", {
      resolvedStatus: "cancelled",
      timestamp: Date.now(),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: false }),
    });
    await updateTaskStatus("task-keep", "todo");
    // Should still be in cache since update failed
    expect(recoverySkipCache.has("task-keep")).toBe(true);
  });

  it("cache entries have timestamps for TTL expiry", async () => {
    const before = Date.now();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ data: { status: "todo" } }),
    });

    await safeRecoverTask("task-ts", "Timestamped", "check");
    const entry = recoverySkipCache.get("task-ts");
    expect(entry).toBeDefined();
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
  });
});
