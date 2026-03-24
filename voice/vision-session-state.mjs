/**
 * vision-session-state.mjs — Shared in-memory state for live vision frames.
 *
 * Keeps the latest frame per session so voice tools can query the current
 * visual context without relying on chat-posted summaries.
 */

const _visionSessionState = new Map();

const MAX_TRACE_TURNS = 12;
const MAX_TURN_EVENTS = 40;
const MAX_TURN_FINGERPRINTS = 32;
const SECRET_KEY_PATTERN = /(token|key|secret|password|authorization|credential|cookie|client_secret|access_token)/i;

function getSessionKey(sessionId) {
  return String(sessionId || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function redactSecretLikeText(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  if (/^bearer\s+/i.test(raw)) return "Bearer [redacted]";
  if (/^sk-[a-z0-9_-]+/i.test(raw)) return "[redacted]";
  if (/api[_-]?key/i.test(raw) || /access[_-]?token/i.test(raw) || /client[_-]?secret/i.test(raw)) {
    return "[redacted]";
  }
  return raw;
}

function sanitizeTraceValue(value, key = "", seen = new WeakSet()) {
  if (value == null) return value;

  if (typeof value === "string") {
    return SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactSecretLikeText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item, key, seen));
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (typeof childValue === "function") continue;
    output[childKey] = sanitizeTraceValue(childValue, childKey, seen);
  }
  return output;
}

function ensureTraceState(state) {
  if (!state.voiceTurnTrace || typeof state.voiceTurnTrace !== "object") {
    state.voiceTurnTrace = {
      activeTurnId: null,
      updatedAt: 0,
      turns: [],
    };
  }
  return state.voiceTurnTrace;
}

function ensureTurn(trace, turnId, metadata = {}) {
  const resolvedTurnId = String(turnId || trace.activeTurnId || `voice-turn-${Date.now()}`).trim();
  let turn = trace.turns.find((entry) => entry.turnId === resolvedTurnId);
  if (!turn) {
    turn = {
      turnId: resolvedTurnId,
      status: "active",
      startedAt: nowIso(),
      endedAt: null,
      metadata: sanitizeTraceValue(metadata),
      events: [],
      dispatchFingerprints: [],
    };
    trace.turns.push(turn);
    if (trace.turns.length > MAX_TRACE_TURNS) {
      trace.turns.splice(0, trace.turns.length - MAX_TRACE_TURNS);
    }
  } else if (metadata && Object.keys(metadata).length > 0) {
    turn.metadata = {
      ...(turn.metadata || {}),
      ...sanitizeTraceValue(metadata),
    };
  }
  trace.activeTurnId = resolvedTurnId;
  trace.updatedAt = Date.now();
  return turn;
}

function annotateTurnFromEvent(turn, event) {
  if (event.reason && !turn.reason) {
    turn.reason = event.reason;
  }
  if (event.category) {
    turn.category = event.category;
  }
  if (event.expected || event.actual) {
    turn.mismatch = {
      ...(turn.mismatch || {}),
      ...(event.expected ? { expected: event.expected } : {}),
      ...(event.actual ? { actual: event.actual } : {}),
    };
  }
  if (event.type === "turn.abort") {
    turn.status = "aborted";
    turn.endedAt = turn.endedAt || event.at;
  }
  if (event.type === "turn.end") {
    if (turn.status !== "aborted") {
      turn.status = event.status || event.outcome || "completed";
    }
    turn.endedAt = turn.endedAt || event.at;
  }
}

export function getVisionSessionState(sessionId) {
  const key = getSessionKey(sessionId);
  if (!key) return null;
  if (!_visionSessionState.has(key)) {
    _visionSessionState.set(key, {
      lastFrameHash: null,
      lastReceiptAt: 0,
      lastAnalyzedHash: null,
      lastAnalyzedAt: 0,
      lastSummary: "",
      inFlight: null,
      lastFrameDataUrl: "",
      lastFrameSource: "screen",
      lastFrameWidth: null,
      lastFrameHeight: null,
      voiceTurnTrace: null,
    });
  }
  return _visionSessionState.get(key);
}

export function clearVisionSessionState(sessionId) {
  const key = getSessionKey(sessionId);
  if (!key) return false;
  return _visionSessionState.delete(key);
}

export function beginVoiceTurnTrace(sessionId, metadata = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, metadata?.turnId, metadata);
  appendVoiceTurnTraceEvent(sessionId, {
    turnId: turn.turnId,
    type: "turn.start",
    ...sanitizeTraceValue(metadata),
  });
  return { turnId: turn.turnId, status: turn.status };
}

export function appendVoiceTurnTraceEvent(sessionId, event = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, event?.turnId, event?.metadata || {});
  const sanitized = sanitizeTraceValue(event);
  const traceEvent = {
    at: nowIso(),
    type: String(sanitized?.type || "trace.event").trim() || "trace.event",
    ...sanitized,
  };
  delete traceEvent.metadata;
  delete traceEvent.turnId;

  turn.events.push(traceEvent);
  if (turn.events.length > MAX_TURN_EVENTS) {
    turn.events.splice(0, turn.events.length - MAX_TURN_EVENTS);
  }
  annotateTurnFromEvent(turn, traceEvent);
  trace.updatedAt = Date.now();
  return traceEvent;
}

export function completeVoiceTurnTrace(sessionId, details = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, details?.turnId, details);
  appendVoiceTurnTraceEvent(sessionId, {
    turnId: turn.turnId,
    type: "turn.end",
    status: details?.status,
    outcome: details?.outcome,
  });
  if (trace.activeTurnId === turn.turnId) {
    trace.activeTurnId = null;
  }
  return { turnId: turn.turnId, status: turn.status };
}

export function abortVoiceTurnTrace(sessionId, reason = "aborted", details = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, details?.turnId, details);
  appendVoiceTurnTraceEvent(sessionId, {
    turnId: turn.turnId,
    type: "turn.abort",
    reason: String(reason || "aborted"),
    ...sanitizeTraceValue(details),
  });
  return { turnId: turn.turnId, status: turn.status, reason: turn.reason };
}

export function hasVoiceTurnTraceFingerprint(sessionId, turnId, fingerprint) {
  const trace = getVoiceTurnTrace(sessionId);
  const resolvedTurnId = String(turnId || trace?.activeTurnId || "").trim();
  if (!trace || !resolvedTurnId || !fingerprint) return false;
  const turn = trace.turns.find((entry) => entry.turnId === resolvedTurnId);
  if (!turn) return false;
  return Array.isArray(turn.dispatchFingerprints) && turn.dispatchFingerprints.includes(fingerprint);
}

export function rememberVoiceTurnTraceFingerprint(sessionId, turnId, fingerprint) {
  const state = getVisionSessionState(sessionId);
  if (!state) return false;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, turnId);
  if (!fingerprint || turn.dispatchFingerprints.includes(fingerprint)) {
    return false;
  }
  turn.dispatchFingerprints.push(String(fingerprint));
  if (turn.dispatchFingerprints.length > MAX_TURN_FINGERPRINTS) {
    turn.dispatchFingerprints.splice(0, turn.dispatchFingerprints.length - MAX_TURN_FINGERPRINTS);
  }
  trace.updatedAt = Date.now();
  return true;
}

export function getVoiceTurnTrace(sessionId, options = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state?.voiceTurnTrace) {
    return {
      sessionId: getSessionKey(sessionId),
      activeTurnId: null,
      updatedAt: 0,
      turns: [],
    };
  }

  const trace = state.voiceTurnTrace;
  const limit = Math.max(1, Number(options?.limit) || trace.turns.length || 1);
  const requestedTurnId = String(options?.turnId || "").trim();
  const selectedTurns = requestedTurnId
    ? trace.turns.filter((turn) => turn.turnId === requestedTurnId)
    : trace.turns.slice(-limit);
  const turns = selectedTurns.map((turn) => ({
    ...sanitizeTraceValue(turn),
    events: Array.isArray(turn.events) ? turn.events.map((event) => sanitizeTraceValue(event)) : [],
  }));

  return {
    sessionId: getSessionKey(sessionId),
    activeTurnId: trace.activeTurnId,
    updatedAt: trace.updatedAt,
    turns,
  };
}

function describeTurnCategory(category) {
  const normalized = String(category || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "transport") return "transport issue";
  if (normalized === "dispatch-mismatch") return "dispatch mismatch";
  return normalized;
}

function inferTurnCategory(turn = {}) {
  if (turn.category) {
    return turn.category;
  }

  const reason = String(turn.reason || "").trim().toLowerCase();
  if (reason.startsWith("transport") || reason.includes("socket") || reason.includes("connection")) {
    return "transport";
  }
  if (reason === "unknown_action" || reason === "missing_action" || reason.includes("mismatch") || reason.includes("duplicate_dispatch")) {
    return "dispatch-mismatch";
  }

  const events = Array.isArray(turn.events) ? turn.events : [];
  if (events.some((event) => String(event?.type || "").trim().toLowerCase() === "action.mismatch")) {
    return "dispatch-mismatch";
  }
  if (events.some((event) => String(event?.type || "").trim().toLowerCase() === "turn.abort")) {
    return "transport";
  }

  return "";
}

export function formatVoiceTurnTrace(sessionId, options = {}) {
  const trace = getVoiceTurnTrace(sessionId, options);
  if (!trace.turns.length) {
    return `No voice turn trace recorded for ${trace.sessionId || "(unknown session)"}.`;
  }

  const lines = [`Voice turn trace for ${trace.sessionId}`];
  for (const turn of trace.turns) {
    const categoryText = describeTurnCategory(inferTurnCategory(turn));
    const transport = turn.metadata?.transport ? ` transport=${turn.metadata.transport}` : "";
    lines.push(`Turn ${turn.turnId} [${turn.status}]${transport}`);
    if (turn.reason) {
      lines.push(`  reason=${turn.reason}${categoryText ? ` (${categoryText})` : ""}`);
    } else if (categoryText) {
      lines.push(`  category=${categoryText}`);
    }
    if (turn.mismatch?.expected || turn.mismatch?.actual) {
      lines.push(`  mismatch expected=${turn.mismatch?.expected || "(none)"} actual=${turn.mismatch?.actual || "(none)"}`);
    }
    for (const event of turn.events.slice(-12)) {
      const parts = [`  - ${event.type}`];
      if (event.action) parts.push(`action=${event.action}`);
      if (event.toolName) parts.push(`tool=${event.toolName}`);
      if (event.reason) parts.push(`reason=${event.reason}`);
      if (event.expected) parts.push(`expected=${event.expected}`);
      if (event.actual) parts.push(`actual=${event.actual}`);
      lines.push(parts.join(" "));
    }
  }
  return lines.join("\n");
}





export function renderVoiceTurnTrace(sessionId, options = {}) {
  return formatVoiceTurnTrace(sessionId, options);
}
