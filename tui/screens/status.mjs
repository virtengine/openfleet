import React from "react";
import htm from "htm";
import { Box, Text } from "ink";

const html = htm.bind(React.createElement);

function metric(label, value, suffix = "") {
  return html`
    <${Box} borderStyle="single" paddingX=${1} marginRight=${1}>
      <${Text} dimColor>${label}: <//>
      <${Text} bold>${value}${suffix}<//>
    <//>
  `;
}

export default function StatusScreen({ stats, sessions, tasks }) {
  const s = {
    runtimeMs: 0,
    totalCostUsd: 0,
    retryQueue: { count: 0, items: [] },
    workflows: { active: [], total: 0 },
    memory: { used: 0, total: 0 },
    cpu: { usage: 0 },
    ...(stats || {}),
  };
  const activeSessions = (sessions || []).filter((session) => session?.status === "active");

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Box}>
        ${metric("Active Sessions", activeSessions.length)}
        ${metric("Tasks", (tasks || []).length)}
        ${metric("Retry Queue", s.retryQueue?.count || 0)}
        ${metric("Cost", Number(s.totalCostUsd || 0).toFixed(2), " USD")}
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
