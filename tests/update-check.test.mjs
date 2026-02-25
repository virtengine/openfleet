import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startAutoUpdateLoop,
  stopAutoUpdateLoop,
  __autoUpdateTestHooks,
} from "../update-check.mjs";

const {
  recordAutoUpdateFailure,
  resetAutoUpdateState,
  isAutoUpdateDisabled,
  classifyInstallError,
  buildDisableNotice,
  readAutoUpdateState,
  writeAutoUpdateState,
  AUTO_UPDATE_DISABLE_WINDOW_MS,
  AUTO_UPDATE_FAILURE_LIMIT,
} = __autoUpdateTestHooks;

describe("update-check", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Disable auto-update by default in tests
    process.env.BOSUN_SKIP_AUTO_UPDATE = "1";
  });

  afterEach(() => {
    process.env = originalEnv;
    stopAutoUpdateLoop();
    vi.restoreAllMocks();
  });

  describe("startAutoUpdateLoop", () => {
    it("should respect BOSUN_SKIP_AUTO_UPDATE=1", () => {
      process.env.BOSUN_SKIP_AUTO_UPDATE = "1";

      const consoleSpy = vi.spyOn(console, "log");
      startAutoUpdateLoop();

      expect(consoleSpy).toHaveBeenCalledWith(
        "[auto-update] Disabled via BOSUN_SKIP_AUTO_UPDATE=1"
      );
    });

    it("should track parent process by default", () => {
      delete process.env.BOSUN_SKIP_AUTO_UPDATE;

      const consoleSpy = vi.spyOn(console, "log");
      startAutoUpdateLoop({ intervalMs: 1000000 }); // Long interval to avoid actual polling

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[auto-update] Monitoring parent process PID")
      );

      stopAutoUpdateLoop();
    });

    it("should allow custom parentPid", () => {
      delete process.env.BOSUN_SKIP_AUTO_UPDATE;

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
      delete process.env.BOSUN_SKIP_AUTO_UPDATE;

      startAutoUpdateLoop({ intervalMs: 1000000 });
      stopAutoUpdateLoop();

      // If cleanup worked, calling stop again should be safe
      expect(() => stopAutoUpdateLoop()).not.toThrow();
    });
  });

  describe("parent process monitoring", () => {
    it("should set up parent monitoring interval", () => {
      delete process.env.BOSUN_SKIP_AUTO_UPDATE;

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
      delete process.env.BOSUN_SKIP_AUTO_UPDATE;

      startAutoUpdateLoop({ intervalMs: 1000000 });

      // Should have signal handlers registered (at least 1 for each signal)
      expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount("SIGHUP")).toBeGreaterThanOrEqual(1);

      stopAutoUpdateLoop();
    });
  });

  describe("circuit breaker", () => {
    it("disables after consecutive failures and records reason", async () => {
      await resetAutoUpdateState();
      let state = await resetAutoUpdateState();

      for (let i = 0; i < AUTO_UPDATE_FAILURE_LIMIT; i += 1) {
        state = await recordAutoUpdateFailure(state, "EINVAL");
      }

      expect(state.failureCount).toBe(AUTO_UPDATE_FAILURE_LIMIT);
      expect(state.lastFailureReason).toBe("EINVAL");
      expect(state.disabledUntil).toBeGreaterThan(Date.now());
      expect(isAutoUpdateDisabled(state)).toBe(true);

      const notice = buildDisableNotice(state);
      expect(notice).toContain("BOSUN_SKIP_AUTO_UPDATE=1");
      expect(notice).toContain(`${AUTO_UPDATE_DISABLE_WINDOW_MS / 1000 / 60 / 60}`);
    });

    it("classifies install errors with EINVAL precedence", () => {
      expect(classifyInstallError({ code: "EINVAL" })).toBe("EINVAL");
      expect(classifyInstallError({ message: "boom EINVAL oops" })).toBe("EINVAL");
      expect(classifyInstallError({ code: "EACCESS", message: "fail" })).toBe("EACCESS");
      expect(classifyInstallError({ code: "NPM_LAUNCH_FAILED" })).toBe("NPM_LAUNCH_FAILED");
      expect(classifyInstallError({ message: "request timed out after 180000ms" })).toBe("ETIMEDOUT");
      expect(classifyInstallError({ status: 1 })).toBe("EXIT_1");
    });

    it("persists disable notice timestamp even if notify callback throws", async () => {
      delete process.env.BOSUN_SKIP_AUTO_UPDATE;
      await writeAutoUpdateState({
        failureCount: AUTO_UPDATE_FAILURE_LIMIT,
        lastFailureReason: "EINVAL",
        disabledUntil: Date.now() + 60_000,
        lastNotifiedAt: 0,
      });

      const warnSpy = vi.spyOn(console, "warn");
      startAutoUpdateLoop({
        intervalMs: 1000000,
        startupDelayMs: 0,
        parentPid: process.pid,
        onNotify: () => {
          throw new Error("notify failed");
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      stopAutoUpdateLoop();

      const state = await readAutoUpdateState();
      expect(state.lastNotifiedAt).toBeGreaterThan(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[auto-update] notify callback failed"),
      );
    });

    it("re-enables when disable window expires", () => {
      const pastState = {
        failureCount: AUTO_UPDATE_FAILURE_LIMIT,
        lastFailureReason: "EINVAL",
        disabledUntil: Date.now() - 1000,
      };
      expect(isAutoUpdateDisabled(pastState, Date.now())).toBe(false);
    });
  });
});
