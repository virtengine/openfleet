function toTrimmedString(value) {
  return String(value ?? "").trim();
}

export function normalizeHarnessEvent(event = {}, defaults = {}) {
  return {
    type: toTrimmedString(event.type || defaults.type || "harness:event") || "harness:event",
    timestamp: toTrimmedString(event.timestamp || defaults.timestamp || new Date().toISOString()) || new Date().toISOString(),
    runId: toTrimmedString(event.runId || defaults.runId || "") || null,
    sessionId: toTrimmedString(event.sessionId || defaults.sessionId || "") || null,
    taskKey: toTrimmedString(event.taskKey || defaults.taskKey || "") || null,
    stageId: toTrimmedString(event.stageId || defaults.stageId || "") || null,
    payload: event.payload && typeof event.payload === "object" ? { ...event.payload } : {},
  };
}

export function normalizeHarnessMessage(input, defaults = {}) {
  if (input && typeof input === "object") {
    return {
      role: toTrimmedString(input.role || defaults.role || "assistant") || "assistant",
      content: toTrimmedString(input.content || input.text || defaults.content || ""),
      timestamp: toTrimmedString(input.timestamp || defaults.timestamp || new Date().toISOString()) || new Date().toISOString(),
      meta: input.meta && typeof input.meta === "object" ? { ...input.meta } : {},
    };
  }
  return {
    role: toTrimmedString(defaults.role || "assistant") || "assistant",
    content: toTrimmedString(input || defaults.content || ""),
    timestamp: toTrimmedString(defaults.timestamp || new Date().toISOString()) || new Date().toISOString(),
    meta: {},
  };
}

export function normalizeTurnResult(result = {}, defaults = {}) {
  return {
    success: result?.success !== false,
    output: toTrimmedString(result?.output || result?.finalResponse || defaults.output || ""),
    status: toTrimmedString(result?.status || defaults.status || (result?.success === false ? "failed" : "completed")) || "completed",
    outcome: toTrimmedString(result?.outcome || defaults.outcome || (result?.success === false ? "failure" : "success")) || "success",
    sessionId: toTrimmedString(result?.sessionId || defaults.sessionId || "") || null,
    threadId: toTrimmedString(result?.threadId || defaults.threadId || "") || null,
    items: Array.isArray(result?.items) ? result.items : [],
    usage: result?.usage && typeof result.usage === "object" ? { ...result.usage } : null,
    raw: result,
  };
}

export default normalizeHarnessEvent;
