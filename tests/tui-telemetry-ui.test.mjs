import { describe, expect, it } from "vitest";

import {
  buildFunnel,
  buildProviderStats,
  buildRateLimitHours,
  deriveTelemetrySnapshot,
  renderSparkline,
} from "../ui/tui/telemetry-helpers.js";

describe("TelemetryScreen helpers", () => {
  it("renders empty sparkline for no values", () => {
    expect(renderSparkline([])).toBe("");
  });

  it("renders scaled block sparkline", () => {
    expect(renderSparkline([0, 1, 2, 3])).toBe("▁▃▆█");
  });

  it("renders flat sparkline for all zeros", () => {
    expect(renderSparkline([0, 0, 0])).toBe("▁▁▁");
  });

  it("aggregates provider stats with configured rates", () => {
    const rows = buildProviderStats([
      {
        provider: "CLAUDE",
        inputTokens: 1000,
        outputTokens: 500,
        startedAt: "2026-03-25T10:00:00Z",
        lastActiveAt: "2026-03-25T10:10:00Z",
        errorCount: 2,
      },
      {
        provider: "codex",
        inputTokens: 200,
        outputTokens: 300,
        durationSeconds: 30,
      },
    ], {
      claude: 0.003,
      codex: 0.002,
    });

    const claude = rows.find((row) => row.provider === "claude");
    const codex = rows.find((row) => row.provider === "codex");
    expect(claude.totalTokens).toBe(1500);
    expect(claude.estimatedCostUsd).toBeCloseTo(0.0045, 6);
    expect(claude.errorCount).toBe(2);
    expect(codex.totalTokens).toBe(500);
    expect(codex.estimatedCostUsd).toBeCloseTo(0.001, 6);
  });

  it("builds funnel percentages from task states", () => {
    const funnel = buildFunnel([
      { status: "todo" },
      { status: "todo" },
      { status: "in_progress" },
      { status: "done" },
    ]);

    expect(funnel.find((item) => item.status === "todo")).toMatchObject({ count: 2, percent: 100 });
    expect(funnel.find((item) => item.status === "in_progress")).toMatchObject({ count: 1, percent: 50 });
    expect(funnel.find((item) => item.status === "done")).toMatchObject({ count: 1, percent: 50 });
  });

  it("marks the current hour in the 429 heatmap", () => {
    const now = new Date("2026-03-25T14:30:00");
    const hours = buildRateLimitHours([
      { timestamp: "2026-03-25T14:05:00", count: 2 },
      { timestamp: "2026-03-25T14:35:00", count: 1 },
    ], now);

    const current = hours[14];
    expect(current.currentHour).toBe(true);
    expect(current.count).toBe(3);
    expect(current.label.trim()).toBe("3");
  });

  it("derives telemetry snapshot from ws state data", () => {
    const snapshot = deriveTelemetrySnapshot({
      stats: { throughputTps: 7.5, tokensTotal: 1200, costPer1kTokensUsd: { claude: 0.003 } },
      sessions: [{ provider: "claude", inputTokens: 600, outputTokens: 600, errorCount: 1 }],
      tasks: [{ status: "todo" }, { status: "done" }],
      logs: [
        { level: "error", line: "provider failed" },
        { level: "warn", line: "retry after backoff" },
        { level: "warn", line: "429 rate limit" },
      ],
      now: Date.parse("2026-03-25T14:30:00Z"),
    });

    expect(snapshot.throughput).toBe(7.5);
    expect(snapshot.tokenTotal).toBe(1200);
    expect(snapshot.errors).toBe(1);
    expect(snapshot.retries).toBe(1);
    expect(snapshot.rateLimitEvents).toHaveLength(1);
    expect(snapshot.sessionCostUsd).toBeCloseTo(0.0036, 6);
  });
});

