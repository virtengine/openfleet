import React from "react";
import htm from "htm";
import * as ink from "ink";

import { buildTelemetryModel } from "./telemetry-screen-helpers.mjs";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useStdout = ink.useStdout ?? ink.default?.useStdout;
const html = htm.bind(React.createElement);
const WIDE_WIDTH = 140;

function panel(title, body, props = {}) {
  return React.createElement(
    Box,
    {
      borderStyle: "single",
      paddingX: 1,
      paddingY: 0,
      flexDirection: "column",
      ...props,
    },
    React.createElement(Text, { bold: true, color: "cyan" }, title),
    body,
  );
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatCompactCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  const abs = Math.abs(numeric);
  const formatCompact = (scaled, suffix) => `${Number(scaled.toFixed(1)).toString()}${suffix}`;
  if (abs >= 1_000_000_000_000) return formatCompact(numeric / 1_000_000_000_000, "T");
  if (abs >= 1_000_000_000) return formatCompact(numeric / 1_000_000_000, "B");
  if (abs >= 1_000_000) return formatCompact(numeric / 1_000_000, "M");
  if (abs >= 1_000) return formatCompact(numeric / 1_000, "K");
  return String(numeric);
}

function toneColor(tone) {
  if (tone === "red") return "red";
  if (tone === "yellow") return "yellow";
  return undefined;
}

function normalizeProviderKey(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value.includes("claude") || value.includes("anthropic")) return "claude";
  if (value.includes("codex") || value.includes("openai")) return "codex";
  if (value.includes("gemini")) return "gemini";
  if (value.includes("copilot") || value.includes("github")) return "copilot";
  return value;
}

function buildLegacyTelemetry(stats = {}, sessions = [], tasks = []) {
  const providers = {};
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const provider = normalizeProviderKey(
      session?.provider || session?.modelProvider || session?.metadata?.provider || session?.executor,
    );
    const row = providers[provider] || {
      sessions: 0,
      tokensIn: 0,
      tokensOut: 0,
      dayTokensIn: 0,
      dayTokensOut: 0,
      avgSessionLengthSec: 0,
      errorCount: 0,
      durationTotalSec: 0,
    };
    const tokensIn = Math.max(0, Number(session?.tokensIn || session?.inputTokens || 0));
    const tokensOut = Math.max(0, Number(session?.tokensOut || session?.outputTokens || 0));
    const durationSec = Math.max(
      0,
      Number(session?.durationSeconds || session?.elapsedMs / 1000 || session?.runtimeMs / 1000 || 0),
    );
    const errorCount = Math.max(0, Number(session?.errorCount || session?.errors || 0));

    row.sessions += 1;
    row.tokensIn += tokensIn;
    row.tokensOut += tokensOut;
    row.dayTokensIn += tokensIn;
    row.dayTokensOut += tokensOut;
    row.durationTotalSec += durationSec;
    row.errorCount += errorCount;
    providers[provider] = row;
  }

  for (const row of Object.values(providers)) {
    row.avgSessionLengthSec = row.sessions > 0 ? row.durationTotalSec / row.sessions : 0;
    delete row.durationTotalSec;
  }

  const statusCounts = { todo: 0, inProgress: 0, review: 0, done: 0, failed: 0 };
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = String(task?.status || "").trim().toLowerCase();
    if (status === "todo") statusCounts.todo += 1;
    else if (status === "inprogress" || status === "in_progress") statusCounts.inProgress += 1;
    else if (status === "review") statusCounts.review += 1;
    else if (status === "done" || status === "completed") statusCounts.done += 1;
    else if (status === "failed" || status === "error" || status === "blocked") statusCounts.failed += 1;
  }

  const retryCount = Math.max(0, Number(stats?.retryQueue?.count || 0));

  return {
    throughputPerSecond: Number.isFinite(Number(stats?.throughputTps)) ? [Number(stats.throughputTps)] : [],
    errorsPerWindow: [],
    retriesPerWindow: retryCount > 0 ? [retryCount] : [],
    providers,
    hourly429s: [],
    taskFunnel: statusCounts,
  };
}

function buildLegacyRateLimitRows(rateLimits = {}) {
  return Object.entries(rateLimits || {}).map(([provider, bucket]) => ({
    provider,
    primary: bucket?.primary ?? "n/a",
    secondary: bucket?.secondary ?? "n/a",
    credits: bucket?.credits ?? "n/a",
    unit: bucket?.unit || "min",
  }));
}

export default function TelemetryScreen({
  stats = {},
  sessions = [],
  tasks = [],
  config,
}) {
  const { stdout } = typeof useStdout === "function" ? useStdout() : { stdout: null };
  const columns = Number(stdout?.columns || 0);
  const wide = columns >= WIDE_WIDTH;
  const telemetryStats = stats?.telemetry ? stats : { ...stats, telemetry: buildLegacyTelemetry(stats, sessions, tasks) };
  const model = buildTelemetryModel({ stats: telemetryStats, config });
  const rateLimitRows = buildLegacyRateLimitRows(stats?.rateLimits);
  const retryItems = Array.isArray(stats?.retryQueue?.items) ? stats.retryQueue.items : [];
  const sessionHealth = stats?.sessionHealth && typeof stats.sessionHealth === "object" ? stats.sessionHealth : {};
  const durableContext = stats?.context && typeof stats.context === "object" ? stats.context : {};
  const toolSummary = stats?.toolSummary && typeof stats.toolSummary === "object" ? stats.toolSummary : {};
  const lifetimeTotals = stats?.lifetimeTotals && typeof stats.lifetimeTotals === "object" ? stats.lifetimeTotals : {};
  const topTools = Array.isArray(toolSummary.topTools) ? toolSummary.topTools.slice(0, 3) : [];

  const throughputPanel = panel("Session Throughput", html`
    <${Text}>60s throughput ${model.sparklines.throughput || ""}<//>
    <${Text} dimColor>Provider usage ${model.sparklines.providerUsage || ""}<//>
    <${Text}>Session estimate: ${formatUsd(model.cost.sessionEstimateUsd)}<//>
    <${Text} dimColor>Cost estimates only<//>
  `, { key: "throughput-panel", width: wide ? "33%" : undefined, marginRight: wide ? 1 : 0, marginBottom: wide ? 0 : 1 });

  const providerPanel = panel("Token Usage by Provider", html`
    ${React.Children.toArray(model.providerRows.map((row) => html`
      <${Box} key=${row.provider}>
        <${Text} color=${row.highlight || undefined}>${row.provider.padEnd(7)}<//>
        <${Text}> ${String(row.sessions).padStart(2)} sess | in ${formatCompactCount(row.tokensIn)} | out ${formatCompactCount(row.tokensOut)} | est ${formatUsd(row.costEstimateUsd)} | avg ${row.avgSessionLengthLabel} | err ${row.errorCount}<//>
      <//>
    `))}
    <${Text}>Day estimate: ${formatUsd(model.cost.dayEstimateUsd)}<//>
    <${Text} dimColor>Cost estimates only<//>
  `, { key: "provider-panel", width: wide ? "34%" : undefined, marginRight: wide ? 1 : 0, marginBottom: wide ? 0 : 1 });

  const rateLimitPanel = panel("Rate Limits", html`
    ${rateLimitRows.length
      ? React.Children.toArray(rateLimitRows.map((row) => html`
          <${Text} key=${row.provider}>
            ${String(row.provider).padEnd(10, " ")}
            primary ${row.primary}/${row.unit}  secondary ${row.secondary}/${row.unit}  credits ${row.credits}
          <//>
        `))
      : html`<${Text} dimColor>No provider rate-limit telemetry exposed yet.<//>`}
    <${Box} marginTop=${1} flexWrap="wrap">
      ${React.Children.toArray(model.heatmap.map((cell) => html`
        <${Box} key=${cell.hour} width=${9} marginRight=${1}>
          <${Text} color=${toneColor(cell.tone)} dimColor=${cell.tone === "dim"} inverse=${cell.isCurrentHour}>
            ${String(cell.hour).padStart(2, "0")}:${cell.label}
          <//>
        <//>
        `))}
    <//>
  `, { key: "rate-limit-panel", width: wide ? "33%" : undefined, marginBottom: wide ? 0 : 1 });

  const runtimePanel = panel("Runtime Counters", html`
    <${Text}>Input tokens: ${formatCompactCount(stats?.tokensIn ?? 0)}<//>
    <${Text}>Output tokens: ${formatCompactCount(stats?.tokensOut ?? 0)}<//>
    <${Text}>Total tokens: ${formatCompactCount(stats?.tokensTotal ?? stats?.totalTokens ?? ((stats?.tokensIn || 0) + (stats?.tokensOut || 0)))}<//>
    <${Text}>Active agents: ${stats?.activeAgents ?? stats?.agents?.online ?? 0}/${stats?.maxAgents ?? stats?.agents?.total ?? 0}<//>
    <${Text}>Retry queue: ${stats?.retryQueue?.count ?? 0}<//>
    ${retryItems.length
      ? React.Children.toArray(retryItems.slice(0, 5).map((item) => html`
          <${Text} key=${item.taskId || item.id}>
            ${String(item.taskTitle || item.taskId || item.id || "task").padEnd(24, " ")} attempt ${item.retryCount || 0}
          <//>
        `))
      : html`<${Text} dimColor>No queued retries.<//>`}
  `, { key: "runtime-panel", marginTop: 1, marginBottom: 1 });

  const durableRuntimePanel = panel("Durable Session Runtime", html`
    <${Text}>
      State ledger / SQL
      {" | "}live ${formatCompactCount(durableContext.liveSessionCount || sessionHealth.live || stats?.activeSessionCount || 0)}
      {" | "}completed ${formatCompactCount(durableContext.completedSessionCount || sessionHealth.completed || stats?.completedSessionCount || 0)}
      {" | "}total ${formatCompactCount(stats?.totalSessionCount || stats?.totalSessions || sessions?.length || 0)}
    <//>
    <${Text}>
      Context near-limit ${formatCompactCount(durableContext.sessionsNearContextLimit || 0)}
      {" | "}high-pressure ${formatCompactCount(durableContext.sessionsHighContextPressure || 0)}
      {" | "}max ${formatCompactCount(durableContext.maxContextUsagePercent || 0)}%
    <//>
    <${Text}>
      Attempts ${formatCompactCount(lifetimeTotals.attemptsCount || 0)}
      {" | "}tokens ${formatCompactCount(lifetimeTotals.tokenCount || 0)}
      {" | "}runtime ${formatCompactCount(Math.round(Number(lifetimeTotals.durationMs || 0) / 1000))}s
    <//>
    <${Text}>
      Top tools ${topTools.length
        ? topTools.map((tool) => `${tool.name}:${formatCompactCount(tool.count || 0)}`).join(", ")
        : "none"}
    <//>
  `, { key: "durable-runtime-panel", marginBottom: 1 });

  const funnelPanel = panel("Task Completion Funnel", html`
    <${Text}>
      ${model.funnel.stages.map((stage) => `${stage.label} -> ${stage.count} (${stage.conversionPct}%)`).join(" | ")}
    <//>
    <${Text} dimColor>Errors ${model.sparklines.errors || ""}  Retries ${model.sparklines.retries || ""}<//>
  `, { key: "funnel-panel" });

  return html`
    <${Box} flexDirection="column" paddingY=${1} paddingX=${1}>
      <${Box} flexDirection=${wide ? "row" : "column"}>
        ${throughputPanel}
        ${providerPanel}
        ${rateLimitPanel}
      <//>
      ${runtimePanel}
      ${durableRuntimePanel}
      ${funnelPanel}
    <//>
  `;
}
