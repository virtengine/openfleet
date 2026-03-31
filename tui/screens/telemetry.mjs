import React from "react";
import htm from "htm";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;

const html = htm.bind(React.createElement);

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  const abs = Math.abs(numeric);
  const formatCompact = (scaled, suffix) => `${Number(scaled.toFixed(1)).toString()}${suffix}`;
  if (abs >= 1_000_000_000_000) return formatCompact(numeric / 1_000_000_000_000, "T");
  if (abs >= 1_000_000_000) return formatCompact(numeric / 1_000_000_000, "B");
  if (abs >= 1_000_000) return formatCompact(numeric / 1_000_000, "M");
  if (abs >= 1_000) return formatCompact(numeric / 1_000, "K");
  return numeric.toFixed(numeric >= 10 ? 0 : 1);
}

function buildProviderRows(rateLimits = {}) {
  return Object.entries(rateLimits || {}).map(([provider, bucket]) => ({
    provider,
    primary: bucket?.primary ?? "n/a",
    secondary: bucket?.secondary ?? "n/a",
    credits: bucket?.credits ?? "n/a",
    unit: bucket?.unit || "min",
  }));
}

export default function TelemetryScreen({ stats = {}, sessions = [] }) {
  const providerRows = buildProviderRows(stats?.rateLimits);
  const retryItems = Array.isArray(stats?.retryQueue?.items) ? stats.retryQueue.items : [];

  return html`
    <${Box} flexDirection="column" paddingY=${1} paddingX=${1}>
      <${Box}>
        <${Box} borderStyle="single" paddingX=${1} marginRight=${1}>
          <${Text}>Uptime ${formatNumber((stats?.uptimeMs || 0) / 1000)}s<//>
        <//>
        <${Box} borderStyle="single" paddingX=${1} marginRight=${1}>
          <${Text}>Sessions ${sessions.length}<//>
        <//>
        <${Box} borderStyle="single" paddingX=${1} marginRight=${1}>
          <${Text}>Throughput ${formatNumber(stats?.throughputTps || 0)} tps<//>
        <//>
        <${Box} borderStyle="single" paddingX=${1}>
          <${Text}>Tokens ${formatNumber(stats?.tokensTotal || stats?.totalTokens || 0)}<//>
        <//>
      <//>

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Runtime Counters<//>
        <${Text}>Input tokens: ${stats?.tokensIn ?? 0}<//>
        <${Text}>Output tokens: ${stats?.tokensOut ?? 0}<//>
        <${Text}>Total tokens: ${stats?.tokensTotal ?? stats?.totalTokens ?? ((stats?.tokensIn || 0) + (stats?.tokensOut || 0))}<//>
        <${Text}>Active agents: ${stats?.activeAgents ?? 0}/${stats?.maxAgents ?? 0}<//>
        <${Text}>Retry queue: ${stats?.retryQueue?.count ?? 0}<//>
      <//>

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Rate Limits<//>
        ${providerRows.length
          ? providerRows.map((row) => html`
              <${Text} key=${row.provider}>
                ${String(row.provider).padEnd(10, " ")}
                primary ${row.primary}/${row.unit}  secondary ${row.secondary}/${row.unit}  credits ${row.credits}
              <//>
            `)
          : html`<${Text} dimColor>No provider rate-limit telemetry exposed yet.<//>`}
      <//>

      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Retry Queue<//>
        ${retryItems.length
          ? retryItems.slice(0, 8).map((item) => html`
              <${Text} key=${item.taskId || item.id}>
                ${String(item.taskTitle || item.taskId || item.id || "task").padEnd(28, " ")}
                attempt ${item.retryCount || 0}
                ${"  "}
                ${String(item.lastError || item.reason || "-")}
              <//>
            `)
          : html`<${Text} dimColor>No queued retries.<//>`}
      <//>
    <//>
  `;
}
