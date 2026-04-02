function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function toTraceTimestampMicros(value) {
  const ms = Date.parse(String(value || ""));
  if (Number.isFinite(ms)) return ms * 1000;
  return Date.now() * 1000;
}

function buildTraceArgs(event = {}) {
  return {
    source: asText(event.source),
    category: asText(event.category),
    taskId: asText(event.taskId),
    sessionId: asText(event.sessionId),
    threadId: asText(event.threadId),
    runId: asText(event.runId),
    traceId: asText(event.traceId),
    spanId: asText(event.spanId),
    parentSpanId: asText(event.parentSpanId),
    providerId: asText(event.providerId),
    modelId: asText(event.modelId),
    toolId: asText(event.toolId),
    toolName: asText(event.toolName),
    approvalId: asText(event.approvalId),
    status: asText(event.status),
    retryCount: Number(event.retryCount || 0),
    durationMs: Number(event.durationMs || 0),
    latencyMs: Number(event.latencyMs || event.durationMs || 0),
    tokenUsage: event.tokenUsage || null,
    costUsd: Number(event.costUsd || 0),
    summary: asText(event.summary || event.reason || event.message),
  };
}

export function exportHarnessTrace(events = [], options = {}) {
  const processName = asText(options.processName) || "bosun-harness";
  const threadFallback = asText(options.threadName) || "runtime";
  const traceEvents = (Array.isArray(events) ? events : [])
    .filter(Boolean)
    .map((event) => {
      const timestamp = String(event.timestamp || new Date().toISOString());
      const durationMs = Number(event.durationMs || event.latencyMs || 0);
      return {
        name: asText(event.eventType || event.type) || "event",
        cat: asText(event.category || event.source) || "runtime",
        ph: durationMs > 0 ? "X" : "i",
        s: durationMs > 0 ? undefined : "t",
        ts: toTraceTimestampMicros(timestamp),
        dur: durationMs > 0 ? Math.trunc(durationMs * 1000) : undefined,
        pid: processName,
        tid: asText(event.threadId || event.sessionId || event.runId || event.taskId) || threadFallback,
        args: buildTraceArgs(event),
      };
    });
  return {
    schemaVersion: 1,
    format: "chrome-trace",
    displayTimeUnit: "ms",
    traceEvents,
  };
}

