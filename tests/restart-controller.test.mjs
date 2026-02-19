import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestartController } from "../restart-controller.mjs";

describe("RestartController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks mutexHeldDetected when log line contains mutex message", () => {
    const controller = new RestartController();

    controller.noteLogLine("Another orchestrator instance is already running");

    expect(controller.mutexHeldDetected).toBe(true);
  });

  it("escalates mutex backoff up to the cap", () => {
    const controller = new RestartController();

    controller.noteProcessStarted(Date.now());
    vi.advanceTimersByTime(1000);
    controller.recordExit(Date.now() - controller.lastProcessStartAt, true);
    expect(controller.getRestartDelay()).toBe(30_000);

    controller.noteProcessStarted(Date.now());
    vi.advanceTimersByTime(1000);
    controller.recordExit(Date.now() - controller.lastProcessStartAt, true);
    expect(controller.getRestartDelay()).toBe(60_000);

    controller.noteProcessStarted(Date.now());
    vi.advanceTimersByTime(1000);
    controller.recordExit(Date.now() - controller.lastProcessStartAt, true);
    expect(controller.getRestartDelay()).toBe(90_000);

    controller.noteProcessStarted(Date.now());
    vi.advanceTimersByTime(1000);
    controller.recordExit(Date.now() - controller.lastProcessStartAt, true);
    expect(controller.getRestartDelay()).toBe(90_000);
  });

  it("enforces a minimum restart interval of 15s", () => {
    const controller = new RestartController();

    controller.noteProcessStarted(Date.now());
    vi.advanceTimersByTime(5000);

    expect(controller.getMinRestartDelay(Date.now())).toBe(10_000);

    vi.advanceTimersByTime(10_000);
    expect(controller.getMinRestartDelay(Date.now())).toBe(0);
  });

  it("suppresses file-change restarts during mutex backoff", () => {
    const controller = new RestartController();

    controller.recordExit(1000, true);

    expect(controller.shouldSuppressRestart("file-change")).toBe(true);
    expect(controller.shouldSuppressRestart("manual")).toBe(false);
  });

  it("resets backoff after a healthy run", () => {
    const controller = new RestartController();

    controller.recordExit(1000, true);
    expect(controller.mutexBackoffMs).toBe(30_000);

    const result = controller.recordExit(21_000, false);

    expect(controller.mutexBackoffMs).toBe(0);
    expect(controller.consecutiveQuickExits).toBe(0);
    expect(result.backoffReset).toBe(true);
  });

  it("tracks consecutive quick exits", () => {
    const controller = new RestartController();

    controller.recordExit(1000, false);
    controller.recordExit(1500, false);

    expect(controller.consecutiveQuickExits).toBe(2);

    controller.recordExit(25_000, false);

    expect(controller.consecutiveQuickExits).toBe(0);
  });
});
