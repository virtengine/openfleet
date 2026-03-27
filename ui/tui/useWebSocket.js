import * as ReactModule from "react";

const React = ReactModule.default ?? ReactModule;
const useEffect = ReactModule.useEffect ?? React.useEffect;
const useMemo = ReactModule.useMemo ?? React.useMemo;
const useRef = ReactModule.useRef ?? React.useRef;
const useState = ReactModule.useState ?? React.useState;

import { TuiWsBridge, buildTuiWebSocketUrl } from "../../tui/lib/ws-bridge.mjs";

function applyTaskPatch(tasks, payload) {
  const next = Array.isArray(tasks) ? [...tasks] : [];
  const reason = String(payload?.reason || "").toLowerCase();
  const sourceEvent = String(payload?.sourceEvent || "").toLowerCase();
  const taskId = payload?.taskId ?? payload?.patch?.id;
  const patch = taskId ? { ...(payload?.patch || {}), id: taskId } : null;
  const index = next.findIndex((task) => String(task?.id || "") === String(taskId || ""));

  if (reason.includes("delete") || sourceEvent.includes("delete")) {
    if (index >= 0) next.splice(index, 1);
    return next;
  }

  if (!patch) return next;
  if (index >= 0) next[index] = { ...next[index], ...patch };
  else next.unshift(patch);
  return next;
}

function upsertSession(sessions, session) {
  const next = Array.isArray(sessions) ? [...sessions] : [];
  const sessionId = String(session?.id || "");
  if (!sessionId) return next;
  const index = next.findIndex((entry) => String(entry?.id || "") === sessionId);
  if (index >= 0) next[index] = { ...next[index], ...session };
  else next.unshift(session);
  return next;
}

export function buildBusWebSocketUrl(options) {
  return buildTuiWebSocketUrl(options);
}

export function useWebSocket({ host, port, configDir, protocol = "ws" }) {
  const bridgeRef = useRef(null);
  const [state, setState] = useState({
    connected: false,
    connectionStatus: "connecting",
    reconnectPulse: false,
    reconnectCount: 0,
    stats: null,
    sessions: [],
    tasks: [],
    logs: [],
    workflows: [],
    error: null,
    lastEventAt: null,
  });

  useEffect(() => {
    const bridge = new TuiWsBridge({ host, port, configDir, protocol });
    bridgeRef.current = bridge;

    const unsubscribers = [
      bridge.on("connect", () => {
        setState((prev) => ({
          ...prev,
          connected: true,
          connectionStatus: "connected",
          reconnectPulse: false,
          error: null,
          lastEventAt: Date.now(),
        }));
      }),
      bridge.on("disconnect", () => {
        setState((prev) => ({
          ...prev,
          connected: false,
          connectionStatus: "reconnecting",
          reconnectCount: prev.reconnectCount + 1,
          lastEventAt: Date.now(),
        }));
      }),
      bridge.on("error", (error) => {
        setState((prev) => ({
          ...prev,
          connected: false,
          connectionStatus: prev.connected ? "disconnected" : "reconnecting",
          error: String(error?.message || "WebSocket error"),
          lastEventAt: Date.now(),
        }));
      }),
      bridge.on("monitor:stats", (stats) => {
        setState((prev) => ({ ...prev, stats: stats || null, lastEventAt: Date.now() }));
      }),
      bridge.on("stats", (stats) => {
        setState((prev) => ({ ...prev, stats: stats || prev.stats, lastEventAt: Date.now() }));
      }),
      bridge.on("sessions:update", (payload) => {
        const sessions = Array.isArray(payload?.sessions)
          ? payload.sessions
          : Array.isArray(payload)
            ? payload
            : [];
        setState((prev) => ({ ...prev, sessions, lastEventAt: Date.now() }));
      }),
      bridge.on("session:event", (payload) => {
        const session = payload?.session;
        if (!session) return;
        setState((prev) => ({
          ...prev,
          sessions: upsertSession(prev.sessions, session),
          lastEventAt: Date.now(),
        }));
      }),
      bridge.on("tasks:update", (payload) => {
        setState((prev) => ({
          ...prev,
          tasks: applyTaskPatch(prev.tasks, payload),
          lastEventAt: Date.now(),
        }));
      }),
      bridge.on("logs:stream", (payload) => {
        setState((prev) => ({
          ...prev,
          logs: [payload, ...prev.logs].slice(0, 100),
          lastEventAt: Date.now(),
        }));
      }),
      bridge.on("workflow:status", (payload) => {
        setState((prev) => ({
          ...prev,
          workflows: [payload, ...prev.workflows].slice(0, 50),
          lastEventAt: Date.now(),
        }));
      }),
    ];

    bridge.connect();

    return () => {
      for (const unsubscribe of unsubscribers) {
        if (typeof unsubscribe === "function") unsubscribe();
      }
      bridge.disconnect();
      bridgeRef.current = null;
    };
  }, [configDir, host, port, protocol]);

  useEffect(() => {
    if (state.connectionStatus !== "reconnecting") {
      setState((prev) => (prev.reconnectPulse ? { ...prev, reconnectPulse: false } : prev));
      return undefined;
    }

    const timer = setInterval(() => {
      setState((prev) => ({ ...prev, reconnectPulse: !prev.reconnectPulse }));
    }, 450);

    return () => clearInterval(timer);
  }, [state.connectionStatus]);

  return useMemo(() => ({
    ...state,
    send(type, payload = {}) {
      bridgeRef.current?.send(type, payload);
    },
    url: buildTuiWebSocketUrl({ host, port, protocol }),
  }), [host, port, protocol, state]);
}

export default useWebSocket;
