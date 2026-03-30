import * as ReactModule from "react";
import htm from "htm";
import * as ink from "ink";

const React = ReactModule.default ?? ReactModule;
const useCallback = ReactModule.useCallback ?? React.useCallback;
const useEffect = ReactModule.useEffect ?? React.useEffect;
const useMemo = ReactModule.useMemo ?? React.useMemo;
const useState = ReactModule.useState ?? React.useState;
const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useApp = ink.useApp ?? ink.default?.useApp;
const useInput = ink.useInput ?? ink.default?.useInput;
const useStdout = ink.useStdout ?? ink.default?.useStdout;

import wsBridgeFactory from "./lib/ws-bridge.mjs";
import { getNextScreenForInput } from "./lib/navigation.mjs";
import StatusHeader from "./components/status-header.mjs";
import TasksScreen from "./screens/tasks.mjs";
import AgentsScreen from "./screens/agents.mjs";
import LogsScreen from "./screens/logs.mjs";
import StatusScreen from "./screens/status.mjs";
import WorkflowsScreen from "./screens/workflows.mjs";
import TelemetryScreen from "./screens/telemetry.mjs";
import SettingsScreen from "./screens/settings.mjs";
import { readTuiHeaderConfig } from "./lib/header-config.mjs";
import { listTasksFromApi } from "../ui/tui/tasks-screen-helpers.js";
import { useWorkflows } from "../ui/tui/useWorkflows.js";
import HelpScreen, { getFooterHints, SHORTCUT_GROUPS } from "../ui/tui/HelpScreen.js";
import {
  appendLogEntry,
  createDefaultLogsFilterState,
  ensureLogSource,
} from "../ui/tui/logs-screen-helpers.js";

const CLI_SHORTCUT_TITLES = new Set(["Global", "Tasks screen", "Agents screen", "Modals"]);
const CLI_SHORTCUT_GROUPS = SHORTCUT_GROUPS.filter((g) => CLI_SHORTCUT_TITLES.has(g.title));

const html = htm.bind(React.createElement);

const SCREENS = {
  status: StatusScreen,
  tasks: TasksScreen,
  agents: AgentsScreen,
  logs: LogsScreen,
  workflows: WorkflowsScreen,
  telemetry: TelemetryScreen,
  settings: SettingsScreen,
};

function ScreenTabs({ screen }) {
  const navItems = [
    { key: "status", num: "1", label: "Status" },
    { key: "tasks", num: "2", label: "Tasks" },
    { key: "agents", num: "3", label: "Agents" },
    { key: "logs", num: "4", label: "Logs" },
    { key: "workflows", num: "5", label: "Workflows" },
    { key: "telemetry", num: "6", label: "Telemetry" },
    { key: "settings", num: "7", label: "Settings" },
  ];

  return html`
    <${Box} paddingX=${1}>
      ${navItems.map((item, index) => html`
        <${Box} key=${item.key}>
          <${Text} inverse=${screen === item.key} color=${screen === item.key ? undefined : "cyan"}>
            [${item.num}] ${item.label}
          <//>
          ${index < navItems.length - 1 ? html`<${Text} dimColor>  <//>` : null}
        <//>
      `)}
      <${Text} dimColor>  [q] Quit<//>
    <//>
  `;
}

function upsertById(items = [], nextItem) {
  if (!nextItem?.id) return items;
  const index = items.findIndex((item) => item.id === nextItem.id);
  if (index === -1) return [nextItem, ...items];
  const next = [...items];
  next[index] = { ...next[index], ...nextItem };
  return next;
}

export default function App({ host, port, connectOnly, initialScreen, refreshMs, wsClient }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [screen, setScreen] = useState(initialScreen || "status");
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState("offline");
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [logs, setLogs] = useState([]);
  const [workflowEvents, setWorkflowEvents] = useState([]);
  const [logsFilterState, setLogsFilterState] = useState(createDefaultLogsFilterState());
  const [error, setError] = useState(null);
  const [screenInputLocked, setScreenInputLocked] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpScrollOffset, setHelpScrollOffset] = useState(0);
  const [footerHints, setFooterHints] = useState(() => getFooterHints(initialScreen || "status"));
  const [refreshCountdownSec, setRefreshCountdownSec] = useState(
    Math.max(0, Math.ceil(Number(refreshMs || 2000) / 1000)),
  );

  const bridge = useMemo(
    () => wsClient || wsBridgeFactory({ host, port }),
    [host, port, wsClient],
  );
  const workflowsConfig = useMemo(() => ({}), []);
  const headerConfig = useMemo(
    () => readTuiHeaderConfig(bridge?.configDir),
    [bridge?.configDir],
  );
  const workflowsState = useWorkflows(workflowsConfig);

  useEffect(() => {
    let active = true;
    const unsubscribes = [];

    const resetRefreshCountdown = () => {
      setRefreshCountdownSec(Math.max(0, Math.ceil(Number(refreshMs || 2000) / 1000)));
    };
    const on = (eventName, handler) => {
      const unsubscribe = bridge.on(eventName, handler);
      unsubscribes.push(unsubscribe);
    };
    const refreshTasks = async () => {
      try {
        const nextTasks = await listTasksFromApi();
        if (active) setTasks(nextTasks);
      } catch (err) {
        if (active) setError(String(err?.message || err || "Failed to load tasks"));
      }
    };

    on("connect", () => {
      setConnected(true);
      setConnectionState("connected");
      setError(null);
      resetRefreshCountdown();
      void refreshTasks();
    });
    on("disconnect", () => {
      setConnected(false);
      setConnectionState("reconnecting");
    });
    on("reconnecting", () => {
      setConnected(false);
      setConnectionState("reconnecting");
    });
    on("connection:state", (payload) => {
      if (payload?.state) {
        setConnectionState(payload.state);
      }
    });
    on("error", (err) => {
      const message = err?.message || String(err || "Unknown websocket error");
      setError(message);
      if (message.includes("Max reconnection attempts")) {
        setConnectionState("offline");
      }
    });
    on("monitor:stats", (data) => {
      setStats(data || null);
      resetRefreshCountdown();
    });
    on("stats", (data) => {
      setStats(data || null);
      resetRefreshCountdown();
    });
    on("sessions:update", (payload) => {
      const nextSessions = Array.isArray(payload?.sessions)
        ? payload.sessions
        : Array.isArray(payload)
          ? payload
          : [];
      setSessions(nextSessions);
    });
    on("session:start", (session) => {
      setSessions((previous) => upsertById(previous, session));
    });
    on("session:update", (session) => {
      setSessions((previous) => upsertById(previous, session));
    });
    on("session:end", (session) => {
      setSessions((previous) => previous.filter((candidate) => candidate.id !== session?.id));
    });
    on("tasks:update", () => {
      void refreshTasks();
    });
    on("workflow:status", (event) => {
      setWorkflowEvents((previous) => [event, ...previous].slice(0, 25));
    });
    on("task:update", (task) => {
      setTasks((previous) => upsertById(previous, task));
    });
    on("task:create", (task) => {
      setTasks((previous) => upsertById(previous, task));
    });
    on("task:delete", (taskId) => {
      setTasks((previous) => previous.filter((task) => task.id !== taskId));
    });
    on("logs:stream", (entry) => {
      const logEntry = {
        ...entry,
        source: entry?.source ?? entry?.logType,
        ts: entry?.ts ?? entry?.timestamp,
        message: entry?.message ?? entry?.line ?? entry?.raw,
      };

      setLogs((previous) => appendLogEntry(previous, logEntry));
      setLogsFilterState((previous) => {
        let next = ensureLogSource(previous, logEntry.source, true);
        if (logEntry.sessionId) {
          next = ensureLogSource(next, `session:${logEntry.sessionId}`, true);
        }
        return next;
      });
    });
    on("retry:update", (retryQueue) => {
      setStats((previous) => ({ ...(previous || {}), retryQueue }));
    });
    on("retry-queue-updated", (retryQueue) => {
      setStats((previous) => ({ ...(previous || {}), retryQueue }));
    });

    if (typeof bridge.connect === "function") {
      bridge.connect();
    }
    void refreshTasks();

    return () => {
      active = false;
      unsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") unsubscribe();
      });
      if (typeof bridge.disconnect === "function") {
        bridge.disconnect();
      }
    };
  }, [bridge, refreshMs]);

  useEffect(() => {
    if (helpOpen) {
      setFooterHints(getFooterHints(screen, { helpOpen: true }));
      return;
    }
    setFooterHints(getFooterHints(screen));
  }, [screen, helpOpen]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setRefreshCountdownSec((previous) => Math.max(0, previous - 1));
    }, 1000);
    return () => clearInterval(intervalId);
  }, []);

  const helpRows = Math.max(6, (stdout?.rows || 24) - 5);
  const helpRowCount = CLI_SHORTCUT_GROUPS.reduce((totalRows, group, index, groups) => {
    if (index % 2 === 1) return totalRows;
    const right = groups[index + 1];
    const pairHeight = 1 + Math.max(group.items.length, right?.items?.length || 0);
    return totalRows + pairHeight;
  }, 0);
  const maxHelpScrollOffset = Math.max(0, helpRowCount - helpRows);

  const handleInput = useCallback((input, key) => {
    if (input === "?") {
      setHelpOpen((current) => {
        const opening = !current;
        if (opening) {
          setHelpScrollOffset(0);
          setFooterHints(getFooterHints(screen, { helpOpen: true }));
        } else {
          setFooterHints(getFooterHints(screen));
        }
        return opening;
      });
      return;
    }
    if (helpOpen) {
      if (key?.escape) {
        setHelpOpen(false);
        setHelpScrollOffset(0);
        setFooterHints(getFooterHints(screen));
        return;
      }
      if (key?.upArrow) {
        setHelpScrollOffset((current) => Math.max(0, current - 1));
        return;
      }
      if (key?.downArrow) {
        setHelpScrollOffset((current) => Math.min(maxHelpScrollOffset, current + 1));
        return;
      }
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    setScreen((current) => getNextScreenForInput(current, input));
  }, [exit, helpOpen, maxHelpScrollOffset, screen]);

  useInput((input, key) => {
    if (screenInputLocked && !helpOpen && input !== "?") return;
    handleInput(input, key);
  });

  const ScreenComponent = SCREENS[screen] || StatusScreen;
  const screenStats = screen === "status" ? stats : undefined;
  const settingsState = {
    configDir: bridge?.configDir,
    host,
    port,
    protocol: bridge?.protocol,
    refreshMs,
    projectLabel: headerConfig.projectLabel,
    configuredProviders: headerConfig.configuredProviders,
    connectionState,
  };
  const footerText = (footerHints || []).map(([keysLabel, description]) => `${keysLabel} ${description}`).join("  |  ");

  return html`
    <${Box} flexDirection="column" minHeight=${0}>
      <${StatusHeader}
        stats=${stats}
        connected=${connected}
        connectionState=${connectionState}
        projectLabel=${headerConfig.projectLabel}
        configuredProviders=${headerConfig.configuredProviders}
        refreshCountdownSec=${refreshCountdownSec}
      />
      <${ScreenTabs} screen=${screen} />
      <${Box} flexDirection="column" flexGrow=${1}>
        ${error
          ? html`
              <${Box} paddingX=${1}>
                <${Text} color="red" bold>Error: ${error}<//>
              <//>
            `
          : null}
        <${ScreenComponent}
          stats=${screenStats}
          sessions=${sessions}
          tasks=${tasks}
          logs=${logs}
          workflowEvents=${workflowEvents}
          workflowsState=${workflowsState}
          settingsState=${settingsState}
          logsFilterState=${logsFilterState}
          wsBridge=${bridge}
          host=${host}
          port=${port}
          connectOnly=${connectOnly}
          refreshMs=${refreshMs}
          onTasksChange=${setTasks}
          onLogsFilterStateChange=${setLogsFilterState}
          onInputCaptureChange=${setScreenInputLocked}
          onFooterHintsChange=${setFooterHints}
        />
        ${helpOpen
          ? html`
              <${Box} flexDirection="column" marginTop=${1}>
                <${HelpScreen}
                  scrollOffset=${helpScrollOffset}
                  maxRows=${helpRows}
                  groups=${CLI_SHORTCUT_GROUPS}
                />
              <//>
            `
          : null}
      <//>
      <${Box} paddingX=${1}>
        <${Text} dimColor>${footerText}<//>
      <//>
    <//>
  `;
}
