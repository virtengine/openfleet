import React, { useCallback, useEffect, useRef, useState } from "react";
import htm from "htm";
import { Box, Text, useInput } from "ink";

import wsBridge from "./lib/ws-bridge.mjs";
import StatusHeader from "./components/status-header.mjs";
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
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [screenInputLocked, setScreenInputLocked] = useState(false);
  const bridgeRef = useRef(null);

  useEffect(() => {
    let active = true;
    const bridge = wsBridge({ host, port, refreshMs });
    bridgeRef.current = bridge;

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
      setError(null);
      void refreshTasks();
    });
    on("disconnect", () => setConnected(false));
    on("error", (err) => setError(err?.message || String(err || "Connection failed")));
    on("stats", (data) => setStats(data));
    on("session:start", (session) => setSessions((prev) => upsertById(prev, session)));
    on("session:update", (session) => setSessions((prev) => upsertById(prev, session)));
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
  }, [host, port, refreshMs]);

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
      <${StatusHeader} stats=${stats} connected=${connected} screen=${screen} />
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
      <${Box} paddingX=${1} borderStyle="single">
        <${Text} dimColor>[1] Status [2] Tasks [3] Agents [q] Quit<//>
      <//>
    <//>
  `;
}
