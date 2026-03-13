import { describe, expect, it } from "vitest";
import {
  createRetryQueueState,
  reduceRetryQueue,
  snapshotRetryQueue,
} from "../agent/retry-queue.mjs";

describe("retry-queue reducer", () => {
  it("add: inserts a retry item", () => {
    const state = createRetryQueueState(1_700_000_000_000);
    const next = reduceRetryQueue(state, {
      type: "add",
      now: 1_700_000_000_000,
      item: {
        taskId: "TASK-1",
        lastError: "Build failed",
        retryCount: 1,
        nextAttemptAt: 1_700_000_010_000,
      },
    });
    const queue = snapshotRetryQueue(next);
    expect(queue.count).toBe(1);
    expect(queue.items[0].taskId).toBe("TASK-1");
    expect(queue.items[0].retryCount).toBe(1);
  });

  it("remove: deletes an existing retry item", () => {
    const base = reduceRetryQueue(createRetryQueueState(1_700_000_000_000), {
      type: "add",
      now: 1_700_000_000_000,
      item: { taskId: "TASK-1", retryCount: 1, nextAttemptAt: 1_700_000_010_000 },
    });
    const next = reduceRetryQueue(base, {
      type: "remove",
      taskId: "TASK-1",
      now: 1_700_000_001_000,
    });
    expect(snapshotRetryQueue(next).count).toBe(0);
  });

  it("bump-count: increments retry count and stats", () => {
    const base = reduceRetryQueue(createRetryQueueState(1_700_000_000_000), {
      type: "add",
      now: 1_700_000_000_000,
      item: {
        taskId: "TASK-1",
        retryCount: 1,
        nextAttemptAt: 1_700_000_010_000,
      },
    });
    const next = reduceRetryQueue(base, {
      type: "bump-count",
      taskId: "TASK-1",
      now: 1_700_000_002_000,
      item: { nextAttemptAt: 1_700_000_020_000, lastError: "Second failure" },
    });
    const queue = snapshotRetryQueue(next);
    expect(queue.items[0].retryCount).toBe(2);
    expect(queue.stats.totalRetriesToday).toBe(1);
    expect(queue.stats.peakRetryDepth).toBe(2);
  });

  it("expire: removes stale entries", () => {
    const base = reduceRetryQueue(createRetryQueueState(1_700_000_000_000), {
      type: "add",
      now: 1_700_000_000_000,
      item: {
        taskId: "TASK-1",
        retryCount: 1,
        nextAttemptAt: 1_700_000_010_000,
        expiresAt: 1_700_000_015_000,
      },
    });
    const next = reduceRetryQueue(base, {
      type: "expire",
      now: 1_700_000_020_000,
    });
    expect(snapshotRetryQueue(next).count).toBe(0);
  });
});
