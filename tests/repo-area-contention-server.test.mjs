import { describe, expect, it } from "vitest";
import {
  summarizeRepoAreaLockContention,
  normalizeRepoAreaLockContentionSummary,
} from "../server/ui-server.mjs";

describe("repo-area contention server summary", () => {
  it("returns a stable empty shape when lock telemetry is absent", () => {
    const summary = normalizeRepoAreaLockContentionSummary(null);

    expect(summary).toMatchObject({
      totalEvents: 0,
      totalWaitMs: 0,
      hotAreas: [],
      recent: [],
      stale: false,
    });
  });

  it("summarizes active contention and preserves backward compatibility fields", () => {
    const summary = summarizeRepoAreaLockContention({
      contention: {
        events: 4,
        waitMsTotal: 9200,
        recent: [
          {
            at: "2026-03-24T11:55:00.000Z",
            taskId: "task-1",
            area: "server",
            waitMs: 3200,
            resolutionReason: "deferred",
          },
        ],
      },
      areas: [
        {
          area: "server",
          waitingTasks: 2,
          activeSlots: 1,
          effectiveLimit: 1,
          contentionEvents: 3,
          contentionWaitMs: 8400,
          lastContentionAt: "2026-03-24T11:55:00.000Z",
        },
        {
          area: "ui",
          waitingTasks: 0,
          activeSlots: 1,
          effectiveLimit: 2,
          contentionEvents: 1,
          contentionWaitMs: 800,
          lastContentionAt: "2026-03-24T11:40:00.000Z",
        },
      ],
    }, { now: "2026-03-24T12:00:00.000Z" });

    expect(summary).toMatchObject({
      totalEvents: 4,
      totalWaitMs: 9200,
      stale: false,
    });
    expect(summary.hotAreas[0]).toMatchObject({
      area: "server",
      events: 3,
      waitingTasks: 2,
      activeSlots: 1,
    });
    expect(summary.recent[0]).toMatchObject({
      taskId: "task-1",
      area: "server",
      detailHref: "/api/tasks/detail?taskId=task-1",
    });
  });

  it("treats old contention samples as stale but still readable", () => {
    const summary = summarizeRepoAreaLockContention({
      contention: {
        events: 1,
        waitMsTotal: 1200,
        recent: [
          {
            at: "2026-03-20T08:00:00.000Z",
            taskId: "task-old",
            area: "agent",
            waitMs: 1200,
            resolutionReason: "timeout",
          },
        ],
      },
      areas: [
        {
          area: "agent",
          waitingTasks: 0,
          activeSlots: 0,
          effectiveLimit: 1,
          contentionEvents: 1,
          contentionWaitMs: 1200,
          lastContentionAt: "2026-03-20T08:00:00.000Z",
        },
      ],
    }, { now: "2026-03-24T12:00:00.000Z", staleAfterMs: 24 * 60 * 60 * 1000 });

    expect(summary.stale).toBe(true);
    expect(summary.staleAgeMs).toBeGreaterThan(0);
    expect(summary.hotAreas[0].area).toBe("agent");
  });
});
