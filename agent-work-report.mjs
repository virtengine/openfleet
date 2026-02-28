import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveRepoRoot } from "./repo-root.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const DEFAULT_DAY_OF_WEEK = 0; // Sunday (UTC)
const DEFAULT_HOUR_UTC = 9;

function toSafeDate(input) {
  if (input instanceof Date && Number.isFinite(input.getTime())) return input;
  const parsed = new Date(input || Date.now());
  if (Number.isFinite(parsed.getTime())) return parsed;
  return new Date();
}

function toBoundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.trunc(n);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function toPositiveDays(value, fallback = DEFAULT_DAYS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.trunc(n));
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((toNumber(value, 0) + Number.EPSILON) * factor) / factor;
}

function formatPercent(value) {
  const n = toNumber(value, 0);
  if (Number.isInteger(n)) return String(n);
  return String(roundTo(n, 2)).replace(/\.?0+$/, "");
}

function normalizeExecutor(value) {
  const trimmed = String(value || "").trim();
  return trimmed || "unknown";
}

function normalizeFingerprint(value) {
  const trimmed = String(value || "").trim();
  return trimmed || "unknown";
}

function inWindow(entryTimestamp, startMs, endMs) {
  const ts = Date.parse(String(entryTimestamp || ""));
  if (!Number.isFinite(ts)) return true;
  return ts >= startMs && ts <= endMs;
}

async function readJsonlFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw) return [];
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Ignore invalid lines so one bad line does not break report generation.
      }
    }
    return rows;
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

function defaultLogPaths() {
  const repoRoot = resolveRepoRoot();
  const logDir = resolve(repoRoot, ".cache", "agent-work-logs");
  return {
    metricsPath: resolve(logDir, "agent-metrics.jsonl"),
    errorsPath: resolve(logDir, "agent-errors.jsonl"),
  };
}

async function defaultLoadMetrics() {
  const { metricsPath } = defaultLogPaths();
  return await readJsonlFile(metricsPath);
}

async function defaultLoadErrors() {
  const { errorsPath } = defaultLogPaths();
  return await readJsonlFile(errorsPath);
}

export function buildWeeklyAgentWorkSummary(options = {}) {
  const now = toSafeDate(options.now);
  const days = toPositiveDays(options.days, DEFAULT_DAYS);
  const metricsInput = Array.isArray(options.metrics) ? options.metrics : [];
  const errorsInput = Array.isArray(options.errors) ? options.errors : [];

  const endMs = now.getTime();
  const startMs = endMs - days * DAY_MS;

  const metrics = metricsInput.filter((entry) =>
    inWindow(entry?.timestamp, startMs, endMs),
  );
  const errors = errorsInput.filter((entry) =>
    inWindow(entry?.timestamp || entry?.data?.timestamp, startMs, endMs),
  );

  const totalSessions = metrics.length;
  const completedSessions = metrics.filter(
    (entry) =>
      entry?.outcome?.status === "completed" ||
      entry?.metrics?.success === true,
  ).length;
  const successRatePct =
    totalSessions > 0 ? roundTo((completedSessions * 100) / totalSessions, 2) : 0;
  const totalCostUsd = roundTo(
    metrics.reduce((sum, entry) => sum + toNumber(entry?.metrics?.cost_usd, 0), 0),
    2,
  );
  const totalErrors = metrics.reduce(
    (sum, entry) => sum + toNumber(entry?.error_summary?.total_errors, 0),
    0,
  );
  const totalDurationMinutes = Math.round(
    metrics.reduce((sum, entry) => sum + toNumber(entry?.metrics?.duration_ms, 0), 0) /
      60000,
  );

  const byFingerprint = new Map();
  for (const entry of errors) {
    const fingerprint = normalizeFingerprint(entry?.data?.error_fingerprint);
    byFingerprint.set(fingerprint, (byFingerprint.get(fingerprint) || 0) + 1);
  }
  const topErrorFingerprints = [...byFingerprint.entries()]
    .map(([fingerprint, count]) => ({ fingerprint, count }))
    .sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));

  const byExecutor = new Map();
  for (const entry of metrics) {
    const executor = normalizeExecutor(entry?.executor);
    const current = byExecutor.get(executor) || {
      executor,
      sessions: 0,
      completedSessions: 0,
      successRatePct: 0,
    };
    current.sessions += 1;
    if (
      entry?.outcome?.status === "completed" ||
      entry?.metrics?.success === true
    ) {
      current.completedSessions += 1;
    }
    byExecutor.set(executor, current);
  }
  const executorBreakdown = [...byExecutor.values()]
    .map((row) => ({
      ...row,
      successRatePct:
        row.sessions > 0 ? roundTo((row.completedSessions * 100) / row.sessions, 2) : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.executor.localeCompare(b.executor));

  return {
    period: {
      days,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      generatedAtIso: now.toISOString(),
    },
    totals: {
      totalSessions,
      completedSessions,
      successRatePct,
      totalCostUsd,
      totalErrors,
      totalDurationMinutes,
    },
    topErrorFingerprints,
    executorBreakdown,
  };
}

export const buildWeeklyAgentWorkReport = buildWeeklyAgentWorkSummary;

export function formatWeeklyAgentWorkReport(summary) {
  const safeSummary =
    summary && typeof summary === "object"
      ? summary
      : buildWeeklyAgentWorkSummary({ metrics: [], errors: [] });
  const totals = safeSummary.totals || {};
  const lines = [
    ":chart: Weekly Agent Work Report",
    `Period: ${safeSummary.period?.startIso || "n/a"} → ${safeSummary.period?.endIso || "n/a"}`,
    `Generated: ${safeSummary.period?.generatedAtIso || new Date().toISOString()}`,
    "",
    "Overall Metrics",
    `Total Sessions: ${toNumber(totals.totalSessions, 0)}`,
    `Completed Sessions: ${toNumber(totals.completedSessions, 0)}`,
    `Success Rate: ${formatPercent(totals.successRatePct)}%`,
    `Total Cost: $${roundTo(totals.totalCostUsd, 2).toFixed(2)}`,
    `Total Errors: ${toNumber(totals.totalErrors, 0)}`,
    `Total Duration: ${toNumber(totals.totalDurationMinutes, 0)} minutes`,
    "",
    "Top Errors",
  ];

  if (toNumber(totals.totalSessions, 0) === 0) {
    lines.push("No agent work data found for this period.");
  }

  if (Array.isArray(safeSummary.topErrorFingerprints) &&
      safeSummary.topErrorFingerprints.length > 0) {
    for (const row of safeSummary.topErrorFingerprints.slice(0, 5)) {
      lines.push(`- ${row.fingerprint}: ${row.count}`);
    }
  } else {
    lines.push("- none");
  }

  lines.push("", "Executor Breakdown");
  if (Array.isArray(safeSummary.executorBreakdown) &&
      safeSummary.executorBreakdown.length > 0) {
    for (const row of safeSummary.executorBreakdown) {
      lines.push(
        `- ${row.executor}: ${row.sessions} sessions, ${row.completedSessions} completed (${formatPercent(row.successRatePct)}%)`,
      );
    }
  } else {
    lines.push("- none");
  }

  return lines.join("\n");
}

export async function generateWeeklyAgentWorkReport(options = {}) {
  const warnings = [];
  const now = toSafeDate(options.now);
  const days = toPositiveDays(options.days, DEFAULT_DAYS);
  const metricsLoader =
    typeof options.loadMetrics === "function" ? options.loadMetrics : defaultLoadMetrics;
  const errorsLoader =
    typeof options.loadErrors === "function" ? options.loadErrors : defaultLoadErrors;

  let metrics = [];
  let errors = [];

  try {
    const loaded = await metricsLoader({ now, days });
    metrics = Array.isArray(loaded) ? loaded : [];
    if (!Array.isArray(loaded)) {
      warnings.push("metrics loader returned a non-array value");
    }
  } catch (err) {
    warnings.push(`metrics loader failed: ${err?.message || err}`);
    metrics = [];
  }

  try {
    const loaded = await errorsLoader({ now, days });
    errors = Array.isArray(loaded) ? loaded : [];
    if (!Array.isArray(loaded)) {
      warnings.push("errors loader returned a non-array value");
    }
  } catch (err) {
    warnings.push(`errors loader failed: ${err?.message || err}`);
    errors = [];
  }

  const summary = buildWeeklyAgentWorkSummary({
    metrics,
    errors,
    now,
    days,
  });
  const text = formatWeeklyAgentWorkReport(summary);

  return {
    summary,
    text,
    warnings,
  };
}

export function getNextWeeklyReportTime(options = {}) {
  const now = toSafeDate(options.now);
  const dayOfWeek = toBoundedInt(
    options.dayOfWeek,
    DEFAULT_DAY_OF_WEEK,
    0,
    6,
  );
  const hourUtc = toBoundedInt(options.hourUtc, DEFAULT_HOUR_UTC, 0, 23);

  const target = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  const deltaDays = (dayOfWeek - now.getUTCDay() + 7) % 7;
  target.setUTCDate(target.getUTCDate() + deltaDays);
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 7);
  }
  return target;
}

export function shouldSendWeeklyReport(options = {}) {
  const now = toSafeDate(options.now);
  const dayOfWeek = toBoundedInt(
    options.dayOfWeek,
    DEFAULT_DAY_OF_WEEK,
    0,
    6,
  );
  const hourUtc = toBoundedInt(options.hourUtc, DEFAULT_HOUR_UTC, 0, 23);
  const lastSentAt = options.lastSentAt;

  const scheduledThisWeek = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  scheduledThisWeek.setUTCDate(
    scheduledThisWeek.getUTCDate() + (dayOfWeek - now.getUTCDay()),
  );

  if (now.getTime() < scheduledThisWeek.getTime()) {
    return false;
  }

  if (!lastSentAt) {
    return true;
  }
  const lastSentMs = Date.parse(String(lastSentAt));
  if (!Number.isFinite(lastSentMs)) {
    return true;
  }
  return lastSentMs < scheduledThisWeek.getTime();
}
