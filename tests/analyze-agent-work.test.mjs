import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildErrorClusters,
  buildErrorCorrelationJsonPayload,
  buildErrorCorrelationSummary,
  filterRecordsByWindow,
} from "../analyze-agent-work-helpers.mjs";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/analyze-agent-work");
const metrics = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "agent-work-metrics.json"), "utf8"),
);
const errors = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, "agent-work-errors.json"), "utf8"),
);

const NOW = new Date("2026-02-26T00:00:00.000Z");

describe("analyze-agent-work helpers", () => {
  it("filters records by date window while preserving invalid timestamps", () => {
    const extended = [
      ...errors,
      { timestamp: "not-a-date", task_id: "task-bad" },
    ];

    const filtered = filterRecordsByWindow(extended, { days: 7, now: NOW });

    expect(filtered.length).toBe(6);
    expect(filtered.some((record) => record.task_id === "task-3")).toBe(false);
    expect(filtered.some((record) => record.task_id === "task-bad")).toBe(true);
  });

  it("builds error clusters and ranks by count", () => {
    const windowedErrors = filterRecordsByWindow(errors, { days: 7, now: NOW });
    const clusters = buildErrorClusters(windowedErrors);

    expect(clusters.length).toBe(2);
    expect(clusters[0].fingerprint).toBe("timeout");
    expect(clusters[0].count).toBe(3);
    expect(clusters[0].affected_tasks).toBe(1);
    expect(clusters[0].affected_attempts).toBe(3);

    expect(clusters[1].fingerprint).toBe("auth");
    expect(clusters[1].count).toBe(2);
    expect(clusters[1].affected_tasks).toBe(1);
  });

  it("builds correlation summaries with grouped attributes", () => {
    const windowedErrors = filterRecordsByWindow(errors, { days: 7, now: NOW });
    const windowedMetrics = filterRecordsByWindow(metrics, { days: 7, now: NOW });

    const summary = buildErrorCorrelationSummary({
      errors: windowedErrors,
      metrics: windowedMetrics,
      windowDays: 7,
      top: 5,
    });

    expect(summary.total_errors).toBe(5);
    expect(summary.total_fingerprints).toBe(2);

    const [timeout, auth] = summary.correlations;

    expect(timeout.fingerprint).toBe("timeout");
    expect(timeout.by_executor).toEqual({ CODEX: 3 });
    expect(timeout.by_size).toEqual({ m: 3 });
    expect(timeout.by_complexity).toEqual({ medium: 3 });

    expect(auth.fingerprint).toBe("auth");
    expect(auth.by_executor).toEqual({ COPILOT: 2 });
    expect(auth.by_size).toEqual({ s: 2 });
    expect(auth.by_complexity).toEqual({ low: 2 });
  });

  it("produces a stable JSON payload shape for correlations", () => {
    const windowedErrors = filterRecordsByWindow(errors, { days: 7, now: NOW });
    const windowedMetrics = filterRecordsByWindow(metrics, { days: 7, now: NOW });
    const summary = buildErrorCorrelationSummary({
      errors: windowedErrors,
      metrics: windowedMetrics,
      windowDays: 7,
      top: 5,
    });

    const payload = buildErrorCorrelationJsonPayload(summary, {
      now: new Date("2026-02-26T12:00:00.000Z"),
    });

    expect(Object.keys(payload).sort()).toEqual(
      [
        "correlations",
        "generated_at",
        "top",
        "total_errors",
        "total_fingerprints",
        "window_days",
      ].sort(),
    );
    expect(payload.window_days).toBe(7);
    expect(payload.total_errors).toBe(5);
    expect(payload.total_fingerprints).toBe(2);
    expect(payload.correlations.length).toBe(2);

    const first = payload.correlations[0];
    expect(Object.keys(first).sort()).toEqual(
      [
        "by_complexity",
        "by_executor",
        "by_size",
        "count",
        "fingerprint",
        "first_seen",
        "last_seen",
        "sample_message",
        "task_count",
      ].sort(),
    );
    expect(first.fingerprint).toBe("timeout");
    expect(first.count).toBe(3);
    expect(first.task_count).toBe(1);
    expect(first.first_seen).toBe("2026-02-25T11:00:00.000Z");
    expect(first.last_seen).toBe("2026-02-25T11:10:00.000Z");
    expect(first.by_executor[0].label).toBe("CODEX");
    expect(first.by_executor[0].count).toBe(3);
    expect(first.by_executor[0].percent).toBe(100);
  });
});
