import React, { useEffect, useMemo, useState, useCallback } from "react";
import htm from "htm";
import { Box, Text, useInput } from "ink";

import wsBridge from "./lib/ws-bridge.mjs";
import StatusHeader from "./components/status-header.mjs";
import { readTuiHeaderConfig } from "./lib/header-config.mjs";
import TasksScreen from "./screens/tasks.mjs";
import AgentsScreen from "./screens/agents.mjs";
import StatusScreen from "./screens/status.mjs";

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

  const bridge = useMemo(
    () => (typeof wsBridge === "function" ? wsBridge({ host, port }) : wsBridge),
    [host, port],
  );
  const headerConfig = useMemo(
    () => readTuiHeaderConfig(bridge?.configDir),
    [bridge?.configDir],
  );

  useEffect(() => {
    const unsubscribe = [];
    const resetRefreshCountdown = () => {
      setRefreshCountdownSec(Math.max(0, Math.ceil(Number(refreshMs || 2000) / 1000)));
    };

    unsubscribe.push(bridge.on("connect", () => {
      setConnected(true);
      setConnectionState("connected");
      setError(null);
      resetRefreshCountdown();
    }));
    unsubscribe.push(bridge.on("disconnect", () => {
      setConnected(false);
      setConnectionState("reconnecting");
    }));
    unsubscribe.push(bridge.on("reconnecting", () => {
      setConnected(false);
      setConnectionState("reconnecting");
    }));
    unsubscribe.push(bridge.on("error", (err) => {
      setError(err.message);
      if (String(err.message || "").includes("Max reconnection attempts")) {
        setConnectionState("offline");
      }
    }));
    unsubscribe.push(bridge.on("stats", (data) => {
      setStats(data);
      resetRefreshCountdown();
    }));
    unsubscribe.push(bridge.on("session:start", (session) => {
      setSessions((prev) => [...prev, session]);
    }));
    unsubscribe.push(bridge.on("session:update", (session) => {
      setSessions((prev) => {
        const existingIndex = prev.findIndex((candidate) => candidate.id === session.id);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = session;
          return updated;
        }
        return [session, ...prev];
      });
    }));
    unsubscribe.push(bridge.on("sessions:update", (payload) => {
      const nextSessions = Array.isArray(payload?.sessions)
        ? payload.sessions
        : Array.isArray(payload)
          ? payload
          : [];
      setSessions(nextSessions);
    }));
    unsubscribe.push(bridge.on("session:end", (session) => {
      setSessions((prev) => prev.filter((candidate) => candidate.id !== session.id));
    }));
    unsubscribe.push(bridge.on("task:update", (task) => {
      setTasks((prev) => {
        const idx = prev.findIndex((candidate) => candidate.id === task.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = task;
          return updated;
        }
        return [...prev, task];
      });
    }));
    unsubscribe.push(bridge.on("task:create", (task) => {
      setTasks((prev) => [...prev, task]);
    }));
    unsubscribe.push(bridge.on("task:delete", (taskId) => {
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
    }));

    const applyRetryQueue = (retryData) => {
      setStats((prev) => ({
        ...(prev || {}),
        retryQueue: retryData,
      }));
    };
    unsubscribe.push(bridge.on("retry:update", applyRetryQueue));
    unsubscribe.push(bridge.on("retry-queue-updated", applyRetryQueue));

    bridge.connect();

    return () => {
      unsubscribe.forEach((off) => {
        if (typeof off === "function") {
          off();
        }
      });
      bridge.disconnect();
    };
  }, [bridge, refreshMs]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setRefreshCountdownSec((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(intervalId);
  }, []);

  const handleKeyPress = useCallback((key) => {
    if (key === "q") {
      process.exit(0);
    }
    if (key === "1") setScreen("status");
    if (key === "2") setScreen("tasks");
    if (key === "3") setScreen("agents");
  }, []);

  useInput((input) => {
    handleKeyPress(input);
  });

  const ScreenComponent = SCREENS[screen] || StatusScreen;
  const screenStats = screen === "status" ? stats : undefined;
  const renderedScreen = useMemo(() => html`
    <${ScreenComponent}
      stats=${screenStats}
      sessions=${sessions}
      tasks=${tasks}
      wsBridge=${bridge}
      host=${host}
      port=${port}
      connectOnly=${connectOnly}
      refreshMs=${refreshMs}
    />
  `, [ScreenComponent, screenStats, sessions, tasks, bridge, host, port, connectOnly, refreshMs]);

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
        ${renderedScreen}
      <//>
    <//>
  `;
}
