import React from "react";
import htm from "htm";
import { Box, Text } from "ink";

const html = htm.bind(React.createElement);

const STATUS_COLORS = {
  connected: "green",
  disconnected: "red",
  active: "green",
};

function formatDuration(ms) {
  const safe = Math.max(0, Number(ms || 0));
  const seconds = Math.floor(safe / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatCost(usd) {
  const value = Number(usd || 0);
  return `$${Number.isFinite(value) ? value.toFixed(2) : "0.00"}`;
}

function formatCompactNumber(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0";
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(numeric));
}

export function formatTokenSummary(stats = {}) {
  const tokensIn = formatCompactNumber(stats.tokensIn);
  const tokensOut = formatCompactNumber(stats.tokensOut);
  const tokensTotal = formatCompactNumber(
    stats.tokensTotal ?? (Number(stats.tokensIn || 0) + Number(stats.tokensOut || 0)),
  );
  return `${tokensIn} in / ${tokensOut} out / ${tokensTotal} total`;
}

function countItems(value) {
  if (Array.isArray(value)) return value.length;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export default function StatusHeader({ stats, connected, screen }) {
  const s = {
    uptimeMs: 0,
    runtimeMs: 0,
    totalCostUsd: 0,
    totalSessions: 0,
    activeSessions: 0,
    totalTasks: 0,
    activeTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    retryQueue: { count: 0 },
    workflows: { active: 0, total: 0 },
    agents: { online: 0, total: 0 },
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    ...(stats || {}),
  };

  const workflowActive = countItems(s.workflows?.active);
  const workflowTotal = countItems(s.workflows?.total);
  const navItems = [
    { key: "status", num: "1", label: "Status" },
    { key: "tasks", num: "2", label: "Tasks" },
    { key: "agents", num: "3", label: "Agents" },
  ];

  return html`
    <${Box} flexDirection="column" borderStyle="round" paddingX=${1}>
      <${Box} justifyContent="space-between">
        <${Box}>
          <${Text} bold>Bosun TUI<//>
          <${Text} dimColor> | <//>
          <${Text}
            color=${connected ? STATUS_COLORS.connected : STATUS_COLORS.disconnected}
            bold=${!connected}
          >
            ${connected ? "Connected" : "Disconnected"}
          <//>
        <//>
        <${Box}>
          <${Text} dimColor>Uptime: <//>
          <${Text}>${formatDuration(s.uptimeMs)}<//>
          <${Text} dimColor> | Runtime: <//>
          <${Text}>${formatDuration(s.runtimeMs)}<//>
          <${Text} dimColor> | Cost: <//>
          <${Text}>${formatCost(s.totalCostUsd)}<//>
        <//>
      <//>
      <${Box}>
        <${Text} dimColor>Sessions: <//>
        <${Text} color=${s.activeSessions > 0 ? STATUS_COLORS.active : undefined}>${s.activeSessions}<//>
        <${Text} dimColor>/${s.totalSessions}  Tasks: <//>
        <${Text} color=${s.activeTasks > 0 ? STATUS_COLORS.active : undefined}>${s.activeTasks}<//>
        <${Text} dimColor>
          /${s.totalTasks}  Done:${s.completedTasks}  Fail:${s.failedTasks}
           | Retry:${s.retryQueue?.count || 0}
           | WF:${workflowActive}/${workflowTotal}
           | Agents:${s.agents?.online || 0}/${s.agents?.total || 0}
        <//>
      <//>
      <${Box}>
        <${Text} dimColor>Tokens: <//>
        <${Text}>${formatTokenSummary(s)}<//>
      <//>
      <${Box}>
        ${navItems.map((item) => html`
          <${Box} key=${item.key} marginRight=${2}>
            <${Text} inverse=${screen === item.key} color=${screen === item.key ? undefined : "cyan"}>
              [${item.num}] ${item.label}
            <//>
          <//>
        `)}
      <//>
    <//>
  `;
}