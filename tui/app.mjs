import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import htm from "htm";
import { Box, Text, useInput } from "ink";

import wsBridge from "./lib/ws-bridge.mjs";
import StatusHeader from "./components/status-header.mjs";
import { readTuiHeaderConfig } from "./lib/header-config.mjs";
import TasksScreen from "./screens/tasks.mjs";
import AgentsScreen from "./screens/agents.mjs";
import StatusScreen from "./screens/status.mjs";
import { listTasksFromApi } from "../ui/tui/tasks-screen-helpers.js";

const html = htm.bind(React.createElement);

const SCREENS = {
  status: StatusScreen,
  tasks: TasksScreen,
  agents: AgentsScreen,
};

function ScreenTabs({ screen }) {
  const navItems = [
    { key: "status", num: "1", label: "Status" },
    { key: "tasks", num: "2", label: "Tasks" },
    { key: "agents", num: "3", label: "Agents" },
  ];

  return html`
    <${Box} paddingX=${1} borderStyle="single">
      ${navItems.map((item, index) => html`
        <${React.Fragment} key=${item.key}>
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

function upsertById(items, nextItem) {
  const index = items.findIndex((item) => item.id === nextItem.id);
  if (index === -1) return [nextItem, ...items];
  const next = [...items];
  next[index] = { ...next[index], ...nextItem };
  return next;
}

export default function App({ host, port, connectOnly, initialScreen, refreshMs }) {
  const [screen, setScreen] = useState(initialScreen || "status");
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState("offline");
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [refreshCountdownSec, setRefreshCountdownSec] = useState(
    Math.max(0, Math.ceil(Number(refreshMs || 2000) / 1000)),
  );
  const [screenInputLocked, setScreenInputLocked] = useState(false);
  const [headerConfig, setHeaderConfig] = useState(() => readTuiHeaderConfig());

  const bridge = useMemo(
    () => (typeof wsBridge === "function" ? wsBridge({ host, port, refreshMs }) : wsBridge),
    [host, port, refreshMs],
  );
  const bridgeRef = useRef(bridge);

  useEffect(() => {
    let active = true;
    bridgeRef.current = bridge;
    setHeaderConfig(readTuiHeaderConfig(bridge?.configDir));

    const resetRefreshCountdown = () => {
      setRefreshCountdownSec(Math.max(0, Math.ceil(Number(refreshMs || 2000) / 1000)));
    };
    const refreshTasks = async () => {
      try {
        const nextTasks = await listTasksFromApi();
        if (active) setTasks(nextTasks);
      } catch (err) {
        if (active) setError(String(err?.message || err || "Failed to load tasks"));
      }
    };

    const unsubscribes = [];
    const on = (eventName, handler) => {
      const unsubscribe = bridge.on(eventName, handler);
      unsubscribes.push(unsubscribe);
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
    on("error", (err) => {
      const message = err?.message || String(err || "Connection failed");
      setError(message);
      if (String(message).includes("Max reconnection attempts")) {
        setConnectionState("offline");
      }
    });
    on("stats", (data) => {
      setStats(data);
      resetRefreshCountdown();
    });
    on("session:start", (session) => {
      setSessions((prev) => upsertById(prev, session));
    });
    on("session:update", (session) => {
      setSessions((prev) => upsertById(prev, session));
    });
    on("sessions:update", (payload) => {
      const nextSessions = Array.isArray(payload?.sessions)
        ? payload.sessions
        : Array.isArray(payload)
          ? payload
          : [];
      setSessions(nextSessions);
    });
    on("session:end", (session) => {
      setSessions((prev) => prev.filter((item) => item.id !== session.id));
    });
    on("tasks:update", () => {
      void refreshTasks();
    });
    on("task:update", (task) => {
      setTasks((prev) => upsertById(prev, task));
    });
    on("task:create", (task) => {
      setTasks((prev) => upsertById(prev, task));
    });
    on("task:delete", (taskId) => {
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
    });
    on("retry:update", (retryQueue) => {
      setStats((prev) => ({ ...(prev || {}), retryQueue }));
    });
    on("retry-queue-updated", (retryQueue) => {
      setStats((prev) => ({ ...(prev || {}), retryQueue }));
    });

    bridge.connect();
    void refreshTasks();

    return () => {
      active = false;
      unsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") unsubscribe();
      });
      bridge.disconnect();
      bridgeRef.current = null;
    };
  }, [bridge, refreshMs]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setRefreshCountdownSec((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(intervalId);
  }, []);

  const handleKeyPress = useCallback((key) => {
    if (key === "q") process.exit(0);
    if (key === "1") setScreen("status");
    if (key === "2") setScreen("tasks");
    if (key === "3") setScreen("agents");
  }, []);

  useInput((input) => {
    if (screenInputLocked) return;
    handleKeyPress(input);
  });

  const ScreenComponent = SCREENS[screen] || StatusScreen;

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
          stats=${stats}
          sessions=${sessions}
          tasks=${tasks}
          wsBridge=${bridgeRef.current}
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
