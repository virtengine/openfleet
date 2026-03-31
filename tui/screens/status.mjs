import React from "react";
import htm from "htm";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;

const html = htm.bind(React.createElement);

function metric(label, value, suffix = "") {
  return html`
    <${Box} borderStyle="single" paddingX=${1} marginRight=${1}>
      <${Text} dimColor>${label}: <//>
      <${Text} bold>${value}${suffix}<//>
    <//>
  `;
}

function formatDurationSeconds(value) {
  const totalSeconds = Math.max(0, Math.trunc(Number(value || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export default function StatusScreen({ stats, sessions, tasks }) {
  const s = {
    runtimeMs: 0,
    totalCostUsd: 0,
    retryQueue: { count: 0, items: [] },
    workflows: { active: [], total: 0 },
    memory: { used: 0, total: 0 },
    cpu: { usage: 0 },
    executor: { mode: "internal", paused: false, activeSlots: 0, maxParallel: 0, slots: [] },
    recovery: { totals: {}, lastRun: null, recentRuns: [] },
    ...(stats || {}),
  };
  const activeSessions = (sessions || []).filter((session) => session?.status === "active");
  const executorSlots = Array.isArray(s.executor?.slots) ? s.executor.slots : [];
  const lastRecovery = s.recovery?.lastRun && typeof s.recovery.lastRun === "object"
    ? s.recovery.lastRun
    : null;
  const metrics = [
    { key: "active-sessions", label: "Active Sessions", value: activeSessions.length },
    { key: "tasks", label: "Tasks", value: (tasks || []).length },
    { key: "retry-queue", label: "Retry Queue", value: s.retryQueue?.count || 0 },
    { key: "recovery-resets", label: "Recovery Resets", value: s.recovery?.totals?.resetToTodo || 0 },
    { key: "cost", label: "Cost", value: Number(s.totalCostUsd || 0).toFixed(2), suffix: " USD" },
  ];

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Box}>
        ${metrics.map((item) => html`
          <${React.Fragment} key=${item.key}>
            ${metric(item.label, item.value, item.suffix || "")}
          <//>
        `)}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Runtime Snapshot<//>
        <${Text}>
          CPU ${Number(s.cpu?.usage || 0).toFixed(1)}%  |  Memory
          ${Math.round(Number(s.memory?.used || 0) / 1024 / 1024)}MB /
          ${Math.round(Number(s.memory?.total || 0) / 1024 / 1024)}MB
        <//>
        <${Text}>
          Workflows ${(s.workflows?.active || []).length}/${s.workflows?.total || 0}
        <//>
        <${Text}>
          Executor ${s.executor?.activeSlots || 0}/${s.executor?.maxParallel || 0}
          {" | "}mode ${s.executor?.mode || "internal"}
          {s.executor?.paused ? " | paused" : ""}
        <//>
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Recovery / Orphans<//>
        ${lastRecovery
          ? html`
              <${React.Fragment} key="last-recovery">
                <${Text}>
                  Last ${lastRecovery.trigger || "interval"} run: scanned ${lastRecovery.scannedCount || 0}
                  {" | "}resumed ${lastRecovery.resumedCount || 0}
                  {" | "}reset ${lastRecovery.resetToTodoCount || 0}
                  {" | "}drift ${lastRecovery.reconciledDriftCount || 0}
                <//>
                <${Text}>
                  Stale owners ${lastRecovery.staleSharedClaimCount || 0}
                  {" | "}active claims ${lastRecovery.skippedForActiveClaimCount || 0}
                  {" | "}workflow ownerless ${lastRecovery.workflowOwnerlessResetCount || 0}
                  {" | "}duration ${formatDurationSeconds((lastRecovery.durationMs || 0) / 1000)}
                <//>
              <//>
            `
          : html`<${Text} dimColor>No recovery activity recorded yet<//>`}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Executor Slots<//>
        ${executorSlots.length
          ? executorSlots.slice(0, 5).map((slot) => html`
              <${Text} key=${slot.taskId || slot.taskTitle}>
                ${(slot.taskTitle || slot.taskId || "-").slice(0, 44)}
                {" | "}${slot.status || "running"}
                {" | "}${slot.sdk || "agent"}
                {" | "}${formatDurationSeconds(slot.runningFor || 0)}
              <//>
            `)
          : html`<${Text} dimColor>No active executor slots<//>`}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Active Sessions<//>
        ${activeSessions.length
          ? activeSessions.slice(0, 5).map((session) => html`
              <${Text} key=${session.id}>
                ${String(session.id || "").slice(0, 8)}  ${session.title || session.taskId || "-"}
              <//>
            `)
          : html`<${Text} dimColor>No active sessions<//>`}
      <//>
    <//>
  `;
}
