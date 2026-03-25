import { describe, expect, it } from "vitest";
import {
  buildRepoAreaContentionViewModel,
  normalizeRepoAreaContentionSummary,
} from "../ui/modules/repo-area-contention.js";

describe("repo-area contention ui model", () => {
  it("handles empty telemetry without rendering hot areas", () => {
    const summary = normalizeRepoAreaContentionSummary(null);
    const model = buildRepoAreaContentionViewModel(summary);

    expect(summary).toMatchObject({
      totalEvents: 0,
      hotAreas: [],
      recent: [],
      stale: false,
    });
    expect(model).toMatchObject({
      tone: "success",
      headline: "No repo-area contention detected",
      hotAreas: [],
      recentEvents: [],
    });
  });

  it("surfaces active contention hotspots and drill-down links", () => {
    const model = buildRepoAreaContentionViewModel({
      generatedAt: "2026-03-24T12:00:00.000Z",
      totalEvents: 5,
      totalWaitMs: 18500,
      stale: false,
      hotAreas: [
        {
          area: "server",
          events: 3,
          waitingTasks: 2,
          activeSlots: 1,
          avgWaitMs: 4000,
          lastContentionAt: "2026-03-24T11:59:00.000Z",
          detailHref: "/tasks?repoArea=server&contention=1",
        },
      ],
      recent: [
        {
          area: "server",
          taskId: "task-123",
          waitMs: 4500,
          at: "2026-03-24T11:59:00.000Z",
          resolutionReason: "deferred",
          detailHref: "/tasks/task-123?contention=1",
        },
      ],
    });

    expect(model.tone).toBe("warning");
    expect(model.headline).toContain("Hot repo areas");
    expect(model.hotAreas[0]).toMatchObject({
      area: "server",
      eventsLabel: "3 events",
      waitingLabel: "2 waiting",
      detailHref: "/tasks?repoArea=server&contention=1",
    });
    expect(model.recentEvents[0]).toMatchObject({
      title: "server contention",
      detailHref: "/tasks/task-123?contention=1",
    });
  });

  it("marks stale telemetry so operators do not trust old contention", () => {
    const model = buildRepoAreaContentionViewModel({
      generatedAt: "2026-03-20T12:00:00.000Z",
      totalEvents: 2,
      totalWaitMs: 2500,
      stale: true,
      staleAgeMs: 172800000,
      hotAreas: [
        {
          area: "workflow",
          events: 2,
          waitingTasks: 0,
          activeSlots: 0,
          avgWaitMs: 1250,
          lastContentionAt: "2026-03-20T11:58:00.000Z",
          detailHref: "/tasks?repoArea=workflow&contention=1",
        },
      ],
      recent: [],
    });

    expect(model.tone).toBe("info");
    expect(model.summary).toContain("Stale");
    expect(model.hotAreas[0].lastSeenLabel).toContain("ago");
  });
});
