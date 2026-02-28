import { describe, it, expect, vi } from "vitest";
import { PRCleanupDaemon } from "../pr-cleanup-daemon.mjs";

describe("PRCleanupDaemon.resolveConflicts", () => {
  it("uses SDK resolver first and succeeds when PR becomes mergeable", async () => {
    const daemon = new PRCleanupDaemon({
      dryRun: false,
      maxConflictSize: 500,
      postConflictRecheckAttempts: 1,
      postConflictRecheckDelayMs: 1,
    });

    daemon.getConflictSize = vi.fn().mockResolvedValue(20);
    daemon.spawnCodexAgent = vi.fn().mockResolvedValue({
      success: true,
    });
    daemon.resolveConflictsLocally = vi.fn();
    daemon.waitForMergeableState = vi
      .fn()
      .mockResolvedValue({ mergeable: "MERGEABLE" });
    daemon.escalate = vi.fn();

    const ok = await daemon.resolveConflicts({
      number: 42,
      title: "conflict test",
      headRefName: "ve/test-conflict",
      baseRefName: "main",
    });

    expect(ok).toBe(true);
    expect(daemon.spawnCodexAgent).toHaveBeenCalledTimes(1);
    expect(daemon.resolveConflictsLocally).not.toHaveBeenCalled();
    expect(daemon.stats.conflictsResolved).toBe(1);
    expect(daemon.escalate).not.toHaveBeenCalled();
  });

  it("falls back to local resolution when SDK resolver fails", async () => {
    const daemon = new PRCleanupDaemon({
      dryRun: false,
      maxConflictSize: 500,
      postConflictRecheckAttempts: 1,
      postConflictRecheckDelayMs: 1,
    });

    daemon.getConflictSize = vi.fn().mockResolvedValue(20);
    daemon.spawnCodexAgent = vi
      .fn()
      .mockRejectedValue(new Error("sdk unavailable"));
    daemon.resolveConflictsLocally = vi.fn().mockResolvedValue(undefined);
    daemon.waitForMergeableState = vi
      .fn()
      .mockResolvedValue({ mergeable: "MERGEABLE" });
    daemon.escalate = vi.fn();

    const ok = await daemon.resolveConflicts({
      number: 7,
      title: "fallback test",
      headRefName: "ve/fallback",
      baseRefName: "main",
    });

    expect(ok).toBe(true);
    expect(daemon.spawnCodexAgent).toHaveBeenCalledTimes(1);
    expect(daemon.resolveConflictsLocally).toHaveBeenCalledTimes(1);
    expect(daemon.stats.conflictsResolved).toBe(1);
    expect(daemon.escalate).not.toHaveBeenCalled();
  });

  it("escalates immediately when conflict size is above threshold", async () => {
    const daemon = new PRCleanupDaemon({
      dryRun: false,
      maxConflictSize: 100,
    });

    daemon.getConflictSize = vi.fn().mockResolvedValue(101);
    daemon.spawnCodexAgent = vi.fn();
    daemon.resolveConflictsLocally = vi.fn();
    daemon.waitForMergeableState = vi.fn();
    daemon.escalate = vi.fn().mockResolvedValue(true);

    const ok = await daemon.resolveConflicts({
      number: 99,
      title: "too large",
      headRefName: "ve/large",
      baseRefName: "main",
    });

    expect(ok).toBe(false);
    expect(daemon.spawnCodexAgent).not.toHaveBeenCalled();
    expect(daemon.resolveConflictsLocally).not.toHaveBeenCalled();
    expect(daemon.escalate).toHaveBeenCalledTimes(1);
    expect(daemon.stats.escalations).toBe(1);
  });

  it("does not increment escalations counter when duplicate escalation is suppressed", async () => {
    vi.useFakeTimers();
    const daemon = new PRCleanupDaemon({
      dryRun: false,
      maxConflictSize: 100,
      escalationThrottleMs: 60_000,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    daemon.getConflictSize = vi.fn().mockResolvedValue(101);
    daemon.spawnCodexAgent = vi.fn();
    daemon.resolveConflictsLocally = vi.fn();
    daemon.waitForMergeableState = vi.fn();

    const pr = {
      number: 1001,
      title: "duplicate escalation accounting",
      headRefName: "ve/dup-accounting",
      baseRefName: "main",
    };

    await daemon.resolveConflicts(pr);
    await daemon.resolveConflicts(pr);

    expect(daemon.stats.escalations).toBe(1);
    expect(daemon.stats.escalationsSuppressed).toBe(1);

    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("PRCleanupDaemon.getBaseBranch", () => {
  it("uses PR baseRefName and strips origin/ prefix", () => {
    const daemon = new PRCleanupDaemon();
    expect(daemon.getBaseBranch({ baseRefName: "origin/mainnet/main" })).toBe(
      "mainnet/main",
    );
    expect(daemon.getBaseBranch({ baseRefName: "develop" })).toBe("develop");
  });

  it("falls back to main when baseRefName is missing", () => {
    const daemon = new PRCleanupDaemon();
    expect(daemon.getBaseBranch({})).toBe("main");
  });
});

describe("PRCleanupDaemon auto-merge gate", () => {
  it("skips green-PR merge scan when autoMerge is disabled", async () => {
    const daemon = new PRCleanupDaemon({ autoMerge: false });
    daemon.fetchProblematicPRs = vi.fn().mockResolvedValue([]);
    daemon.mergeGreenPRs = vi.fn();

    await daemon.run();

    expect(daemon.mergeGreenPRs).not.toHaveBeenCalled();
  });
});

describe("PRCleanupDaemon reliability guards", () => {
  it("builds CI re-trigger commit command with signing disabled", () => {
    const daemon = new PRCleanupDaemon();
    expect(daemon.buildCiRetriggerCommitCommand()).toBe(
      'git -c commit.gpgsign=false commit --allow-empty --no-verify -m "chore: re-trigger CI"',
    );
  });

  it("handles start() run rejections without unhandled promise failures", async () => {
    vi.useFakeTimers();
    const daemon = new PRCleanupDaemon({ intervalMs: 25 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    daemon.run = vi.fn().mockRejectedValue(new Error("boom"));

    daemon.start();
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledWith(
      "[pr-cleanup-daemon] Immediate run failed:",
      "boom",
    );

    vi.advanceTimersByTime(30);
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledWith(
      "[pr-cleanup-daemon] Interval run failed:",
      "boom",
    );

    daemon.stop();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("suppresses duplicate escalations for the same PR+reason within throttle window", async () => {
    vi.useFakeTimers();
    const daemon = new PRCleanupDaemon({ escalationThrottleMs: 60_000 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const pr = { number: 83, title: "CI flake loop" };
    await daemon.escalate(pr, "large_conflict", { lines: 999 });
    await daemon.escalate(pr, "large_conflict", { lines: 999 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "[pr-cleanup-daemon] Escalation suppressed for PR #83 (large_conflict)",
    );
    expect(daemon.stats.escalationsSuppressed).toBe(1);

    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does not suppress escalation when reason differs for same PR", async () => {
    const daemon = new PRCleanupDaemon({ escalationThrottleMs: 60_000 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pr = { number: 83, title: "CI flake loop" };
    await daemon.escalate(pr, "large_conflict", { lines: 999 });
    await daemon.escalate(pr, "conflict_resolution_failed", { error: "merge abort" });

    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
