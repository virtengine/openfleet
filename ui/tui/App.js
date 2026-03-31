import React, { useMemo, useState } from "react";
import htm from "htm";
import { Box, Text, useApp, useInput } from "ink";

import {
  ANSI_COLORS,
  COLUMN_WIDTHS,
  GLYPHS,
  KEY_BINDINGS,
  MIN_TERMINAL_SIZE,
  TAB_ORDER,
} from "./constants.js";
import { useWebSocket } from "./useWebSocket.js";
import { useTasks } from "./useTasks.js";
import { useWorkflows } from "./useWorkflows.js";
import TelemetryScreen from "./TelemetryScreen.js";

const html = htm.bind(React.createElement);

function clip(value, width) {
  const text = String(value ?? "");
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function formatWhen(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "-";
  }
}

function mergeTasks(baseTasks, liveTasks) {
  const map = new Map();
  for (const task of Array.isArray(baseTasks) ? baseTasks : []) {
    if (task?.id) map.set(task.id, { ...task });
  }
  for (const task of Array.isArray(liveTasks) ? liveTasks : []) {
    if (task?.id) map.set(task.id, { ...(map.get(task.id) || {}), ...task });
  }
  return Array.from(map.values());
}

function renderRow(columns, key, color = undefined, bold = false) {
  return html`
    <${Box} key=${key}>
      ${columns.map((column, index) => html`
        <${Text}
          key=${String(index)}
          color=${color}
          bold=${bold}
        >
          ${String(column)}
        <//>
      `)}
    <//>
  `;
}

function renderTable(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return html`<${Text} color=${ANSI_COLORS.muted}>No data yet.<//>`;
  }

  const headers = Object.keys(data[0] || {});
  const widths = headers.map((header) => {
    const contentWidth = data.reduce(
      (max, row) => Math.max(max, String(row?.[header] ?? "").length),
      String(header).length,
    );
    return Math.min(Math.max(contentWidth, String(header).length), COLUMN_WIDTHS[header] || contentWidth);
  });

  const formatCell = (value, width) => clip(value, width).padEnd(width + 2, " ");
  const separator = widths.map((width) => `${"-".repeat(width)}  `);

  return html`
    <${Box} flexDirection="column">
      ${renderRow(headers.map((header, index) => formatCell(header.toUpperCase(), widths[index])), "header", ANSI_COLORS.accent, true)}
      ${renderRow(separator, "separator", ANSI_COLORS.muted)}
      ${data.map((row, rowIndex) => renderRow(
        headers.map((header, index) => formatCell(row?.[header] ?? "", widths[index])),
        `row-${rowIndex}`,
      ))}
    <//>
  `;
}

function StatusHeader({ activeTab, connectionStatus, reconnectPulse, host, port, stats, terminalSize }) {
  const isConnected = connectionStatus === "connected";
  const isReconnecting = connectionStatus === "reconnecting";
  const indicator = isConnected
    ? GLYPHS.connected
    : isReconnecting
      ? (reconnectPulse ? GLYPHS.reconnectingOn : GLYPHS.reconnectingOff)
      : GLYPHS.disconnected;
  const indicatorColor = isConnected
    ? ANSI_COLORS.connected
    : isReconnecting
      ? ANSI_COLORS.reconnecting
      : ANSI_COLORS.disconnected;

  return html`
    <${Box} flexDirection="column" marginBottom=${1}>
      <${Box} justifyContent="space-between">
        <${Text} bold>Bosun TUI<//>
        <${Text} color=${indicatorColor}>${indicator} ${connectionStatus.toUpperCase()}<//>
      <//>
      <${Box} justifyContent="space-between">
        <${Text} color=${ANSI_COLORS.muted}>WS ${host}:${port} · ${terminalSize.columns}x${terminalSize.rows}<//>
        <${Text} color=${ANSI_COLORS.muted}>
          Agents ${stats?.activeAgents ?? 0}/${stats?.maxAgents ?? 0} · Tokens ${stats?.tokensTotal ?? 0}
        <//>
      <//>
      <${Box} marginTop=${1}>
        ${TAB_ORDER.map((tab) => html`
          <${Box} key=${tab.id} marginRight=${2}>
            <${Text} inverse=${tab.id === activeTab} color=${tab.id === activeTab ? undefined : ANSI_COLORS.accent}>
              [${tab.shortcut.toUpperCase()}]${tab.label.toLowerCase().startsWith(tab.shortcut) ? tab.label.slice(1) : tab.label}
            <//>
          <//>
        `)}
      <//>
    <//>
  `;
}

function ScreenFrame({ title, subtitle, children }) {
  return html`
    <${Box} flexDirection="column">
      <${Text} bold>${title}<//>
      <${Text} color=${ANSI_COLORS.muted}>${subtitle}<//>
      <${Box} marginTop=${1}>${children}<//>
    <//>
  `;
}

export default function App({ config, configDir, host, port, protocol = "ws", initialScreen = "agents", terminalSize }) {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState(initialScreen);
  const wsState = useWebSocket({ host, port, configDir, protocol });
  const taskState = useTasks();
  const workflowState = useWorkflows(config);

  const combinedTasks = useMemo(
    () => mergeTasks(taskState.tasks, wsState.tasks),
    [taskState.tasks, wsState.tasks],
  );

  useInput((input, key) => {
    if (input === KEY_BINDINGS.q) {
      exit();
      return;
    }

    if (key.tab) {
      const index = TAB_ORDER.findIndex((tab) => tab.id === activeTab);
      const delta = key.shift ? -1 : 1;
      const nextIndex = (index + delta + TAB_ORDER.length) % TAB_ORDER.length;
      setActiveTab(TAB_ORDER[nextIndex].id);
      return;
    }

    const nextTab = KEY_BINDINGS[String(input || "").toLowerCase()];
    if (nextTab && TAB_ORDER.some((tab) => tab.id === nextTab)) {
      setActiveTab(nextTab);
    }
  });

  const tooSmall = terminalSize.columns < MIN_TERMINAL_SIZE.columns || terminalSize.rows < MIN_TERMINAL_SIZE.rows;

  const agentsRows = useMemo(() => wsState.sessions.slice(0, 10).map((session) => ({
    id: clip(session.id, COLUMN_WIDTHS.id),
    status: clip(session.status, COLUMN_WIDTHS.status),
    title: clip(session.title || session.taskId || "-", COLUMN_WIDTHS.title),
    turns: String(session.turnCount ?? 0),
    updated: formatWhen(session.lastActiveAt),
  })), [wsState.sessions]);

  const taskRows = useMemo(() => combinedTasks.slice(0, 12).map((task) => ({
    id: clip(task.id, COLUMN_WIDTHS.id),
    status: clip(task.status || "todo", COLUMN_WIDTHS.status),
    priority: clip(task.priority || "medium", COLUMN_WIDTHS.priority),
    title: clip(task.title || "Untitled task", COLUMN_WIDTHS.title),
  })), [combinedTasks]);

  const workflowRows = useMemo(() => (workflowState.workflows || []).slice(0, 12).map((workflow) => ({
    workflow: clip(workflow.name || workflow.id || "workflow", COLUMN_WIDTHS.workflow),
    source: clip(workflow.source || workflow.file || "configured", 24),
    enabled: workflow.enabled === false ? "no" : "yes",
  })), [workflowState.workflows]);

  let body = null;
  if (tooSmall) {
    body = html`
      <${ScreenFrame}
        title="Terminal too small"
        subtitle="The Bosun TUI works best in a 120x30 or larger terminal."
      >
        <${Text} color=${ANSI_COLORS.warning}>
          ${GLYPHS.warning} Current size is ${terminalSize.columns}x${terminalSize.rows}. Resize the terminal to continue.
        <//>
      <//>
    `;
  } else if (activeTab === "agents") {
    body = html`
      <${ScreenFrame}
        title="Agents"
        subtitle="Live sessions from the Bosun WebSocket bus."
      >
        ${renderTable(agentsRows)}
      <//>
    `;
  } else if (activeTab === "tasks") {
    body = html`
      <${ScreenFrame}
        title="Tasks"
        subtitle=${taskState.loading ? "Loading task store…" : `Showing ${combinedTasks.length} task(s).`}
      >
        ${taskState.error ? html`<${Text} color=${ANSI_COLORS.danger}>${taskState.error}<//>` : renderTable(taskRows)}
      <//>
    `;
  } else if (activeTab === "logs") {
    body = html`
      <${ScreenFrame}
        title="Logs"
        subtitle="Latest streamed lines from the Bosun bus."
      >
        ${wsState.logs.length
          ? html`${wsState.logs.slice(0, 12).map((entry, index) => html`
              <${Text} key=${String(index)}>
                ${clip(entry?.timestamp || "--:--", 8)} ${clip((entry?.level || "info").toUpperCase(), 5)} ${clip(entry?.line || entry?.raw || "", 100)}
              <//>
            `)}`
          : html`<${Text} color=${ANSI_COLORS.muted}>No log lines streamed yet.<//>`}
      <//>
    `;
  } else if (activeTab === "workflows") {
    body = html`
      <${ScreenFrame}
        title="Workflows"
        subtitle=${workflowState.loading ? "Loading configured workflows…" : `Loaded ${workflowState.workflows.length} workflow(s).`}
      >
        ${workflowState.error ? html`<${Text} color=${ANSI_COLORS.danger}>${workflowState.error}<//>` : renderTable(workflowRows)}
      <//>
    `;
  } else if (activeTab === "telemetry") {
    body = html`
      <${ScreenFrame}
        title="Telemetry"
        subtitle="Live throughput, provider usage, rate limits, and cost estimates."
      >
        <${TelemetryScreen} wsState=${wsState} config=${config} terminalSize=${terminalSize} />
      <//>
    `;
  } else if (activeTab === "settings") {
    body = html`
      <${ScreenFrame}
        title="Settings"
        subtitle="Resolved local Bosun runtime settings."
      >
        <${Text}>Config Dir: ${configDir}<//>
        <${Text}>WS Host: ${host}<//>
        <${Text}>WS Port: ${port}<//>
        <${Text}>Workspace: ${config?.activeWorkspace || "-"}<//>
      <//>
    `;
  } else {
    body = html`
      <${ScreenFrame}
        title="Help"
        subtitle="Keyboard shortcuts for the Bosun TUI."
      >
        <${Text}>A/T/L/W/X/S/? switch screens.<//>
        <${Text}>Tab and Shift+Tab cycle screens.<//>
        <${Text}>Q quits the TUI.<//>
      <//>
    `;
  }

  return html`
    <${Box} flexDirection="column">
      <${StatusHeader}
        activeTab=${activeTab}
        connectionStatus=${wsState.connectionStatus}
        reconnectPulse=${wsState.reconnectPulse}
        host=${host}
        port=${port}
        stats=${wsState.stats}
        terminalSize=${terminalSize}
      />
      ${body}
    <//>
  `;
}


