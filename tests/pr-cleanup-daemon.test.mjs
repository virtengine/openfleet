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
    daemon.escalate = vi.fn().mockResolvedValue(undefined);

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
