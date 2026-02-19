/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – API Client & WebSocket
 *  Handles REST calls, WS connection, and command sending
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";
import { getInitData } from "./telegram.js";

/** Reactive signal: whether the WebSocket is currently connected */
export const wsConnected = signal(false);
/** Reactive signal: WebSocket round-trip latency in ms (null if unknown) */
export const wsLatency = signal(null);
/** Reactive signal: countdown seconds until next reconnect attempt (null when connected) */
export const wsReconnectIn = signal(null);
/** Reactive signal: number of reconnections since last user-initiated action */
export const wsReconnectCount = signal(0);

/* ─── REST API Client ─── */

/**
 * Fetch from the API (same-origin). Automatically injects the
 * X-Telegram-InitData header and handles JSON parsing / errors.
 *
 * @param {string} path  - API path, e.g. "/api/status"
 * @param {RequestInit & {_silent?: boolean}} options
 * @returns {Promise<any>} parsed JSON body
 */
export async function apiFetch(path, options = {}) {
  const headers = { ...options.headers };
  headers["Content-Type"] = headers["Content-Type"] || "application/json";

  const initData = getInitData();
  if (initData) {
    headers["X-Telegram-InitData"] = initData;
  }

  const silent = options._silent;
  delete options._silent;

  try {
    const res = await fetch(path, { ...options, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Request failed (${res.status})`);
    }
    return await res.json();
  } catch (err) {
    // Re-throw so callers can catch, but don't toast on silent requests
    if (!silent) {
      // Dispatch a custom event so the state layer can show a toast
      try {
        globalThis.dispatchEvent(
          new CustomEvent("ve:api-error", { detail: { message: err.message } }),
        );
      } catch {
        /* noop */
      }
    }
    throw err;
  }
}

/* ─── Command Sending ─── */

/**
 * Send a slash-command to the backend via POST /api/command.
 * @param {string} cmd  - e.g. "/status" or "/starttask abc123"
 * @returns {Promise<any>}
 */
export async function sendCommandToChat(cmd) {
  return apiFetch("/api/command", {
    method: "POST",
    body: JSON.stringify({ command: cmd }),
  });
}

/* ─── WebSocket ─── */

/** @type {WebSocket|null} */
let ws = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let reconnectTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let countdownTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let pingTimer = null;
let retryMs = 1000;

/** Registered message handlers */
const wsHandlers = new Set();

/**
 * Register a handler for incoming WS messages.
 * Returns an unsubscribe function.
 * @param {(data: any) => void} handler
 * @returns {() => void}
 */
export function onWsMessage(handler) {
  wsHandlers.add(handler);
  return () => wsHandlers.delete(handler);
}

/** Clear the reconnect countdown timer and reset signal */
function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  wsReconnectIn.value = null;
}

/** Start a countdown timer that ticks wsReconnectIn every second */
function startCountdown(ms) {
  clearCountdown();
  let remaining = Math.ceil(ms / 1000);
  wsReconnectIn.value = remaining;
  countdownTimer = setInterval(() => {
    remaining -= 1;
    wsReconnectIn.value = Math.max(0, remaining);
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 1000);
}

/** Start the client-side ping interval (every 30s) */
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    wsSend({ type: "ping", ts: Date.now() });
  }, 30_000);
}

/** Stop the client-side ping interval */
function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/**
 * Open (or re-open) a WebSocket connection to /ws.
 * Automatically reconnects on close with exponential backoff.
 */
export function connectWebSocket() {
  // Prevent double connections
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const proto = globalThis.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = new URL(`${proto}://${globalThis.location.host}/ws`);

  const initData = getInitData();
  if (initData) {
    wsUrl.searchParams.set("initData", initData);
  } else {
    // Pass session token from cookie for browser-based WS auth
    const m = (document.cookie || "").match(/(?:^|;\s*)ve_session=([^;]+)/);
    if (m) wsUrl.searchParams.set("token", m[1]);
  }

  const socket = new WebSocket(wsUrl.toString());
  ws = socket;

  socket.addEventListener("open", () => {
    wsConnected.value = true;
    wsLatency.value = null;
    retryMs = 1000; // reset backoff on successful connect
    clearCountdown();
    startPing();
  });

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data || "{}");
    } catch {
      return;
    }

    // Handle pong → calculate RTT
    if (msg.type === "pong" && typeof msg.ts === "number") {
      wsLatency.value = Date.now() - msg.ts;
      return;
    }

    // Handle server-initiated ping → reply with pong
    if (msg.type === "ping" && typeof msg.ts === "number") {
      wsSend({ type: "pong", ts: msg.ts });
      return;
    }

    // Handle log-lines streaming
    if (msg.type === "log-lines" && Array.isArray(msg.lines)) {
      try {
        globalThis.dispatchEvent(
          new CustomEvent("ve:log-lines", { detail: { lines: msg.lines } }),
        );
      } catch {
        /* noop */
      }
      return;
    }

    // Dispatch to all registered handlers
    for (const handler of wsHandlers) {
      try {
        handler(msg);
      } catch {
        /* handler errors shouldn't crash the WS loop */
      }
    }
  });

  socket.addEventListener("close", () => {
    wsConnected.value = false;
    wsLatency.value = null;
    ws = null;
    stopPing();
    wsReconnectCount.value += 1;
    // Auto-reconnect with exponential backoff (max 15 s)
    if (reconnectTimer) clearTimeout(reconnectTimer);
    startCountdown(retryMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, retryMs);
    retryMs = Math.min(15000, retryMs * 2);
  });

  socket.addEventListener("error", () => {
    wsConnected.value = false;
  });
}

/**
 * Disconnect the WebSocket and cancel any pending reconnect.
 */
export function disconnectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearCountdown();
  stopPing();
  if (ws) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    ws = null;
  }
  wsConnected.value = false;
  wsLatency.value = null;
}

/**
 * Send a raw JSON message over the open WebSocket.
 * @param {any} data
 */
export function wsSend(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }
}

/* ─── Log Streaming ─── */

/**
 * Subscribe to real-time log streaming over the WebSocket.
 * @param {"system"|"agent"} logType
 * @param {string} [query] - optional filter query (e.g. agent name)
 */
export function subscribeToLogs(logType, query) {
  wsSend({ type: "subscribe-logs", logType, ...(query ? { query } : {}) });
}

/**
 * Unsubscribe from log streaming.
 */
export function unsubscribeFromLogs() {
  wsSend({ type: "unsubscribe-logs" });
}

/**
 * Reset the reconnect counter (call on user-initiated actions).
 */
export function resetReconnectCount() {
  wsReconnectCount.value = 0;
}
