/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – API Client & WebSocket
 *  Handles REST calls, WS connection, and command sending
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";
import { getInitData } from "./telegram.js";

/** Map of in-flight GET request promises, keyed by path */
const _inflight = new Map();

/** Map of in-flight POST/PATCH request promises, keyed by path + request ID */
const _inflightPost = new Map();

/** Response cache: path → { data, cached_at_ms, ttl_ms } for GET requests */
const _responseCache = new Map();

/** Per-endpoint timeout configuration (ms). Defaults to 30s if not specified. */
const _ENDPOINT_TIMEOUTS = {
  '/api/settings': 10000,        // Settings fetch is quick
  '/api/tasks': 15000,           // Tasks may include aggregation
  '/api/tasks/summary': 5000,    // Summary is lightweight
  '/api/status': 5000,           // Status ping
  '/api/config': 10000,          // Config load
  '/api/agents': 8000,           // Agents list
  '/api/worktrees': 20000,       // Worktrees may take longer
  // POST endpoints (default 30s, override for special upload endpoints)
  '/api/settings/update': 10000, // Settings save
  '/api/command': 20000,         // Command execution
};

function _getEndpointTimeout(path, method = 'GET') {
  const key = path.split('?')[0]; // Ignore query string
  return _ENDPOINT_TIMEOUTS[key] || (method === 'POST' ? 30000 : 30000);
}

/** Generates a unique request ID (used for deduplication) */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/** Reactive signal: whether the WebSocket is currently connected */
export const wsConnected = signal(false);
/** Reactive signal: WebSocket round-trip latency in ms (null if unknown) */
export const wsLatency = signal(null);
/** Reactive signal: countdown seconds until next reconnect attempt (null when connected) */
export const wsReconnectIn = signal(null);
/** Reactive signal: number of reconnections since last user-initiated action */
export const wsReconnectCount = signal(0);
/** Reactive signal: count of in-flight apiFetch calls (drives top loading bar) */
export const loadingCount = signal(0);

let _loadingSuppressionDepth = 0;
let _loadingForceDepth = 0;

async function withDepthCounter(kind, fn) {
  if (kind === "suppress") _loadingSuppressionDepth += 1;
  else _loadingForceDepth += 1;
  try {
    return await fn();
  } finally {
    if (kind === "suppress") {
      _loadingSuppressionDepth = Math.max(0, _loadingSuppressionDepth - 1);
    } else {
      _loadingForceDepth = Math.max(0, _loadingForceDepth - 1);
    }
  }
}

export function withLoadingSuppressed(fn) {
  return withDepthCounter("suppress", fn);
}

export function withLoadingTracked(fn) {
  return withDepthCounter("force", fn);
}

/* ─── REST API Client ─── */

/**
 * Fetch from the API (same-origin). Automatically injects the
 * X-Telegram-InitData header and handles JSON parsing / errors.
 *
 * @param {string} path  - API path, e.g. "/api/status"
 * @param {RequestInit & {_silent?: boolean}} options
 * @returns {Promise<any>} parsed JSON body
 */
export function apiFetch(path, options = {}) {
  const headers = { ...options.headers };
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!isFormData) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  const initData = getInitData();
  if (initData) {
    headers["X-Telegram-InitData"] = initData;
  }

  const silent = Boolean(options._silent);
  const trackLoadingOption = options._trackLoading;
  delete options._silent;
  delete options._trackLoading;

  const forceLoading = trackLoadingOption === true || _loadingForceDepth > 0;
  const suppressLoading = trackLoadingOption === false || _loadingSuppressionDepth > 0;
  const trackLoading = !suppressLoading && (forceLoading || !silent);

  // Check response cache first (stale-while-revalidate)
  const isGet = !options.method || options.method === "GET";
  if (isGet && !options.body && !options._noCache) {
    const cached = _responseCache.get(path);
    if (cached) {
      const age = Date.now() - cached.cached_at_ms;
      if (age < cached.ttl_ms) {
        // Cache hit — return immediately
        return Promise.resolve(cached.data);
      }
    }
  }

  // Deduplicate concurrent identical GETs
  if (isGet && !options.body) {
    if (_inflight.has(path)) {
      return _inflight.get(path);
    }
  }

  // Generate request ID for POST/PATCH deduplication (prevent double-saves)
  let requestId = options._requestId;
  const isPost = options.method === "POST" || options.method === "PATCH";
  if (isPost && !requestId) {
    requestId = generateRequestId();
  }
  const postKey = isPost && requestId ? `${path}:${requestId}` : null;
  
  // Check if identical POST is already in flight (within 5 second window)
  if (postKey && _inflightPost.has(postKey)) {
    const inFlightEntry = _inflightPost.get(postKey);
    if (Date.now() - inFlightEntry.createdAt < 5000) {
      return inFlightEntry.promise;
    } else {
      // Stale entry - clean up
      _inflightPost.delete(postKey);
    }
  }

  // Retry config for network-level failures only (not 4xx/5xx HTTP errors)
  const MAX_FETCH_RETRIES = 2;
  const FETCH_RETRY_BASE_MS = 800;
  const endpointTimeout = _getEndpointTimeout(path, options.method);

  const promise = (async () => {
    if (trackLoading) loadingCount.value += 1;
    let res;
    let fetchAttempt = 0;
    let timeoutHandle = null;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Request timeout after ${endpointTimeout}ms`)),
          endpointTimeout
        );
      });

      while (fetchAttempt <= MAX_FETCH_RETRIES) {
        try {
          const fetchOptions = { ...options, headers };
          // Inject request ID into headers for server-side dedup logging
          if (requestId && isPost) {
            fetchOptions.headers["X-Request-ID"] = requestId;
          }
          const fetchPromise = fetch(path, fetchOptions);
          res = await Promise.race([fetchPromise, timeoutPromise]);
          break; // success — exit retry loop
        } catch (networkErr) {
          fetchAttempt++;
          if (fetchAttempt > MAX_FETCH_RETRIES || silent) throw networkErr;
          await new Promise((r) => setTimeout(r, FETCH_RETRY_BASE_MS * fetchAttempt));
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Request failed (${res.status})`);
      }
      const data = await res.json();
      // Cache successful GET responses
      if (isGet && !options.body) {
        const ttlMs = options._cacheTtl || 10000; // Default 10s
        _responseCache.set(path, { data, cached_at_ms: Date.now(), ttl_ms: ttlMs });
      }
      return data;
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
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (trackLoading) {
        loadingCount.value = Math.max(0, loadingCount.value - 1);
      }
      if (isGet && !options.body) _inflight.delete(path);
      if (postKey) _inflightPost.delete(postKey);
    }
  })();

  if (isGet && !options.body) _inflight.set(path, promise);
  if (postKey) _inflightPost.set(postKey, { promise, createdAt: Date.now() });
  return promise;
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
    // Auto-reconnect with exponential backoff + jitter (max 30 s)
    if (reconnectTimer) clearTimeout(reconnectTimer);
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 500; // 0-500ms random variation
    const delayWithJitter = retryMs + jitter;
    startCountdown(delayWithJitter);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delayWithJitter);
    // Exponential backoff with jitter
    retryMs = Math.min(30000, Math.floor(retryMs * 2 + Math.random() * 1000));
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

/* ─── Message Batching (reduce WS overhead) ─── */

/** @type {Array<any>} Pending messages to batch */
let _wsMessageBatch = [];
/** @type {ReturnType<typeof setTimeout>|null} Batch timeout handle */
let _wsBatchTimeout = null;
const WS_BATCH_MAX_SIZE = 50; // Flush when this many messages queued
const WS_BATCH_MAX_DELAY_MS = 100; // Or when this much time passes

function _flushWsBatch() {
  if (_wsBatchTimeout) {
    clearTimeout(_wsBatchTimeout);
    _wsBatchTimeout = null;
  }
  if (_wsMessageBatch.length === 0) return;
  
  const messages = _wsMessageBatch;
  _wsMessageBatch = [];
  
  if (messages.length === 1) {
    // Single message — send directly
    wsSendImmediate(messages[0]);
  } else {
    // Multiple messages — batch them
    wsSendImmediate({ type: \"batch\", messages });
  }
}

function wsSendImmediate(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(typeof data === \"string\" ? data : JSON.stringify(data));
  }
}

/**
 * Send a raw JSON message over the open WebSocket.
 * Messages are batched to reduce bandwidth and overhead.
 * @param {any} data
 * @param {{batch?: boolean}} opts
 */
export function wsSend(data, opts = {}) {
  if (opts.batch === false) {
    // Explicit no-batch (for critical messages like pings)
    wsSendImmediate(data);
    return;
  }
  
  // Add to batch
  _wsMessageBatch.push(data);
  
  // Flush if batch is full
  if (_wsMessageBatch.length >= WS_BATCH_MAX_SIZE) {
    _flushWsBatch();
    return;
  }
  
  // Schedule flush timeout if not already scheduled
  if (!_wsBatchTimeout) {
    _wsBatchTimeout = setTimeout(_flushWsBatch, WS_BATCH_MAX_DELAY_MS);
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
