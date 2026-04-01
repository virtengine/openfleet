function toTrimmedString(value) {
  return String(value ?? "").trim();
}

export function createHarnessSessionState(metadata = {}) {
  return {
    sessionId: toTrimmedString(metadata.sessionId || metadata.runId || metadata.taskKey || ""),
    runId: toTrimmedString(metadata.runId || ""),
    taskKey: toTrimmedString(metadata.taskKey || ""),
    status: toTrimmedString(metadata.status || "idle") || "idle",
    createdAt: toTrimmedString(metadata.createdAt || new Date().toISOString()) || new Date().toISOString(),
    updatedAt: toTrimmedString(metadata.updatedAt || metadata.createdAt || new Date().toISOString()) || new Date().toISOString(),
    activeTurn: null,
    history: [],
    events: [],
    followups: [],
    steering: [],
    provider: metadata.provider || null,
  };
}

export function updateHarnessSessionState(state, patch = {}) {
  return {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function appendHarnessSessionEvent(state, event) {
  return updateHarnessSessionState(state, {
    events: [...(Array.isArray(state?.events) ? state.events : []), event],
  });
}

export function setHarnessActiveTurn(state, activeTurn) {
  return updateHarnessSessionState(state, {
    activeTurn,
    status: activeTurn ? "running" : state?.status || "idle",
  });
}

export function appendHarnessHistory(state, entry) {
  return updateHarnessSessionState(state, {
    history: [...(Array.isArray(state?.history) ? state.history : []), entry],
  });
}

export default createHarnessSessionState;
