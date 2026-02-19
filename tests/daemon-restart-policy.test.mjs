import { describe, expect, it } from "vitest";
import { createDaemonCrashTracker } from "../daemon-restart-policy.mjs";

describe("daemon-restart-policy", () => {
  it("counts instant crashes within the configured window", () => {
    const tracker = createDaemonCrashTracker({
      instantCrashWindowMs: 15000,
      maxInstantCrashes: 3,
    });

    tracker.markStart(1000);
    const first = tracker.recordExit(5000);
    expect(first.instantCrash).toBe(true);
    expect(first.instantCrashCount).toBe(1);
    expect(first.exceeded).toBe(false);

    tracker.markStart(6000);
    const second = tracker.recordExit(10000);
    expect(second.instantCrash).toBe(true);
    expect(second.instantCrashCount).toBe(2);
    expect(second.exceeded).toBe(false);

    tracker.markStart(11000);
    const third = tracker.recordExit(15000);
    expect(third.instantCrash).toBe(true);
    expect(third.instantCrashCount).toBe(3);
    expect(third.exceeded).toBe(true);
  });

  it("resets instant crash streak after a healthy run", () => {
    const tracker = createDaemonCrashTracker({
      instantCrashWindowMs: 15000,
      maxInstantCrashes: 3,
    });

    tracker.markStart(1000);
    tracker.recordExit(5000);

    tracker.markStart(6000);
    const healthy = tracker.recordExit(25000);
    expect(healthy.instantCrash).toBe(false);
    expect(healthy.instantCrashCount).toBe(0);

    tracker.markStart(26000);
    const freshCrash = tracker.recordExit(30000);
    expect(freshCrash.instantCrashCount).toBe(1);
    expect(freshCrash.exceeded).toBe(false);
  });

  it("supports explicit reset", () => {
    const tracker = createDaemonCrashTracker({
      instantCrashWindowMs: 15000,
      maxInstantCrashes: 2,
    });

    tracker.markStart(1000);
    tracker.recordExit(4000);

    tracker.reset();
    const state = tracker.getState();
    expect(state.instantCrashCount).toBe(0);
    expect(state.lastStartAtMs).toBe(0);
  });

  it("treats immediate 0ms exit as an instant crash", () => {
    const tracker = createDaemonCrashTracker({
      instantCrashWindowMs: 15000,
      maxInstantCrashes: 2,
    });

    tracker.markStart(1000);
    const first = tracker.recordExit(1000);
    expect(first.instantCrash).toBe(true);
    expect(first.instantCrashCount).toBe(1);

    tracker.markStart(2000);
    const second = tracker.recordExit(2000);
    expect(second.exceeded).toBe(true);
  });
});
