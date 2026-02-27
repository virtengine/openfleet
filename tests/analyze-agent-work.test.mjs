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

// -- JSONL Fixture Tests (T6) -----------------------------------------------

// Load JSONL fixtures at module scope using the static readFileSync import
function parseJsonl(content) {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const JSONL_FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/analyze-agent-work");
const errorsJsonl = parseJsonl(readFileSync(resolve(JSONL_FIXTURE_DIR, "agent-errors-sample.jsonl"), "utf8"));
const metricsJsonl = parseJsonl(readFileSync(resolve(JSONL_FIXTURE_DIR, "agent-metrics-sample.jsonl"), "utf8"));
const JSONL_NOW = new Date("2026-02-26T00:01:00.000Z");

describe("analyze-agent-work JSONL fixture determinism", () => {
  it("agent-errors-sample.jsonl contains 15 records", () => {
    expect(errorsJsonl.length).toBe(15);
  });

  it("agent-metrics-sample.jsonl contains 20 records", () => {
    expect(metricsJsonl.length).toBe(20);
  });

  it("all JSONL error records have required fields", () => {
    for (const record of errorsJsonl) {
      expect(record).toHaveProperty("timestamp");
      expect(record).toHaveProperty("task_id");
      expect(record).toHaveProperty("executor");
      expect(record).toHaveProperty("data");
    }
  });

  it("all JSONL metric records have required fields", () => {
    for (const record of metricsJsonl) {
      expect(record).toHaveProperty("timestamp");
      expect(record).toHaveProperty("task_id");
      expect(record).toHaveProperty("executor");
      expect(record).toHaveProperty("metrics");
    }
  });

  it("filterRecordsByWindow filters JSONL errors to a 7-day window", () => {
    const filtered = filterRecordsByWindow(errorsJsonl, { days: 7, now: JSONL_NOW });
    const old = filtered.filter((r) => r.task_id === "err-task-old");
    expect(old).toHaveLength(0);
    const badTs = filtered.filter((r) => r.task_id === "err-task-bad");
    expect(badTs).toHaveLength(1);
  });

  it("filterRecordsByWindow filters JSONL metrics to a 7-day window", () => {
    const filtered = filterRecordsByWindow(metricsJsonl, { days: 7, now: JSONL_NOW });
    const old = filtered.filter((r) => r.task_id === "metric-task-old");
    expect(old).toHaveLength(0);
  });

  it("buildErrorClusters from JSONL data ranks timeout as top cluster", () => {
    const windowed = filterRecordsByWindow(errorsJsonl, { days: 7, now: JSONL_NOW });
    const clusters = buildErrorClusters(windowed);
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].fingerprint).toBe("timeout");
    expect(clusters[0].count).toBeGreaterThanOrEqual(4);
  });

  it("buildErrorClusters produces at least 3 distinct fingerprints from JSONL sample", () => {
    const windowed = filterRecordsByWindow(errorsJsonl, { days: 7, now: JSONL_NOW });
    const clusters = buildErrorClusters(windowed);
    expect(new Set(clusters.map((c) => c.fingerprint)).size).toBeGreaterThanOrEqual(3);
  });

  it("buildErrorCorrelationJsonPayload returns stable shape from JSONL fixtures", () => {
    const windowedErrors = filterRecordsByWindow(errorsJsonl, { days: 7, now: JSONL_NOW });
    const windowedMetrics = filterRecordsByWindow(metricsJsonl, { days: 7, now: JSONL_NOW });
    const summary = buildErrorCorrelationSummary({
      errors: windowedErrors,
      metrics: windowedMetrics,
      windowDays: 7,
      top: 5,
    });
    const payload = buildErrorCorrelationJsonPayload(summary, { now: JSONL_NOW });
    expect(Object.keys(payload).sort()).toEqual(
      ["correlations", "generated_at", "top", "total_errors", "total_fingerprints", "window_days"].sort(),
    );
    expect(payload.window_days).toBe(7);
    expect(typeof payload.total_errors).toBe("number");
    expect(Array.isArray(payload.correlations)).toBe(true);
  });

  it("each correlation entry has the expected key set", () => {
    const windowedErrors = filterRecordsByWindow(errorsJsonl, { days: 7, now: JSONL_NOW });
    const windowedMetrics = filterRecordsByWindow(metricsJsonl, { days: 7, now: JSONL_NOW });
    const summary = buildErrorCorrelationSummary({ errors: windowedErrors, metrics: windowedMetrics, windowDays: 7, top: 5 });
    const payload = buildErrorCorrelationJsonPayload(summary, { now: JSONL_NOW });
    for (const entry of payload.correlations) {
      expect(Object.keys(entry).sort()).toEqual(
        ["by_complexity", "by_executor", "by_size", "count", "fingerprint", "first_seen", "last_seen", "sample_message", "task_count"].sort(),
      );
    }
  });

  it("clusters are sorted descending by count", () => {
    const windowed = filterRecordsByWindow(errorsJsonl, { days: 7, now: JSONL_NOW });
    const clusters = buildErrorClusters(windowed);
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i - 1].count).toBeGreaterThanOrEqual(clusters[i].count);
    }
  });

  it("normalizeErrorFingerprint extracts a stable fingerprint from similar messages", () => {
    const fp1 = normalizeErrorFingerprint("Operation timed out after 30s");
    const fp2 = normalizeErrorFingerprint("Operation timed out after 60s");
    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe("string");
    expect(fp1.length).toBeGreaterThan(0);
  });
});