import * as ReactModule from "react";
import htm from "htm";
import * as ink from "ink";

const React = ReactModule.default ?? ReactModule;
const useMemo = ReactModule.useMemo ?? React.useMemo;
const useState = ReactModule.useState ?? React.useState;
const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useApp = ink.useApp ?? ink.default?.useApp;
const useInput = ink.useInput ?? ink.default?.useInput;

import {
  ANSI_COLORS,
  COLUMN_WIDTHS,
  GLYPHS,
  KEY_BINDINGS,
  MIN_TERMINAL_SIZE,
  TAB_ORDER,
} from "./constants.js";
import HelpScreen, { getFooterHints, SHORTCUT_GROUPS } from "./HelpScreen.js";
import { useWebSocket } from "./useWebSocket.js";
import { useTasks } from "./useTasks.js";
import { useWorkflows } from "./useWorkflows.js";
import SettingsScreen from "./SettingsScreen.js";

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
        <${Text} key=${String(index)} color=${color} bold=${bold}>${String(column)}<//>
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
        <${Text} color=${ANSI_COLORS.muted}>Agents ${stats?.activeAgents ?? 0}/${stats?.maxAgents ?? 0} · Tokens ${stats?.tokensTotal ?? 0}<//>
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

function FooterHints({ hints, width }) {
  const text = (Array.isArray(hints) ? hints : [])
    .map(([keysLabel, description]) => `${keysLabel} ${description}`.trim())
    .join("  |  ");
  const clipped = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;

  return html`
    <${Box} marginTop=${1}>
      <${Text} color=${ANSI_COLORS.accent}>${clipped}<//>
    <//>
  `;
}

export default function App({ config, configDir, host, port, protocol = "ws", initialScreen = "agents", terminalSize }) {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState(initialScreen);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpScrollOffset, setHelpScrollOffset] = useState(0);
  const [footerHints, setFooterHints] = useState(() => getFooterHints(initialScreen));
  const wsState = useWebSocket({ host, port, configDir, protocol });
  const taskState = useTasks();
  const workflowState = useWorkflows(config);

  const combinedTasks = useMemo(() => mergeTasks(taskState.tasks, wsState.tasks), [taskState.tasks, wsState.tasks]);

  useEffect(() => {
    if (!helpOpen) {
      setFooterHints(getFooterHints(activeTab));
    }
  }, [activeTab, helpOpen]);

  const helpMaxRows = Math.max(3, terminalSize.rows - 8);
  const helpRowCount = SHORTCUT_GROUPS.reduce((totalRows, group, index, groups) => {
    if (index % 2 === 1) return totalRows;
    const right = groups[index + 1];
    const pairHeight = 1 + Math.max(group.items.length, right?.items?.length || 0);
    return totalRows + pairHeight;
  }, 0);
  const maxHelpScrollOffset = Math.max(0, helpRowCount - helpMaxRows);

  useInput((input, key) => {
    if (helpOpen) {
      if (input === "?" || key.escape) {
        setHelpOpen(false);
        setHelpScrollOffset(0);
        return;
      }
      if (key.upArrow) {
        setHelpScrollOffset((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setHelpScrollOffset((current) => Math.min(maxHelpScrollOffset, current + 1));
        return;
      }
      return;
    }

    if (input === "?") {
      setHelpOpen(true);
      setHelpScrollOffset(0);
      setFooterHints(getFooterHints(activeTab, { helpOpen: true }));
      return;
    }

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
    id: clip(session.id, 10),
    status: session.status || "-",
    title: clip(session.title || session.taskId || "Untitled", 40),
    turns: session.turnCount ?? 0,
    updated: formatWhen(session.lastActiveAt || session.updatedAt || session.createdAt),
  })), [wsState.sessions]);
  const taskRows = useMemo(() => combinedTasks.slice(0, 12).map((task) => ({
    id: task.id,
    status: task.status,
    priority: task.priority || "-",
    title: task.title,
    updated: formatWhen(task.updatedAt || task.createdAt),
  })), [combinedTasks]);
  const workflowRows = useMemo(() => (workflowState.workflows || []).slice(0, 12).map((workflow) => ({
    id: workflow.id || workflow.name || workflow.type || "workflow",
    workflow: workflow.name || workflow.type || "workflow",
    status: workflow.enabled === false ? "disabled" : "enabled",
    updated: formatWhen(workflow.updatedAt || workflow.createdAt),
  })), [workflowState.workflows]);

  let body;
  if (tooSmall) {
    body = html`<${Text} color=${ANSI_COLORS.warning}>Terminal too small. Need at least ${MIN_TERMINAL_SIZE.columns}x${MIN_TERMINAL_SIZE.rows}.<//>`;
  } else if (activeTab === "agents") {
    body = html`<${ScreenFrame} title="Agents" subtitle=${`Connected sessions: ${wsState.sessions.length}.`}>${renderTable(agentsRows)}<//>`;
  } else if (activeTab === "tasks") {
    body = html`<${ScreenFrame} title="Tasks" subtitle=${`Tracked tasks: ${combinedTasks.length}.`}>${renderTable(taskRows)}<//>`;
  } else if (activeTab === "logs") {
    body = html`<${ScreenFrame} title="Logs" subtitle="Recent monitor and transport events.">
      ${wsState.logs.length ? wsState.logs.slice(0, 12).map((entry, index) => html`<${Text} key=${index}>${entry}<//>`) : html`<${Text} color=${ANSI_COLORS.muted}>No log entries yet.<//>`}
    <//>`;
  } else if (activeTab === "workflows") {
    body = html`<${ScreenFrame} title="Workflows" subtitle=${workflowState.loading ? "Loading configured workflows…" : `Loaded ${workflowState.workflows.length} workflow(s).`}>
      ${workflowState.error ? html`<${Text} color=${ANSI_COLORS.danger}>${workflowState.error}<//>` : renderTable(workflowRows)}
    <//>`;
  } else if (activeTab === "telemetry") {
    body = html`<${ScreenFrame} title="Telemetry" subtitle="Live monitor counters and reconnect health.">
      <${Text}>Connection: ${wsState.connectionStatus}<//>
      <${Text}>Reconnects: ${wsState.reconnectCount}<//>
      <${Text}>Tokens In/Out: ${wsState.stats?.tokensIn ?? 0}/${wsState.stats?.tokensOut ?? 0}<//>
      <${Text}>Throughput TPS: ${wsState.stats?.throughputTps ?? 0}<//>
    <//>`;
  } else if (activeTab === "settings") {
    body = html`<${SettingsScreen} configDir=${configDir} config=${config} />`;
  } else {
    body = html`<${ScreenFrame} title="Help" subtitle="Keyboard shortcuts for the Bosun TUI.">
      <${Text}>A/T/L/W/X/S/? switch screens.<//>
      <${Text}>Tab and Shift+Tab cycle screens.<//>
      <${Text}>Q quits the TUI.<//>
    <//>`;
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
      <${Box} flexDirection="column" flexGrow=${1}>
        ${body}
      <//>
      ${helpOpen
        ? html`
            <${Box} marginTop=${1} flexGrow=${1}>
              <${HelpScreen} scrollOffset=${helpScrollOffset} maxRows=${helpMaxRows} />
            <//>
          `
        : null}
      <${FooterHints} hints=${helpOpen ? getFooterHints(activeTab, { helpOpen: true }) : footerHints} width=${terminalSize.columns} />
    <//>
  `;
}

