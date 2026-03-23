import React, { useCallback, useEffect, useMemo, useState } from "react";
import htm from "htm";
import { Box, Text, useApp, useInput } from "ink";

import wsBridgeFactory from "./lib/ws-bridge.mjs";
import { getNextScreenForInput } from "./lib/navigation.mjs";
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
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [screenInputLocked, setScreenInputLocked] = useState(false);

  const bridge = useMemo(
    () => wsClient || wsBridgeFactory({ host, port }),
    [host, port, wsClient],
  );

  useEffect(() => {
    let active = true;
    const unsubscribes = [];

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
      setError(null);
      void refreshTasks();
    });
    on("disconnect", () => {
      setConnected(false);
    });
    on("error", (err) => {
      setError(err?.message || String(err || "Unknown websocket error"));
    });
    on("monitor:stats", (data) => {
      setStats(data || null);
    });
    on("stats", (data) => {
      setStats(data || null);
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

  return html`
    <${Box} flexDirection="column" minHeight=${0}>
      <${StatusHeader}
        stats=${stats}
        connected=${connected}
        screen=${screen}
      />
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
          wsBridge=${bridge}
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