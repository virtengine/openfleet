import { classifyComplexity } from "./task-complexity.mjs";

export function normalizeTimestamp(value) {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

export function normalizeErrorFingerprint(message) {
  const text = String(message || "unknown").trim().toLowerCase();
  if (!text) return "unknown";
  return text
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function groupBy(array, keyFn) {
  const groups = {};
  for (const item of array) {
    const key = typeof keyFn === "function" ? keyFn(item) : item[keyFn];
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function average(numbers) {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function incrementCounter(target, key) {
  const resolved = key || "unknown";
  target[resolved] = (target[resolved] || 0) + 1;
}

function resolveKnownValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text) continue;
    if (text.toLowerCase() === "unknown") continue;
    return text;
  }
  return "unknown";
}

function buildDistribution(counts, total) {
  return Object.entries(counts)
    .map(([label, count]) => ({
      label,
      count,
      percent: total > 0 ? (count * 100.0) / total : 0,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const SIZE_LABEL_PATTERN = /\[(xs|s|m|l|xl|xxl|2xl)\]/i;

function extractSizeLabelFromTitle(title) {
  const text = String(title || "");
  const match = text.match(SIZE_LABEL_PATTERN);
  if (!match) return "unknown";
  const label = match[1].toLowerCase();
  return label === "2xl" ? "xxl" : label;
}

function classifyComplexityBucket({ sizeLabel, title, description }) {
  if (!description) return "unknown";
  const normalizedSize = sizeLabel && sizeLabel !== "unknown" ? sizeLabel : null;
  const result = classifyComplexity({
    sizeLabel: normalizedSize,
    title: title || "",
    description: description || "",
  });
  return result?.tier || "unknown";
}

function resolveNowTimestamp(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  if (typeof now === "string") {
    const parsed = normalizeTimestamp(now);
    if (parsed !== null) return parsed;
  }
  return Date.now();
}

export function filterRecordsByWindow(
  records,
  { days, now, timestampKey = "timestamp" } = {},
) {
  if (!Array.isArray(records)) return [];
  const windowDays = Number.isFinite(days) && days > 0 ? days : null;
  if (!windowDays) return [...records];
  const cutoff = resolveNowTimestamp(now) - windowDays * 24 * 60 * 60 * 1000;
  return records.filter((record) => {
    const ts = normalizeTimestamp(record?.[timestampKey]);
    if (ts === null) return true;
    return ts >= cutoff;
  });
}

export function buildErrorClusters(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return [];

  const byFingerprint = groupBy(
    errors,
    (e) =>
      e.data?.error_fingerprint ||
      normalizeErrorFingerprint(e.data?.error_message),
  );

  return Object.entries(byFingerprint)
    .map(([fingerprint, events]) => ({
      fingerprint,
      count: events.length,
      affected_tasks: new Set(events.map((e) => e.task_id)).size,
      affected_attempts: new Set(events.map((e) => e.attempt_id)).size,
      first_seen: events[0].timestamp,
      last_seen: events[events.length - 1].timestamp,
      sample_message: events[0].data?.error_message || "",
      categories: [
        ...new Set(events.map((e) => e.data?.error_category).filter(Boolean)),
      ],
    }))
    .sort((a, b) => b.count - a.count);
}

function buildTaskProfiles(metrics, errors) {
  const taskProfiles = new Map();
  const ensureTaskProfile = (taskId) => {
    const key = taskId || "unknown";
    if (!taskProfiles.has(key)) {
      taskProfiles.set(key, {
        task_id: key,
        task_title: "",
        task_description: "",
        executor: "unknown",
        model: "unknown",
        durations: [],
      });
    }
    return taskProfiles.get(key);
  };

  for (const metric of metrics) {
    const profile = ensureTaskProfile(metric.task_id || "unknown");
    if (metric.task_title && !profile.task_title) {
      profile.task_title = metric.task_title;
    }
    if (metric.task_description && !profile.task_description) {
      profile.task_description = metric.task_description;
    }
    if (metric.executor && profile.executor === "unknown") {
      profile.executor = metric.executor;
    }
    if (metric.model && profile.model === "unknown") {
      profile.model = metric.model;
    }
    if (metric.metrics?.duration_ms) {
      profile.durations.push(metric.metrics.duration_ms);
    }
  }

  for (const error of errors) {
    const profile = ensureTaskProfile(error.task_id || "unknown");
    if (error.task_title && !profile.task_title) {
      profile.task_title = error.task_title;
    }
    if (error.task_description && !profile.task_description) {
      profile.task_description = error.task_description;
    }
    if (error.executor && profile.executor === "unknown") {
      profile.executor = error.executor;
    }
    if (error.model && profile.model === "unknown") {
      profile.model = error.model;
    }
  }

  for (const profile of taskProfiles.values()) {
    profile.size_label = extractSizeLabelFromTitle(profile.task_title);
    profile.complexity = classifyComplexityBucket({
      sizeLabel: profile.size_label,
      title: profile.task_title,
      description: profile.task_description,
    });
    profile.avg_duration_ms =
      profile.durations.length > 0 ? average(profile.durations) : 0;
  }

  return taskProfiles;
}

function buildErrorCorrelationEntries(errors, taskProfiles) {
  const correlations = new Map();
  const ensureCorrelation = (fingerprint) => {
    if (!correlations.has(fingerprint)) {
      correlations.set(fingerprint, {
        fingerprint,
        count: 0,
        task_ids: new Set(),
        by_executor: {},
        by_size: {},
        by_complexity: {},
        sample_message: "",
        first_seen_ts: null,
        last_seen_ts: null,
      });
    }
    return correlations.get(fingerprint);
  };

  for (const error of errors) {
    const fingerprint =
      error.data?.error_fingerprint ||
      normalizeErrorFingerprint(error.data?.error_message);
    const entry = ensureCorrelation(fingerprint);
    entry.count += 1;
    entry.task_ids.add(error.task_id || "unknown");
    if (!entry.sample_message && error.data?.error_message) {
      entry.sample_message = error.data.error_message;
    }

    const timestamp = normalizeTimestamp(error.timestamp);
    if (timestamp !== null) {
      if (!entry.first_seen_ts || timestamp < entry.first_seen_ts) {
        entry.first_seen_ts = timestamp;
      }
      if (!entry.last_seen_ts || timestamp > entry.last_seen_ts) {
        entry.last_seen_ts = timestamp;
      }
    }

    const profile = taskProfiles.get(error.task_id || "unknown");
    const sizeLabel = resolveKnownValue(
      profile?.size_label,
      extractSizeLabelFromTitle(error.task_title),
    );
    const executor = resolveKnownValue(profile?.executor, error.executor);
    const complexity = resolveKnownValue(profile?.complexity);

    incrementCounter(entry.by_size, sizeLabel);
    incrementCounter(entry.by_executor, executor);
    incrementCounter(entry.by_complexity, complexity);
  }

  return correlations;
}

export function buildErrorCorrelationSummary({
  errors = [],
  metrics = [],
  windowDays = 7,
  top = 10,
} = {}) {
  const windowDaysResolved =
    Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 7;
  const topLimit = Number.isFinite(top) && top > 0 ? top : 10;
  const errorList = Array.isArray(errors) ? errors : [];
  const metricList = Array.isArray(metrics) ? metrics : [];

  const taskProfiles = buildTaskProfiles(metricList, errorList);
  const correlations = buildErrorCorrelationEntries(errorList, taskProfiles);
  const sorted = [...correlations.values()].sort((a, b) => b.count - a.count);
  const topEntries = sorted.slice(0, topLimit);

  return {
    window_days: windowDaysResolved,
    total_errors: errorList.length,
    total_fingerprints: correlations.size,
    top: topLimit,
    correlations: topEntries,
  };
}

export function buildErrorCorrelationJsonPayload(summary, { now } = {}) {
  const safeSummary = summary && typeof summary === "object" ? summary : null;
  const correlations = Array.isArray(safeSummary?.correlations)
    ? safeSummary.correlations
    : [];
  const generatedAt = new Date(resolveNowTimestamp(now)).toISOString();

  return {
    generated_at: generatedAt,
    window_days: safeSummary?.window_days ?? 7,
    total_errors: safeSummary?.total_errors ?? 0,
    total_fingerprints: safeSummary?.total_fingerprints ?? 0,
    top: safeSummary?.top ?? correlations.length,
    correlations: correlations.map((entry) => ({
      fingerprint: entry.fingerprint,
      count: entry.count,
      task_count: entry.task_ids?.size || 0,
      sample_message: entry.sample_message,
      first_seen: entry.first_seen_ts
        ? new Date(entry.first_seen_ts).toISOString()
        : null,
      last_seen: entry.last_seen_ts
        ? new Date(entry.last_seen_ts).toISOString()
        : null,
      by_executor: buildDistribution(entry.by_executor, entry.count),
      by_size: buildDistribution(entry.by_size, entry.count),
      by_complexity: buildDistribution(entry.by_complexity, entry.count),
    })),
  };
}
