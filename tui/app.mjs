import React, { useCallback, useEffect, useMemo, useState } from "react";
import htm from "htm";
import { Box, Text, useApp, useInput } from "ink";

import wsBridgeFactory from "./lib/ws-bridge.mjs";
import { getNextScreenForInput } from "./lib/navigation.mjs";
import StatusHeader from "./components/status-header.mjs";
import TasksScreen from "./screens/tasks.mjs";
import AgentsScreen from "./screens/agents.mjs";
import StatusScreen from "./screens/status.mjs";

const html = htm.bind(React.createElement);

const SCREENS = {
  status: StatusScreen,
  tasks: TasksScreen,
  agents: AgentsScreen,
};

export default function App({ host, port, connectOnly, initialScreen, refreshMs, wsClient }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState(initialScreen || "status");
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);

  const bridge = useMemo(
    () => wsClient || wsBridgeFactory({ host, port }),
    [host, port, wsClient],
  );

  useEffect(() => {
    const unsubscribes = [];

    unsubscribes.push(bridge.on("connect", () => {
      setConnected(true);
      setError(null);
    }));

    unsubscribes.push(bridge.on("disconnect", () => {
      setConnected(false);
    }));

    unsubscribes.push(bridge.on("error", (err) => {
      setError(err?.message || String(err || "Unknown websocket error"));
    }));

    unsubscribes.push(bridge.on("stats", (data) => {
      setStats(data || null);
    }));

    unsubscribes.push(bridge.on("sessions:update", (payload) => {
      const nextSessions = Array.isArray(payload?.sessions)
        ? payload.sessions
        : Array.isArray(payload)
          ? payload
          : [];
      setSessions(nextSessions);
    }));

    unsubscribes.push(bridge.on("session:start", (session) => {
      setSessions((previous) => [session, ...previous.filter((candidate) => candidate.id !== session?.id)]);
    }));

    unsubscribes.push(bridge.on("session:update", (session) => {
      setSessions((previous) => {
        const existingIndex = previous.findIndex((candidate) => candidate.id === session?.id);
        if (existingIndex >= 0) {
          const updated = [...previous];
          updated[existingIndex] = session;
          return updated;
        }
        return [session, ...previous];
      });
    }));

    unsubscribes.push(bridge.on("session:end", (session) => {
      setSessions((previous) => previous.filter((candidate) => candidate.id !== session?.id));
    }));

    unsubscribes.push(bridge.on("task:update", (task) => {
      setTasks((previous) => {
        const index = previous.findIndex((candidate) => candidate.id === task?.id);
        if (index >= 0) {
          const updated = [...previous];
          updated[index] = task;
          return updated;
        }
        return [...previous, task];
      });
    }));

    unsubscribes.push(bridge.on("task:create", (task) => {
      setTasks((previous) => [...previous.filter((candidate) => candidate.id !== task?.id), task]);
    }));

    unsubscribes.push(bridge.on("task:delete", (taskId) => {
      setTasks((previous) => previous.filter((task) => task.id !== taskId));
    }));

    unsubscribes.push(bridge.on("retry:update", (retryQueue) => {
      setStats((previous) => ({ ...(previous || {}), retryQueue }));
    }));

    if (typeof bridge.connect === "function") {
      bridge.connect();
    }

    return () => {
      unsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") unsubscribe();
      });
      if (typeof bridge.disconnect === "function") {
        bridge.disconnect();
      }
    };
  }, [bridge]);

  const handleInput = useCallback((input) => {
    if (input === "q") {
      exit();
      return;
    }
    setScreen((current) => getNextScreenForInput(current, input));
  }, [exit]);

  useInput((input) => {
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
        />
      <//>
      <${Box} paddingX=${1} borderStyle="single">
        <${Text} dimColor>[1] Status [2] Tasks [3] Agents [q] Quit<//>
      <//>
    <//>
  `;
}