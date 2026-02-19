import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startAutoUpdateLoop, stopAutoUpdateLoop } from "../update-check.mjs";

describe("update-check", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Disable auto-update by default in tests
    process.env.OPENFLEET_SKIP_AUTO_UPDATE = "1";
  });

  afterEach(() => {
    process.env = originalEnv;
    stopAutoUpdateLoop();
    vi.restoreAllMocks();
  });

  describe("startAutoUpdateLoop", () => {
    it("should respect OPENFLEET_SKIP_AUTO_UPDATE=1", () => {
      process.env.OPENFLEET_SKIP_AUTO_UPDATE = "1";

      const consoleSpy = vi.spyOn(console, "log");
      startAutoUpdateLoop();

      expect(consoleSpy).toHaveBeenCalledWith(
        "[auto-update] Disabled via OPENFLEET_SKIP_AUTO_UPDATE=1"
      );
    });

    it("should track parent process by default", () => {
      delete process.env.OPENFLEET_SKIP_AUTO_UPDATE;

      const consoleSpy = vi.spyOn(console, "log");
      startAutoUpdateLoop({ intervalMs: 1000000 }); // Long interval to avoid actual polling

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[auto-update] Monitoring parent process PID")
      );

      stopAutoUpdateLoop();
    });

    it("should allow custom parentPid", () => {
      delete process.env.OPENFLEET_SKIP_AUTO_UPDATE;

      const consoleSpy = vi.spyOn(console, "log");
      const customPid = 12345;
      startAutoUpdateLoop({
        intervalMs: 1000000,
        parentPid: customPid
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        `[auto-update] Monitoring parent process PID ${customPid}`
      );

      stopAutoUpdateLoop();
    });

    it("should clean up intervals when stopped", () => {
      delete process.env.OPENFLEET_SKIP_AUTO_UPDATE;

      startAutoUpdateLoop({ intervalMs: 1000000 });
      stopAutoUpdateLoop();

      // If cleanup worked, calling stop again should be safe
      expect(() => stopAutoUpdateLoop()).not.toThrow();
    });
  });

  describe("parent process monitoring", () => {
    it("should set up parent monitoring interval", () => {
      delete process.env.OPENFLEET_SKIP_AUTO_UPDATE;

      // Use a non-existent PID (guaranteed to be dead)
      const deadPid = 999999;

      // Just verify that monitoring is set up (actual check happens periodically)
      const consoleSpy = vi.spyOn(console, "log");

      startAutoUpdateLoop({
        intervalMs: 100000,
        parentPid: deadPid,
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        `[auto-update] Monitoring parent process PID ${deadPid}`
      );

      stopAutoUpdateLoop();
    });
  });

  describe("cleanup handlers", () => {
    it("should register signal handlers on first call", () => {
      delete process.env.OPENFLEET_SKIP_AUTO_UPDATE;

      startAutoUpdateLoop({ intervalMs: 1000000 });

      // Should have signal handlers registered (at least 1 for each signal)
      expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount("SIGHUP")).toBeGreaterThanOrEqual(1);

      stopAutoUpdateLoop();
    });
  });
});
