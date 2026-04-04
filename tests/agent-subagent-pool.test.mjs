import { describe, expect, it } from "vitest";

import { createSubagentPool } from "../agent/subagent-pool.mjs";

describe("subagent pool", () => {
  it("queues excess subagents and drains them in FIFO order", async () => {
    const events = [];
    const pool = createSubagentPool({
      onEvent: (event) => events.push(event),
    });

    const firstLease = await pool.acquire({
      poolId: "root-session",
      sessionId: "child-a",
      maxConcurrent: 1,
    });
    const secondLeasePromise = pool.acquire({
      poolId: "root-session",
      sessionId: "child-b",
      maxConcurrent: 1,
    });

    expect(pool.getPool("root-session")).toEqual(expect.objectContaining({
      activeCount: 1,
      queueDepth: 1,
    }));
    expect(events.map((event) => event.type)).toEqual([
      "subagent_pool_acquired",
      "subagent_pool_queued",
    ]);

    pool.release(firstLease, { status: "completed" });
    const secondLease = await secondLeasePromise;

    expect(secondLease.sessionId).toBe("child-b");
    expect(pool.getPool("root-session")).toEqual(expect.objectContaining({
      activeCount: 1,
      queueDepth: 0,
    }));
    expect(events.map((event) => event.type)).toEqual([
      "subagent_pool_acquired",
      "subagent_pool_queued",
      "subagent_pool_released",
      "subagent_pool_acquired",
    ]);
  });
});
