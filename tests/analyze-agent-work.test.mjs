import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildErrorClusters,
  buildErrorCorrelationJsonPayload,
  buildErrorCorrelationSummary,
  filterRecordsByWindow,
  normalizeErrorFingerprint,
} from "../agent/analyze-agent-work-helpers.mjs";

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
    expect(timeout.by_model).toEqual({ "gpt-5.2-codex": 3 });
    expect(timeout.by_size).toEqual({ m: 3 });
    expect(timeout.by_complexity).toEqual({ medium: 3 });
    expect(timeout.avg_task_duration_ms).toBe(60000);

    expect(auth.fingerprint).toBe("auth");
    expect(auth.by_executor).toEqual({ COPILOT: 2 });
    expect(auth.by_model).toEqual({ "claude-sonnet-4.6": 2 });
    expect(auth.by_size).toEqual({ s: 2 });
    expect(auth.by_complexity).toEqual({ low: 2 });
    expect(auth.avg_task_duration_ms).toBe(120000);
  });

  it("marks complexity as unknown when task_description is missing", () => {
    const summary = buildErrorCorrelationSummary({
      errors: [
        {
          timestamp: "2026-02-25T12:00:00.000Z",
          task_id: "task-unknown",
          task_title: "[s] missing description",
          task_description: "",
          executor: "CODEX",
          model: "gpt-5.1-codex-mini",
          attempt_id: "attempt-unknown",
          data: {
            error_fingerprint: "timeout",
            error_message: "Timeout after 20s",
            error_category: "timeout",
          },
        },
      ],
      metrics: [
        {
          timestamp: "2026-02-25T11:55:00.000Z",
          task_id: "task-unknown",
          task_title: "[s] missing description",
          task_description: "",
          executor: "CODEX",
          model: "gpt-5.1-codex-mini",
          metrics: { duration_ms: 45000 },
        },
      ],
      windowDays: 7,
      top: 5,
    });

    expect(summary.total_errors).toBe(1);
    expect(summary.total_fingerprints).toBe(1);
    expect(summary.correlations[0].by_size).toEqual({ s: 1 });
    expect(summary.correlations[0].by_complexity).toEqual({ unknown: 1 });
    expect(summary.correlations[0].by_model).toEqual({
      "gpt-5.1-codex-mini": 1,
    });
    expect(summary.correlations[0].avg_task_duration_ms).toBe(45000);
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
        "avg_task_duration_ms",
        "by_complexity",
        "by_executor",
        "by_model",
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
    expect(first.avg_task_duration_ms).toBe(60000);
    expect(first.by_executor[0].label).toBe("CODEX");
    expect(first.by_executor[0].count).toBe(3);
    expect(first.by_executor[0].percent).toBe(100);
    expect(first.by_model[0].label).toBe("gpt-5.2-codex");
    expect(first.by_model[0].count).toBe(3);
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
        ["avg_task_duration_ms", "by_complexity", "by_executor", "by_model", "by_size", "count", "fingerprint", "first_seen", "last_seen", "sample_message", "task_count"].sort(),
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

describe("analyze-agent-work CLI", () => {
  function makeCliEnv(logDir) {
    return {
      ...process.env,
      AGENT_WORK_LOG_DIR: logDir,
    };
  }

  function runCli(args, { logDir }) {
    return execFileSync(process.execPath, ["agent/analyze-agent-work.mjs", ...args], {
      cwd: process.cwd(),
      env: makeCliEnv(logDir),
      encoding: "utf8",
    });
  }

  function makeLogDir() {
    const baseDir = mkdtempSync(resolve(tmpdir(), "bosun-agent-work-"));
    const logDir = resolve(baseDir, "agent-work-logs");
    mkdirSync(logDir, { recursive: true });
    return { baseDir, logDir };
  }

  function seedFixtureLogs(logDir) {
    copyFileSync(
      resolve(FIXTURE_DIR, "errors.jsonl"),
      resolve(logDir, "agent-errors.jsonl"),
    );
    copyFileSync(
      resolve(FIXTURE_DIR, "metrics.jsonl"),
      resolve(logDir, "agent-metrics.jsonl"),
    );
  }

  it("prints a ranked correlation report with executor and size breakdowns", () => {
    const { baseDir, logDir } = makeLogDir();

    try {
      seedFixtureLogs(logDir);

      const output = runCli(
        ["--error-correlation", "--days", "30", "--top", "1"],
        { logDir },
      );

      expect(output).toContain("=== Error Correlation Report ===");
      expect(output).toContain("timeout_api");
      expect(output).toContain("Executors:");
      expect(output).toContain("Sizes:");
      expect(output).not.toContain("auth_failed");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("emits valid JSON and applies days/top filters", () => {
    const { baseDir, logDir } = makeLogDir();

    try {
      seedFixtureLogs(logDir);

      const output = runCli(
        ["--error-correlation", "--days", "30", "--top", "2", "--json"],
        { logDir },
      );
      const payload = JSON.parse(output);

      expect(payload.window_days).toBe(30);
      expect(payload.top).toBe(2);
      expect(payload.total_errors).toBe(5);
      expect(payload.correlations).toHaveLength(2);
      expect(payload.correlations[0]).toHaveProperty("by_executor");
      expect(payload.correlations[0]).toHaveProperty("by_size");
      expect(payload.correlations[0]).toHaveProperty("by_complexity");
      expect(
        payload.correlations.some((entry) => entry.fingerprint === "legacy_failure"),
      ).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("exits cleanly with a no-data message when the log directory is empty", () => {
    const { baseDir, logDir } = makeLogDir();

    try {
      const output = runCli(
        ["--error-correlation", "--days", "30", "--top", "5"],
        { logDir },
      );

      expect(output).toContain("No data found");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
