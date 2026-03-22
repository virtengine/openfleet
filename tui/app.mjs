import React, { useState, useEffect, useCallback } from "react";
import htm from "htm";
import { Box, Text, useInput } from "ink";

import wsBridge from "./lib/ws-bridge.mjs";
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

export default function App({ host, port, connectOnly, initialScreen, refreshMs }) {
  const [screen, setScreen] = useState(initialScreen || "status");
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const bridge = wsBridge({ host, port });

    bridge.on("connect", () => {
      setConnected(true);
      setError(null);
    });

    bridge.on("disconnect", () => {
      setConnected(false);
    });

    bridge.on("error", (err) => {
      setError(err.message);
    });

    bridge.on("stats", (data) => {
      setStats(data);
    });

    bridge.on("session:start", (session) => {
      setSessions((prev) => [...prev, session]);
    });

    bridge.on("session:update", (session) => {
      setSessions((prev) => {
        const existingIndex = prev.findIndex((candidate) => candidate.id === session.id);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = session;
          return updated;
        }
        return [session, ...prev];
      });
    });

    bridge.on("sessions:update", (payload) => {
      const nextSessions = Array.isArray(payload?.sessions)
        ? payload.sessions
        : Array.isArray(payload)
          ? payload
          : [];
      setSessions(nextSessions);
    });

    bridge.on("session:end", (session) => {
      setSessions((prev) => prev.filter((candidate) => candidate.id !== session.id));
    });

    bridge.on("task:update", (task) => {
      setTasks((prev) => {
        const idx = prev.findIndex((candidate) => candidate.id === task.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = task;
          return updated;
        }
        return [...prev, task];
      });
    });

    bridge.on("task:create", (task) => {
      setTasks((prev) => [...prev, task]);
    });

    bridge.on("task:delete", (taskId) => {
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
    });

    const applyRetryQueue = (retryData) => {
      setStats((prev) => ({
        ...(prev || {}),
        retryQueue: retryData,
      }));
    };

    const retryUnsubscribes = [];

    retryUnsubscribes.push(bridge.on("retry:update", applyRetryQueue));
    retryUnsubscribes.push(bridge.on("retry-queue-updated", applyRetryQueue));

    bridge.connect();

    return () => {
      retryUnsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      });

    return () => {
      retryUnsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      });

    return () => {
      retryUnsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      });

    return () => {
      retryUnsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      });

    return () => {
      retryUnsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      });

    return () => {
      retryUnsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      });

    return () => {
      retryUnsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      });
      bridge.disconnect();
    };
  }, [host, port]);

  const handleKeyPress = useCallback((key) => {
    if (key === "q") {
      process.exit(0);
    }
    if (key === "1") {
      setScreen("status");
    }
    if (key === "2") {
      setScreen("tasks");
    }
    if (key === "3") {
      setScreen("agents");
    }
  }, []);

  useInput((input) => {
    handleKeyPress(input);
  });

  const ScreenComponent = SCREENS[screen] || StatusScreen;
  const wsBridgeInstance = typeof wsBridge === "function" ? wsBridge({ host, port }) : wsBridge;

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
          wsBridge=${wsBridgeInstance}
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
