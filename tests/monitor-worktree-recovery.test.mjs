import { describe, expect, it } from "vitest";
import { buildNextWorktreeRecoveryState } from "../infra/worktree-recovery-state.mjs";

describe("worktree recovery state", () => {
  it("marks healed poisoned worktrees as recovered and records the event", () => {
    const next = buildNextWorktreeRecoveryState(null, {
      outcome: "recreated",
      reason: "poisoned_worktree",
      branch: "task/healed-worktree",
      taskId: "task-healed-1",
      worktreePath: "/tmp/healed-worktree",
      detectedIssues: ["missing_git_metadata"],
      timestamp: "2026-03-22T01:02:03.000Z",
    });

    expect(next).toMatchObject({
      health: "recovered",
      failureStreak: 0,
      successCount: 1,
    });
    expect(next.recentEvents[0]).toMatchObject({
      outcome: "recreated",
      reason: "poisoned_worktree",
      branch: "task/healed-worktree",
      taskId: "task-healed-1",
    });
  });

  it("keeps repeated failures distinct from a one-time healed incident", () => {
    let next = buildNextWorktreeRecoveryState(null, {
      outcome: "recreation_failed",
      reason: "poisoned_worktree",
      branch: "task/failing-worktree",
      taskId: "task-failing-1",
      error: "refresh conflict",
      timestamp: "2026-03-22T01:02:03.000Z",
    });
    next = buildNextWorktreeRecoveryState(next, {
      outcome: "recreation_failed",
      reason: "poisoned_worktree",
      branch: "task/failing-worktree",
      taskId: "task-failing-1",
      error: "refresh conflict",
      timestamp: "2026-03-22T01:03:03.000Z",
    });

    expect(next).toMatchObject({
      health: "degraded",
      failureStreak: 2,
      failureCount: 2,
    });
    expect(next.recentEvents).toHaveLength(2);
    expect(next.recentEvents[0].outcome).toBe("recreation_failed");
  });

  it("does not add recovery noise for healthy no-op checks", () => {
    const next = buildNextWorktreeRecoveryState(null, {
      outcome: "healthy_noop",
      branch: "task/healthy-worktree",
      taskId: "task-healthy-1",
      worktreePath: "/tmp/healthy-worktree",
      timestamp: "2026-03-22T01:02:03.000Z",
    });

    expect(next).toMatchObject({
      health: "healthy",
      failureStreak: 0,
      failureCount: 0,
      successCount: 0,
    });
    expect(next.recentEvents).toEqual([]);
  });
});
