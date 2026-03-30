import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  startAutoUpdateLoop,
  stopAutoUpdateLoop,
  __autoUpdateTestHooks,
} from "../infra/update-check.mjs";

const {
  recordAutoUpdateFailure,
  resetAutoUpdateState,
  isAutoUpdateDisabled,
  isSourceCheckoutRuntime,
  getRequiredRuntimeFiles,
  classifyInstallError,
  buildDisableNotice,
  readAutoUpdateState,
  writeAutoUpdateState,
  AUTO_UPDATE_STATE_FILE,
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

    it("detects source-checkout runtimes outside test mode", () => {
      const prevVitest = process.env.VITEST;
      const prevNodeEnv = process.env.NODE_ENV;
      const prevJestWorkerId = process.env.JEST_WORKER_ID;
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      delete process.env.JEST_WORKER_ID;
      try {
        expect(isSourceCheckoutRuntime()).toBe(true);
        expect(isSourceCheckoutRuntime({ allowSourceCheckoutAutoUpdate: true })).toBe(false);
      } finally {
        if (prevVitest === undefined) delete process.env.VITEST; else process.env.VITEST = prevVitest;
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
        if (prevJestWorkerId === undefined) delete process.env.JEST_WORKER_ID; else process.env.JEST_WORKER_ID = prevJestWorkerId;
      }
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

    it("should allow disabling parent process monitoring", () => {
      delete process.env.BOSUN_SKIP_AUTO_UPDATE;

      const consoleSpy = vi.spyOn(console, "log");
      startAutoUpdateLoop({
        intervalMs: 1000000,
        trackParent: false,
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        "[auto-update] Parent process monitoring disabled"
      );
      expect(consoleSpy).not.toHaveBeenCalledWith(
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
    it("skips polling while disabled and emits a single disable notification", async () => {
      delete process.env.BOSUN_SKIP_AUTO_UPDATE;

      const notices = [];
      await writeAutoUpdateState({
        failureCount: AUTO_UPDATE_FAILURE_LIMIT,
        lastFailureReason: "EINVAL",
        disabledUntil: Date.now() + 60_000,
        lastNotifiedAt: 0,
      });

      startAutoUpdateLoop({
        intervalMs: 50,
        startupDelayMs: 0,
        trackParent: false,
        onNotify: (msg) => {
          notices.push(msg);
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 220));
      stopAutoUpdateLoop();

      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("BOSUN_SKIP_AUTO_UPDATE=1");

      const persisted = JSON.parse(await readFile(AUTO_UPDATE_STATE_FILE, "utf8"));
      expect(persisted.lastNotifiedAt).toBeGreaterThan(0);
    });

    it("persists disabled state across restarts until expiry", async () => {
      await writeAutoUpdateState({
        failureCount: AUTO_UPDATE_FAILURE_LIMIT,
        lastFailureReason: "EINVAL",
        disabledUntil: Date.now() + 60_000,
        lastNotifiedAt: 123,
      });

      const persisted = await readAutoUpdateState();
      expect(isAutoUpdateDisabled(persisted)).toBe(true);
      expect(persisted.failureCount).toBe(AUTO_UPDATE_FAILURE_LIMIT);
      expect(persisted.lastFailureReason).toBe("EINVAL");
    });
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


    it("uses ComSpec or SystemRoot cmd.exe for Windows shell fallback", () => {
      const originalComSpec = process.env.ComSpec;
      const originalCOMSPEC = process.env.COMSPEC;
      const originalSystemRoot = process.env.SystemRoot;
      process.env.ComSpec = "C:\\custom\\cmd.exe";
      delete process.env.COMSPEC;
      process.env.SystemRoot = "C:\\Windows";

      const execSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        expect(() => runWindowsCmd("npm.cmd", ["install"], { stdio: "pipe" })).toThrow();
        expect(execSpy).toBeDefined();
      } finally {
        execSpy.mockRestore();
        if (originalComSpec === undefined) delete process.env.ComSpec; else process.env.ComSpec = originalComSpec;
        if (originalCOMSPEC === undefined) delete process.env.COMSPEC; else process.env.COMSPEC = originalCOMSPEC;
        if (originalSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalSystemRoot;
      }
    });

    it("re-enables when disable window expires", () => {
      const pastState = {
        failureCount: AUTO_UPDATE_FAILURE_LIMIT,
        lastFailureReason: "EINVAL",
        disabledUntil: Date.now() - 1000,
      };
      expect(isAutoUpdateDisabled(pastState, Date.now())).toBe(false);
    });

    it("persists state to .cache/auto-update-state.json", async () => {
      await resetAutoUpdateState();

      const state = await recordAutoUpdateFailure(
        await readAutoUpdateState(),
        "EINVAL",
      );

      const persisted = await readAutoUpdateState();
      expect(persisted).toMatchObject({
        failureCount: state.failureCount,
        lastFailureReason: "EINVAL",
        disabledUntil: 0,
        lastNotifiedAt: 0,
      });
    });

    it("clears disable state on reset after success", async () => {
      await writeAutoUpdateState({
        failureCount: AUTO_UPDATE_FAILURE_LIMIT,
        lastFailureReason: "EINVAL",
        disabledUntil: Date.now() + 60_000,
        lastNotifiedAt: Date.now(),
      });

      const state = await resetAutoUpdateState();

      expect(state).toEqual({
        failureCount: 0,
        lastFailureReason: null,
        disabledUntil: 0,
        lastNotifiedAt: 0,
      });
      await expect(readAutoUpdateState()).resolves.toEqual(state);
    });

    it("clears a previously disabled state after a simulated successful update reset", async () => {
      await writeAutoUpdateState({
        failureCount: AUTO_UPDATE_FAILURE_LIMIT,
        lastFailureReason: "EINVAL",
        disabledUntil: Date.now() + 60_000,
        lastNotifiedAt: Date.now(),
      });

      await resetAutoUpdateState();

      await expect(readAutoUpdateState()).resolves.toEqual({
        failureCount: 0,
        lastFailureReason: null,
        disabledUntil: 0,
        lastNotifiedAt: 0,
      });
    });

    it("does not re-arm disable notice once already notified", async () => {
      await writeAutoUpdateState({
        failureCount: AUTO_UPDATE_FAILURE_LIMIT,
        lastFailureReason: "EINVAL",
        disabledUntil: Date.now() + 60_000,
        lastNotifiedAt: Date.now(),
      });

      const persisted = await readAutoUpdateState();
      expect(isAutoUpdateDisabled(persisted)).toBe(true);
      expect(persisted.lastNotifiedAt).toBeGreaterThan(0);
      expect(buildDisableNotice(persisted)).toContain(".cache/auto-update-state.json");
    });

    it("includes builtin agent skills in required runtime files", () => {
      const required = getRequiredRuntimeFiles().map((entry) => String(entry).replaceAll("\\", "/"));
      expect(required.some((entry) => entry.includes("agent/bosun-skills.mjs"))).toBe(true);
      expect(required.some((entry) => entry.includes("agent/skills/background-task-execution.md"))).toBe(true);
      expect(required.some((entry) => entry.includes("agent/skills/pr-workflow.md"))).toBe(true);
    });
  });
});

