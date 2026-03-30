import React, { useCallback, useEffect, useMemo, useState } from "react";
import htm from "htm";
import { Box, Text, useApp, useInput } from "ink";

import wsBridgeFactory from "./lib/ws-bridge.mjs";
import { getNextScreenForInput } from "./lib/navigation.mjs";
import StatusHeader from "./components/status-header.mjs";
import TasksScreen from "./screens/tasks.mjs";
import AgentsScreen from "./screens/agents.mjs";
import StatusScreen from "./screens/status.mjs";
import TelemetryScreen from "./screens/telemetry.mjs";
import { readTuiHeaderConfig } from "./lib/header-config.mjs";
import { listTasksFromApi } from "../ui/tui/tasks-screen-helpers.js";

const html = htm.bind(React.createElement);

const SCREENS = {
  status: StatusScreen,
  tasks: TasksScreen,
  agents: AgentsScreen,
  telemetry: TelemetryScreen,
};

function ScreenTabs({ screen }) {
  const navItems = [
    { key: "status", num: "1", label: "Status" },
    { key: "tasks", num: "2", label: "Tasks" },
    { key: "agents", num: "3", label: "Agents" },
    { key: "telemetry", num: "4", label: "Telemetry" },
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
  const [screen, setScreen] = useState(initialScreen || "status");
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState("offline");
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [screenInputLocked, setScreenInputLocked] = useState(false);
  const [refreshCountdownSec, setRefreshCountdownSec] = useState(
    Math.max(0, Math.ceil(Number(refreshMs || 2000) / 1000)),
  );

  const bridge = useMemo(
    () => wsClient || wsBridgeFactory({ host, port }),
    [host, port, wsClient],
  );
  const headerConfig = useMemo(
    () => readTuiHeaderConfig(bridge?.configDir),
    [bridge?.configDir],
  );

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
    on("task:update", (task) => {
      setTasks((previous) => upsertById(previous, task));
    });
    on("task:create", (task) => {
      setTasks((previous) => upsertById(previous, task));
    });
    on("task:delete", (taskId) => {
      setTasks((previous) => previous.filter((task) => task.id !== taskId));
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
    const intervalId = setInterval(() => {
      setRefreshCountdownSec((previous) => Math.max(0, previous - 1));
    }, 1000);
    return () => clearInterval(intervalId);
  }, []);

  const handleInput = useCallback((input) => {
    if (input === "q") {
      exit();
      return;
    }
    setScreen((current) => getNextScreenForInput(current, input));
  }, [exit]);

  useInput((input) => {
    if (screenInputLocked) return;
    handleInput(input);
  });

  const ScreenComponent = SCREENS[screen] || StatusScreen;
  const screenStats = screen === "status" ? stats : undefined;

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
          wsBridge=${bridge}
          host=${host}
          port=${port}
          connectOnly=${connectOnly}
          refreshMs=${refreshMs}
          onTasksChange=${setTasks}
          onInputCaptureChange=${setScreenInputLocked}
        />
      <//>
    <//>
  `;
}
