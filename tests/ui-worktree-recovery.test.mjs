import { describe, expect, it } from "vitest";
import {
  buildWorktreeRecoveryViewModel,
  normalizeWorktreeRecoveryState,
} from "../ui/modules/worktree-recovery.js";

describe("worktree recovery ui model", () => {
  it("renders a healthy state without recovery noise", () => {
    const state = normalizeWorktreeRecoveryState(null);
    const model = buildWorktreeRecoveryViewModel(state);

    expect(model).toMatchObject({
      health: "healthy",
      headline: "Managed worktrees healthy",
      tone: "success",
    });
    expect(model.events).toEqual([]);
  });

  it("surfaces healed recreations for operator diagnostics", () => {
    const model = buildWorktreeRecoveryViewModel({
      health: "recovered",
      failureStreak: 0,
      recentEvents: [{
        outcome: "recreated",
        reason: "poisoned_worktree",
        branch: "task/healed-worktree",
        taskId: "task-healed-1",
        detectedIssues: ["missing_git_metadata"],
        timestamp: "2026-03-22T01:02:03.000Z",
      }],
    });

    expect(model).toMatchObject({
      health: "recovered",
      tone: "warning",
    });
    expect(model.events[0].title).toContain("Recreated");
    expect(model.events[0].detail).toContain("task/healed-worktree");
  });

  it("elevates repeated failures above one-off incidents", () => {
    const model = buildWorktreeRecoveryViewModel({
      health: "degraded",
      failureStreak: 3,
      recentEvents: [{
        outcome: "recreation_failed",
        reason: "poisoned_worktree",
        branch: "task/failing-worktree",
        taskId: "task-failing-1",
        error: "refresh conflict",
        timestamp: "2026-03-22T01:02:03.000Z",
      }],
    });

    expect(model).toMatchObject({
      health: "degraded",
      tone: "error",
    });
    expect(model.summary).toContain("3 consecutive");
    expect(model.events[0].title).toContain("Recovery failed");
  });
});
