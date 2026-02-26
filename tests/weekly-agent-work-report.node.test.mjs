import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  buildWeeklyAgentWorkSummary,
  formatWeeklyAgentWorkReport,
  generateWeeklyAgentWorkReport,
  getNextWeeklyReportTime,
  shouldSendWeeklyReport,
} from "../scripts/bosun/agents/agent-work-report.mjs""161;

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(now, daysAgo) {
  return new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
}

describe("agent-work-report weekly summary", () => {
  it("aggregates metrics and errors within the requested window", () => {
    const now = new Date("2026-02-25T12:00:00.000Z");

    const summary = buildWeeklyAgentWorkSummary({
      now,
      days: 7,
      metrics: [
        {
          timestamp: isoDaysAgo(now, 1),
          executor: "codex",
          outcome: { status: "completed" },
          metrics: { cost_usd: 1.234, duration_ms: 120000 },
          error_summary: { total_errors: 2 },
        },
        {
          timestamp: isoDaysAgo(now, 2),
          executor: "copilot",
          metrics: { success: true, cost_usd: 0.5, duration_ms: 180000 },
          error_summary: { total_errors: 1 },
        },
        {
          timestamp: isoDaysAgo(now, 10),
          executor: "codex",
          outcome: { status: "completed" },
          metrics: { cost_usd: 99, duration_ms: 60 * 60000 },
          error_summary: { total_errors: 99 },
        },
        {
          timestamp: "not-a-date",
          executor: "",
          outcome: { status: "failed" },
          metrics: { cost_usd: "0.266", duration_ms: 0 },
          error_summary: { total_errors: "3" },
        },
      ],
      errors: [
        { timestamp: isoDaysAgo(now, 1), data: { error_fingerprint: "timeout" } },
        { timestamp: isoDaysAgo(now, 2), data: { error_fingerprint: "timeout" } },
        { timestamp: isoDaysAgo(now, 3), data: { error_fingerprint: "" } },
        { timestamp: "invalid", data: { error_fingerprint: "" } },
        { timestamp: isoDaysAgo(now, 10), data: { error_fingerprint: "auth" } },
      ],
    });

    assert.equal(summary.period.days, 7);
    assert.equal(summary.totals.totalSessions, 3);
    assert.equal(summary.totals.completedSessions, 2);
    assert.equal(summary.totals.successRatePct, 66.67);
    assert.equal(summary.totals.totalCostUsd, 2);
    assert.equal(summary.totals.totalErrors, 6);
    assert.equal(summary.totals.totalDurationMinutes, 5);

    assert.deepEqual(summary.topErrorFingerprints.slice(0, 2), [
      { fingerprint: "timeout", count: 2 },
      { fingerprint: "unknown", count: 2 },
    ]);

    assert.deepEqual(summary.executorBreakdown, [
      {
        executor: "codex",
        sessions: 1,
        completedSessions: 1,
        successRatePct: 100,
      },
      {
        executor: "copilot",
        sessions: 1,
        completedSessions: 1,
        successRatePct: 100,
      },
      {
        executor: "unknown",
        sessions: 1,
        completedSessions: 0,
        successRatePct: 0,
      },
    ]);
  });

  it("falls back to default days when the value is invalid", () => {
    const now = new Date("2026-02-25T12:00:00.000Z");
    const summary = buildWeeklyAgentWorkSummary({
      now,
      days: 0,
      metrics: [],
      errors: [],
    });

    assert.equal(summary.period.days, 7);
  });
});

describe("agent-work-report text formatting", () => {
  it("renders a human-readable report for empty data", () => {
    const text = formatWeeklyAgentWorkReport(
      buildWeeklyAgentWorkSummary({ metrics: [], errors: [] }),
    );

    assert.match(text, /Weekly Agent Work Report/);
    assert.match(text, /No agent work data found for this period\./);
    assert.match(text, /Top Errors[\s\S]*- none/);
    assert.match(text, /Executor Breakdown\n- none/);
  });

  it("handles invalid summary inputs safely", () => {
    const text = formatWeeklyAgentWorkReport(null);
    assert.match(text, /Weekly Agent Work Report/);
  });
});

describe("agent-work-report generation", () => {
  it("returns warnings when loaders return invalid shapes or throw", async () => {
    const now = new Date("2026-02-25T12:00:00.000Z");

    const result = await generateWeeklyAgentWorkReport({
      now,
      days: 3,
      loadMetrics: async () => ({ bad: true }),
      loadErrors: async () => {
        throw new Error("errors-loader-failed");
      },
    });

    assert.deepEqual(result.warnings, [
      "metrics loader returned a non-array value",
      "errors loader failed: errors-loader-failed",
    ]);
    assert.equal(result.summary.period.days, 3);
    assert.equal(result.summary.totals.totalSessions, 0);
    assert.match(result.text, /No agent work data found for this period\./);
  });

  it("passes now and days into loaders", async () => {
    const now = new Date("2026-02-25T12:00:00.000Z");
    let metricsArgs = null;
    let errorsArgs = null;

    const result = await generateWeeklyAgentWorkReport({
      now,
      days: 5,
      loadMetrics: async (args) => {
        metricsArgs = args;
        return [];
      },
      loadErrors: async (args) => {
        errorsArgs = args;
        return [];
      },
    });

    assert.equal(metricsArgs.now, now);
    assert.equal(metricsArgs.days, 5);
    assert.equal(errorsArgs.now, now);
    assert.equal(errorsArgs.days, 5);
    assert.deepEqual(result.warnings, []);
  });
});

describe("agent-work-report scheduling", () => {
  it("calculates the next scheduled weekly send time", () => {
    const nowBeforeSlot = new Date("2026-02-22T08:00:00.000Z"); // Sunday
    const nextSameDay = getNextWeeklyReportTime({
      now: nowBeforeSlot,
      dayOfWeek: 0,
      hourUtc: 9,
    });
    assert.equal(nextSameDay.toISOString(), "2026-02-22T09:00:00.000Z");

    const nowAtSlot = new Date("2026-02-22T09:00:00.000Z");
    const nextWeek = getNextWeeklyReportTime({
      now: nowAtSlot,
      dayOfWeek: 0,
      hourUtc: 9,
    });
    assert.equal(nextWeek.toISOString(), "2026-03-01T09:00:00.000Z");
  });

  it("falls back to defaults for invalid schedule values", () => {
    const now = new Date("2026-02-23T10:00:00.000Z"); // Monday
    const next = getNextWeeklyReportTime({
      now,
      dayOfWeek: 99,
      hourUtc: 99,
    });

    assert.equal(next.toISOString(), "2026-03-01T09:00:00.000Z");
  });

  it("applies dedup logic in shouldSendWeeklyReport", () => {
    const beforeWindow = shouldSendWeeklyReport({
      now: new Date("2026-02-24T10:00:00.000Z"), // Tuesday
      dayOfWeek: 3, // Wednesday
      hourUtc: 9,
    });
    assert.equal(beforeWindow, false);

    const firstWindow = shouldSendWeeklyReport({
      now: new Date("2026-02-25T10:00:00.000Z"), // Wednesday
      dayOfWeek: 3,
      hourUtc: 9,
    });
    assert.equal(firstWindow, true);

    const duplicateWindow = shouldSendWeeklyReport({
      now: new Date("2026-02-25T10:00:00.000Z"),
      dayOfWeek: 3,
      hourUtc: 9,
      lastSentAt: "2026-02-25T09:30:00.000Z",
    });
    assert.equal(duplicateWindow, false);

    const badLastSent = shouldSendWeeklyReport({
      now: new Date("2026-02-25T10:00:00.000Z"),
      dayOfWeek: 3,
      hourUtc: 9,
      lastSentAt: "not-a-date",
    });
    assert.equal(badLastSent, true);
  });
});

describe("weekly report command and scheduler wiring", () => {
  const telegramBotSource = readFileSync(
    resolve(process.cwd(), "telegram-bot.mjs"),
    "utf8",
  );
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

  it("registers Telegram commands for weekly reporting", () => {
    assert.match(
      telegramBotSource,
      /"\/weekly":\s*\{[\s\S]*?handler:\s*cmdWeeklyReport[\s\S]*?\}/,
    );
    assert.match(
      telegramBotSource,
      /"\/report":\s*\{[\s\S]*?handler:\s*cmdReport[\s\S]*?\}/,
    );
    assert.match(telegramBotSource, /Weekly agent work report: \/weekly \[days\]/);
    assert.match(telegramBotSource, /Report aliases: \/report weekly \[days\]/);
  });

  it("validates /weekly days argument bounds", () => {
    assert.match(
      telegramBotSource,
      /Number\.isFinite\(maybeDays\)\s*&&\s*maybeDays\s*>\s*0\s*&&\s*maybeDays\s*<=\s*30/,
    );
    assert.match(telegramBotSource, /:\s*7;/);
    assert.match(telegramBotSource, /Usage: \/report weekly \[days\]/);
  });

  it("enables monitor-level weekly scheduler and send path", () => {
    assert.match(monitorSource, /safeSetInterval\("telegram-weekly-report"/);
    assert.match(monitorSource, /safeSetTimeout\("telegram-weekly-report-initial"/);
    assert.match(monitorSource, /generateWeeklyAgentWorkReport\(\{/);
    assert.match(monitorSource, /weeklyReportLastSentAt\s*=\s*now\.toISOString\(\)/);
    assert.match(monitorSource, /dedupKey:\s*`weekly-report:\$\{now\.toISOString\(\)\.slice\(0, 10\)\}`/);
  });
});
