const DEFAULT_COST_PER_1K_TOKENS_USD = Object.freeze({
  claude: 0.003,
  codex: 0.002,
  gemini: 0.0001,
  copilot: 0,
});

const PROVIDER_ORDER = ["claude", "codex", "gemini", "copilot"];
const FUNNEL_ORDER = [
  { key: "todo", label: "todo" },
  { key: "in_progress", label: "in_progress" },
  { key: "review", label: "review" },
  { key: "done", label: "done" },
  { key: "failed", label: "failed" },
];

import { renderSparkline } from "../lib/sparkline.mjs";

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeProviderKey(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (["openai", "codex"].includes(value)) return "codex";
  if (["anthropic", "claude"].includes(value)) return "claude";
  return value;
}

function trimSeries(values = [], limit = 60) {
  return Array.isArray(values) ? values.slice(-limit) : [];
}

export function renderTelemetrySparkline(values = []) {
  return renderSparkline(trimSeries(values, 60));
}

export function normalizeTelemetryRateMap(rateMap = {}) {
  const normalized = { ...DEFAULT_COST_PER_1K_TOKENS_USD };
  for (const [provider, rate] of Object.entries(rateMap || {})) {
    const key = normalizeProviderKey(provider);
    const numeric = Number(rate);
    normalized[key] = Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }
  return normalized;
}

export function estimateProviderCost({ totalTokens = 0, ratePer1k = 0 } = {}) {
  const tokens = Math.max(0, toNumber(totalTokens, 0));
  const rate = toNumber(ratePer1k, 0);
  if (rate <= 0 || tokens <= 0) return 0;
  return (tokens / 1000) * rate;
}

function formatDurationSeconds(totalSeconds = 0) {
  const rounded = Math.max(0, Math.round(toNumber(totalSeconds, 0)));
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function buildProviderUsageRows({ providers = {}, rateMap = {} } = {}) {
  const normalizedRates = normalizeTelemetryRateMap(rateMap);
  const rows = PROVIDER_ORDER.map((provider) => {
    const data = providers?.[provider] || providers?.[normalizeProviderKey(provider)] || {};
    const sessions = Math.max(0, toNumber(data.sessions, 0));
    const tokensIn = Math.max(0, toNumber(data.tokensIn, 0));
    const tokensOut = Math.max(0, toNumber(data.tokensOut, 0));
    const totalTokens = tokensIn + tokensOut;
    return {
      provider,
      sessions,
      tokensIn,
      tokensOut,
      totalTokens,
      avgSessionLengthSec: Math.max(0, toNumber(data.avgSessionLengthSec, 0)),
      avgSessionLengthLabel: formatDurationSeconds(data.avgSessionLengthSec),
      errorCount: Math.max(0, toNumber(data.errorCount, 0)),
      costRatePer1kUsd: normalizedRates[provider] ?? 0,
      costEstimateUsd: estimateProviderCost({ totalTokens, ratePer1k: normalizedRates[provider] }),
      dayTokensIn: Math.max(0, toNumber(data.dayTokensIn, tokensIn)),
      dayTokensOut: Math.max(0, toNumber(data.dayTokensOut, tokensOut)),
      highlight: null,
    };
  }).sort((left, right) => right.totalTokens - left.totalTokens || right.sessions - left.sessions || left.provider.localeCompare(right.provider));

  if (rows.length && rows[0].totalTokens > 0) {
    rows[0].highlight = "cyan";
  }
  return rows;
}

export function buildRateLimitHeatmap({ hourly429s = [], currentHour = (new Date()).getHours() } = {}) {
  return Array.from({ length: 24 }, (_, hour) => {
    const count = Math.max(0, toNumber(hourly429s?.[hour], 0));
    const tone = count <= 0 ? "dim" : count >= 3 ? "red" : "yellow";
    return {
      hour,
      count,
      tone,
      label: count <= 0 ? "no data" : String(count),
      isCurrentHour: hour === currentHour,
    };
  });
}

export function buildTaskFunnel({ todo = 0, inProgress = 0, review = 0, done = 0, failed = 0 } = {}) {
  const counts = {
    todo: Math.max(0, toNumber(todo, 0)),
    in_progress: Math.max(0, toNumber(inProgress, 0)),
    review: Math.max(0, toNumber(review, 0)),
    done: Math.max(0, toNumber(done, 0)),
    failed: Math.max(0, toNumber(failed, 0)),
  };
  const base = counts.todo;
  return {
    stages: FUNNEL_ORDER.map((stage) => ({
      ...stage,
      count: counts[stage.key],
      conversionPct: base === 0 ? 0 : Math.round((counts[stage.key] / base) * 100),
    })),
  };
}

export function buildTelemetryModel({ stats = {}, config = {}, currentHour = (new Date()).getHours() } = {}) {
  const telemetry = stats?.telemetry || {};
  const rateMap = normalizeTelemetryRateMap(config?.telemetry?.costPer1kTokensUsd || config?.telemetry?.costPer1kTokens || {});
  const providerRows = buildProviderUsageRows({ providers: telemetry.providers || {}, rateMap });
  const sessionEstimateUsd = providerRows.reduce((sum, row) => sum + row.costEstimateUsd, 0);
  const dayEstimateUsd = providerRows.reduce((sum, row) => {
    const dayTokens = Math.max(0, toNumber(row.dayTokensIn, 0)) + Math.max(0, toNumber(row.dayTokensOut, 0));
    return sum + estimateProviderCost({ totalTokens: dayTokens, ratePer1k: row.costRatePer1kUsd });
  }, 0);

  return {
    providerRows,
    heatmap: buildRateLimitHeatmap({ hourly429s: telemetry.hourly429s || [], currentHour }),
    funnel: buildTaskFunnel(telemetry.taskFunnel || {}),
    sparklines: {
      throughput: renderTelemetrySparkline(telemetry.throughputPerSecond || []),
      providerUsage: renderTelemetrySparkline(providerRows.map((row) => row.totalTokens)),
      errors: renderTelemetrySparkline(telemetry.errorsPerWindow || []),
      retries: renderTelemetrySparkline(telemetry.retriesPerWindow || []),
    },
    cost: {
      sessionEstimateUsd,
      dayEstimateUsd,
      rateMap,
      isEstimate: true,
    },
  };
}

export { DEFAULT_COST_PER_1K_TOKENS_USD, PROVIDER_ORDER, FUNNEL_ORDER };
