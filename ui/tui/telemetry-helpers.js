const SPARKLINE_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const PROVIDER_ORDER = ["claude", "codex", "gemini", "copilot"];
const FUNNEL_ORDER = ["todo", "in_progress", "review", "done", "failed"];

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampNonNegative(value) {
  return Math.max(0, asNumber(value, 0));
}

function normalizeProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value.includes("claude")) return "claude";
  if (value.includes("codex") || value.includes("openai")) return "codex";
  if (value.includes("gemini")) return "gemini";
  if (value.includes("copilot") || value.includes("github")) return "copilot";
  return value;
}

export function renderSparkline(values = []) {
  const list = Array.isArray(values) ? values.map((value) => clampNonNegative(value)) : [];
  if (!list.length) return "";
  const max = Math.max(...list, 0);
  if (max <= 0) return SPARKLINE_BLOCKS[0].repeat(list.length);
  return list.map((value) => {
    const index = Math.min(
      SPARKLINE_BLOCKS.length - 1,
      Math.max(0, Math.round((value / max) * (SPARKLINE_BLOCKS.length - 1))),
    );
    return SPARKLINE_BLOCKS[index];
  }).join("");
}

export function buildProviderStats(sessions = [], rates = {}) {
  const stats = new Map();
  for (const provider of PROVIDER_ORDER) {
    stats.set(provider, {
      provider,
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      avgSessionLengthSeconds: 0,
      errorCount: 0,
      sessionLengthTotalSeconds: 0,
    });
  }

  for (const session of Array.isArray(sessions) ? sessions : []) {
    const provider = normalizeProvider(session?.provider || session?.executor || session?.type);
    if (!stats.has(provider)) {
      stats.set(provider, {
        provider,
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        avgSessionLengthSeconds: 0,
        errorCount: 0,
        sessionLengthTotalSeconds: 0,
      });
    }
    const row = stats.get(provider);
    const inputTokens = clampNonNegative(session?.inputTokens);
    const outputTokens = clampNonNegative(session?.outputTokens);
    const totalTokens = clampNonNegative(session?.totalTokens || inputTokens + outputTokens);
    const errorCount = clampNonNegative(session?.errorCount || session?.errors);
    const startedAt = session?.startedAt ? new Date(session.startedAt).getTime() : null;
    const endedAt = session?.endedAt ? new Date(session.endedAt).getTime() : null;
    const lastActiveAt = session?.lastActiveAt ? new Date(session.lastActiveAt).getTime() : null;
    const referenceEnd = endedAt || lastActiveAt || Date.now();
    const durationSeconds = startedAt && Number.isFinite(referenceEnd)
      ? Math.max(0, Math.round((referenceEnd - startedAt) / 1000))
      : clampNonNegative(session?.durationSeconds || session?.durationMs / 1000);
    const rate = asNumber(rates?.[provider], 0);

    row.sessions += 1;
    row.inputTokens += inputTokens;
    row.outputTokens += outputTokens;
    row.totalTokens += totalTokens;
    row.errorCount += errorCount;
    row.sessionLengthTotalSeconds += durationSeconds;
    row.estimatedCostUsd += rate > 0 ? (totalTokens / 1000) * rate : 0;
  }

  return Array.from(stats.values()).map((row) => ({
    ...row,
    avgSessionLengthSeconds: row.sessions > 0 ? row.sessionLengthTotalSeconds / row.sessions : 0,
  }));
}

export function buildFunnel(tasks = []) {
  const counts = Object.fromEntries(FUNNEL_ORDER.map((key) => [key, 0]));
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = String(task?.status || "todo").trim().toLowerCase();
    if (counts[status] != null) counts[status] += 1;
  }

  const base = counts.todo || 0;
  return FUNNEL_ORDER.map((status) => {
    const count = counts[status] || 0;
    const percent = base > 0 ? (count / base) * 100 : 0;
    return { status, count, percent };
  });
}

export function buildRateLimitHours(rateLimitHistory = [], now = new Date(), mutedColor = "gray", warnColor = "yellow", hotColor = "red") {
  const dayHours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const currentHour = now.getHours();
  for (const entry of Array.isArray(rateLimitHistory) ? rateLimitHistory : []) {
    const timestamp = new Date(entry?.timestamp || Date.now());
    if (
      timestamp.getFullYear() !== now.getFullYear()
      || timestamp.getMonth() !== now.getMonth()
      || timestamp.getDate() !== now.getDate()
    ) {
      continue;
    }
    const hour = timestamp.getHours();
    if (hour >= 0 && hour < 24) dayHours[hour].count += clampNonNegative(entry?.count || 1);
  }

  return dayHours.map((slot) => ({
    ...slot,
    currentHour: slot.hour === currentHour,
    color: slot.count <= 0 ? mutedColor : (slot.count >= 3 ? hotColor : warnColor),
    label: slot.count > 0 ? String(slot.count).padStart(2, " ") : "··",
  }));
}

export function deriveTelemetrySnapshot({ stats, sessions, tasks, logs, now = Date.now() }) {
  const recentLogs = Array.isArray(logs) ? logs : [];
  const providerStats = buildProviderStats(sessions, stats?.costPer1kTokensUsd || {});
  const totalErrors = recentLogs.filter((entry) => /error|fail/i.test(String(entry?.level || ""))).length;
  const retryCount = recentLogs.filter((entry) => /retry/i.test(String(entry?.line || entry?.raw || ""))).length;
  const rateLimitEvents = recentLogs.filter((entry) => /429|rate limit/i.test(String(entry?.line || entry?.raw || ""))).map((entry) => ({
    timestamp: entry?.timestamp || now,
    count: 1,
  }));

  return {
    timestamp: now,
    throughput: clampNonNegative(stats?.throughputTps),
    tokenTotal: clampNonNegative(stats?.tokensTotal || stats?.totalTokens),
    errors: totalErrors,
    retries: retryCount,
    providerStats,
    funnel: buildFunnel(tasks),
    rateLimitEvents,
    sessionCostUsd: providerStats.reduce((sum, row) => sum + row.estimatedCostUsd, 0),
  };
}
