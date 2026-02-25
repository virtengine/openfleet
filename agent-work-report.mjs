import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveRepoRoot } from "./repo-root.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;

function toValidDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(toFiniteNumber(value, 0) * factor) / factor;
}

function normalizeDays(value) {
  const parsed = Math.floor(toFiniteNumber(value, DEFAULT_DAYS));
  return parsed > 0 ? parsed : DEFAULT_DAYS;
}

function normalizeDayOfWeek(value) {
  const parsed = Math.floor(toFiniteNumber(value, 0));
  if (parsed < 0 || parsed > 6) return 0;
  return parsed;
}

function normalizeHourUtc(value) {
  const parsed = Math.floor(toFiniteNumber(value, 9));
  if (parsed < 0 || parsed > 23) return 9;
  return parsed;
}

function buildWindow({ now = new Date(), days = DEFAULT_DAYS } = {}) {
  const safeNow = toValidDate(now, new Date());
  const safeDays = normalizeDays(days);
  const start = new Date(safeNow.getTime() - safeDays * DAY_MS);
  return { now: safeNow, days: safeDays, start };
}

function isWithinWindow(timestamp, windowStart, windowEnd) {
  if (!timestamp) return true;
  const ts = Date.parse(String(timestamp));
  if (!Number.isFinite(ts)) return true;
  return ts >= windowStart.getTime() && ts <= windowEnd.getTime();
}

async function loadJsonLines(path) {
  const raw = await readFile(path, "utf8");
  const entries = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Keep report generation resilient if one line is malformed.
    }
  }
  return entries;
}

async function defaultLoadMetrics() {
  const repoRoot = resolveRepoRoot();
  const logPath = resolve(repoRoot, ".cache", "agent-work-logs", "agent-metrics.jsonl");
  return loadJsonLines(logPath);
}

async function defaultLoadErrors() {
  const repoRoot = resolveRepoRoot();
  const logPath = resolve(repoRoot, ".cache", "agent-work-logs", "agent-errors.jsonl");
  return loadJsonLines(logPath);
}

export function buildWeeklyAgentWorkSummary({
  metrics = [],
  errors = [],
  now = new Date(),
  days = DEFAULT_DAYS,
} = {}) {
  const { now: safeNow, days: safeDays, start } = buildWindow({ now, days });
  const safeMetrics = Array.isArray(metrics) ? metrics : [];
  const safeErrors = Array.isArray(errors) ? errors : [];

  const filteredMetrics = safeMetrics.filter((entry) =>
    isWithinWindow(entry?.timestamp, start, safeNow)
  );
  const filteredErrors = safeErrors.filter((entry) =>
    isWithinWindow(entry?.timestamp, start, safeNow)
  );

  let completedSessions = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let totalErrors = 0;
  const executors = new Map();

  for (const entry of filteredMetrics) {
    const status = String(entry?.outcome?.status || "").toLowerCase();
    const isCompleted = status === "completed" || entry?.metrics?.success === true;
    if (isCompleted) completedSessions += 1;

    totalCostUsd += toFiniteNumber(entry?.metrics?.cost_usd, 0);
    totalDurationMs += toFiniteNumber(entry?.metrics?.duration_ms, 0);
    totalErrors += toFiniteNumber(entry?.error_summary?.total_errors, 0);

    const executor = String(entry?.executor || "unknown").trim() || "unknown";
    const row = executors.get(executor) || {
      executor,
      sessions: 0,
      completedSessions: 0,
    };
    row.sessions += 1;
    if (isCompleted) row.completedSessions += 1;
    executors.set(executor, row);
  }

  const totalSessions = filteredMetrics.length;
  const successRatePct =
    totalSessions > 0 ? round((completedSessions / totalSessions) * 100, 2) : 0;

  const executorBreakdown = [...executors.values()]
    .map((row) => ({
      ...row,
      successRatePct:
        row.sessions > 0 ? round((row.completedSessions / row.sessions) * 100, 2) : 0,
    }))
    .sort((a, b) => {
      if (b.sessions !== a.sessions) return b.sessions - a.sessions;
      return a.executor.localeCompare(b.executor);
    });

  const fingerprintCounts = new Map();
  for (const entry of filteredErrors) {
    const fingerprint =
      String(
        entry?.data?.error_fingerprint ||
          entry?.error_fingerprint ||
          entry?.data?.error_message ||
          "unknown",
      ).trim() || "unknown";
    fingerprintCounts.set(fingerprint, (fingerprintCounts.get(fingerprint) || 0) + 1);
  }
  const topErrorFingerprints = [...fingerprintCounts.entries()]
    .map(([fingerprint, count]) => ({ fingerprint, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.fingerprint.localeCompare(b.fingerprint);
    })
    .slice(0, 10);

  return {
    period: {
      days: safeDays,
      startIso: start.toISOString(),
      endIso: safeNow.toISOString(),
      generatedAtIso: safeNow.toISOString(),
    },
    totals: {
      totalSessions,
      completedSessions,
      successRatePct,
      totalCostUsd: round(totalCostUsd, 2),
      totalErrors,
      totalDurationMinutes: Math.round(totalDurationMs / 60000),
    },
    topErrorFingerprints,
    executorBreakdown,
  };
}

// Backwards-compatible alias used by some tests/integrations.
export const buildWeeklyAgentWorkReport = buildWeeklyAgentWorkSummary;

export function formatWeeklyAgentWorkReport(summary) {
  const totals = summary?.totals || {};
  const period = summary?.period || {};
  const topErrors = Array.isArray(summary?.topErrorFingerprints)
    ? summary.topErrorFingerprints
    : [];
  const executors = Array.isArray(summary?.executorBreakdown)
    ? summary.executorBreakdown
    : [];

  const lines = [
    "Weekly Agent Work Report",
    `Window: ${period.startIso || "n/a"} -> ${period.endIso || "n/a"} (${period.days || DEFAULT_DAYS}d)`,
    "",
    `Total Sessions: ${toFiniteNumber(totals.totalSessions, 0)}`,
    `Completed Sessions: ${toFiniteNumber(totals.completedSessions, 0)}`,
    `Success Rate: ${round(totals.successRatePct, 2)}%`,
    `Total Cost: $${round(totals.totalCostUsd, 2).toFixed(2)}`,
    `Total Errors: ${toFiniteNumber(totals.totalErrors, 0)}`,
    `Total Duration: ${toFiniteNumber(totals.totalDurationMinutes, 0)} minutes`,
  ];

  if (toFiniteNumber(totals.totalSessions, 0) === 0) {
    lines.push("", "No agent work data found for this window.");
  }

  lines.push("", "Top Errors:");
  if (topErrors.length === 0) {
    lines.push("- none");
  } else {
    for (const row of topErrors) {
      lines.push(`- ${row.fingerprint}: ${toFiniteNumber(row.count, 0)}`);
    }
  }

  lines.push("", "Executor Breakdown:");
  if (executors.length === 0) {
    lines.push("- none");
  } else {
    for (const row of executors) {
      lines.push(
        `- ${row.executor}: ${toFiniteNumber(row.completedSessions, 0)}/${toFiniteNumber(row.sessions, 0)} completed (${round(row.successRatePct, 2)}%)`,
      );
    }
  }

  return lines.join("\n");
}

export async function generateWeeklyAgentWorkReport(options = {}) {
  const now = toValidDate(options.now, new Date());
  const days = normalizeDays(options.days);
  const loadMetrics =
    typeof options.loadMetrics === "function" ? options.loadMetrics : defaultLoadMetrics;
  const loadErrors =
    typeof options.loadErrors === "function" ? options.loadErrors : defaultLoadErrors;
  const warnings = [];

  let metrics = [];
  let errors = [];

  try {
    const loadedMetrics = await loadMetrics({ now, days });
    metrics = Array.isArray(loadedMetrics) ? loadedMetrics : [];
    if (!Array.isArray(loadedMetrics)) {
      warnings.push("Metrics loader returned non-array data; using empty metrics.");
    }
  } catch (err) {
    warnings.push(`Metrics load failed: ${err?.message || err}`);
  }

  try {
    const loadedErrors = await loadErrors({ now, days });
    errors = Array.isArray(loadedErrors) ? loadedErrors : [];
    if (!Array.isArray(loadedErrors)) {
      warnings.push("Errors loader returned non-array data; using empty errors.");
    }
  } catch (err) {
    warnings.push(`Errors load failed: ${err?.message || err}`);
  }

  const summary = buildWeeklyAgentWorkSummary({ metrics, errors, now, days });
  let text = formatWeeklyAgentWorkReport(summary);
  if (warnings.length > 0) {
    text += `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
  }

  return { summary, text, warnings };
}

export function getNextWeeklyReportTime({
  now = new Date(),
  dayOfWeek = 0,
  hourUtc = 9,
} = {}) {
  const safeNow = toValidDate(now, new Date());
  const safeDayOfWeek = normalizeDayOfWeek(dayOfWeek);
  const safeHourUtc = normalizeHourUtc(hourUtc);
  const next = new Date(
    Date.UTC(
      safeNow.getUTCFullYear(),
      safeNow.getUTCMonth(),
      safeNow.getUTCDate(),
      safeHourUtc,
      0,
      0,
      0,
    ),
  );
  const delta = (safeDayOfWeek - safeNow.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + delta);
  if (next.getTime() <= safeNow.getTime()) {
    next.setUTCDate(next.getUTCDate() + 7);
  }
  return next;
}

function getScheduledTimeForCurrentWeek({
  now = new Date(),
  dayOfWeek = 0,
  hourUtc = 9,
} = {}) {
  const safeNow = toValidDate(now, new Date());
  const safeDayOfWeek = normalizeDayOfWeek(dayOfWeek);
  const safeHourUtc = normalizeHourUtc(hourUtc);
  const scheduled = new Date(
    Date.UTC(
      safeNow.getUTCFullYear(),
      safeNow.getUTCMonth(),
      safeNow.getUTCDate(),
      safeHourUtc,
      0,
      0,
      0,
    ),
  );
  const dayDelta = safeDayOfWeek - safeNow.getUTCDay();
  scheduled.setUTCDate(scheduled.getUTCDate() + dayDelta);
  return scheduled;
}

export function shouldSendWeeklyReport({
  now = new Date(),
  dayOfWeek = 0,
  hourUtc = 9,
  lastSentAt = null,
} = {}) {
  const safeNow = toValidDate(now, new Date());
  const scheduled = getScheduledTimeForCurrentWeek({
    now: safeNow,
    dayOfWeek,
    hourUtc,
  });
  if (safeNow.getTime() < scheduled.getTime()) return false;

  if (!lastSentAt) return true;
  const lastSentDate = toValidDate(lastSentAt, null);
  if (!lastSentDate || !Number.isFinite(lastSentDate.getTime())) return true;
  return lastSentDate.getTime() < scheduled.getTime();
}
