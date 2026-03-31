import { describe, expect, it } from "vitest";

import {
  buildProviderUsageRows,
  buildRateLimitHeatmap,
  buildTaskFunnel,
  buildTelemetryModel,
  estimateProviderCost,
  normalizeTelemetryRateMap,
  renderTelemetrySparkline,
} from "../tui/screens/telemetry-screen-helpers.mjs";
import { EXTENDED_SCREEN_ORDER, getNextScreenForInput } from "../tui/lib/navigation.mjs";

describe("tui telemetry screen helpers", () => {
  it("renders block-only sparklines capped to the latest 60 samples", () => {
    const input = Array.from({ length: 80 }, (_, index) => index);
    const line = renderTelemetrySparkline(input);

    expect(line).toHaveLength(60);
    expect(line).toMatch(/^[▁▂▃▄▅▆▇█]+$/u);
  });

  it("normalizes provider rate maps with documented defaults", () => {
    expect(normalizeTelemetryRateMap({})).toEqual({
      claude: 0.003,
      codex: 0.002,
      gemini: 0.0001,
      copilot: 0,
    });
  });

  it("estimates zero cost when a provider rate is missing", () => {
    expect(estimateProviderCost({ totalTokens: 1500, ratePer1k: null })).toBe(0);
    expect(estimateProviderCost({ totalTokens: 1500, ratePer1k: 0 })).toBe(0);
  });

  it("builds provider rows, highlights the busiest provider, and totals estimates", () => {
    const rows = buildProviderUsageRows({
      providers: {
        codex: {
          sessions: 3,
          tokensIn: 3000,
          tokensOut: 1000,
          avgSessionLengthSec: 180,
          errorCount: 1,
        },
        claude: {
          sessions: 1,
          tokensIn: 500,
          tokensOut: 500,
          avgSessionLengthSec: 60,
          errorCount: 2,
        },
      },
      rateMap: { codex: 0.002, claude: 0.003 },
    });

    expect(rows[0].provider).toBe("codex");
    expect(rows[0].highlight).toBe("cyan");
    expect(rows[0].costEstimateUsd).toBeCloseTo(0.008, 6);
    expect(rows[1].provider).toBe("claude");
    expect(rows[1].highlight).toBe(null);
  });

  it("builds a 24-hour 429 heatmap and marks the current hour", () => {
    const cells = buildRateLimitHeatmap({
      hourly429s: [0, 0, 1, 2, 0, 5],
      currentHour: 5,
    });

    expect(cells).toHaveLength(24);
    expect(cells[0]).toMatchObject({ label: "no data", tone: "dim", isCurrentHour: false });
    expect(cells[2]).toMatchObject({ count: 1, tone: "yellow" });
    expect(cells[5]).toMatchObject({ count: 5, tone: "red", isCurrentHour: true });
  });

  it("builds funnel counts and conversion percentages across stages", () => {
    const funnel = buildTaskFunnel({ todo: 10, inProgress: 5, review: 4, done: 3, failed: 1 });

    expect(funnel.stages.map((stage) => stage.key)).toEqual([
      "todo",
      "in_progress",
      "review",
      "done",
      "failed",
    ]);
    expect(funnel.stages[1].conversionPct).toBe(50);
    expect(funnel.stages[3].conversionPct).toBe(30);
    expect(funnel.stages[4].conversionPct).toBe(10);
  });

  it("builds a composite telemetry model with estimated session and day totals", () => {
    const model = buildTelemetryModel({
      stats: {
        telemetry: {
          throughputPerSecond: Array.from({ length: 60 }, (_, index) => index % 8),
          errorsPerWindow: [0, 1, 0, 2],
          retriesPerWindow: [1, 1, 2, 3],
          providers: {
            codex: {
              sessions: 2,
              tokensIn: 1000,
              tokensOut: 500,
              dayTokensIn: 4000,
              dayTokensOut: 2000,
              avgSessionLengthSec: 90,
              errorCount: 1,
            },
          },
          hourly429s: [0, 0, 0, 3],
          taskFunnel: { todo: 4, inProgress: 2, review: 1, done: 1, failed: 0 },
        },
      },
      config: {
        telemetry: {
          costPer1kTokensUsd: {
            codex: 0.002,
          },
        },
      },
      currentHour: 3,
    });

    expect(model.providerRows[0].provider).toBe("codex");
    expect(model.cost.sessionEstimateUsd).toBeCloseTo(0.003, 6);
    expect(model.cost.dayEstimateUsd).toBeCloseTo(0.012, 6);
    expect(model.heatmap[3].isCurrentHour).toBe(true);
    expect(model.sparklines.throughput).toHaveLength(60);
  });
});

describe("tui navigation telemetry tab", () => {
  it("adds telemetry to the extended TUI navigation", () => {
    expect(EXTENDED_SCREEN_ORDER).toEqual([
      "status",
      "tasks",
      "agents",
      "logs",
      "workflows",
      "telemetry",
      "settings",
    ]);
    expect(getNextScreenForInput("status", "6")).toBe("telemetry");
  });
});
