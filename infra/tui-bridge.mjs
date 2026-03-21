import { getActiveSessions } from "../agent/agent-pool.mjs";
import { loadConfig } from "../config/config.mjs";
import { listAllSessions } from "./session-tracker.mjs";
import { getCompletedSessions } from "./runtime-accumulator.mjs";

export const TUI_EVENT_TYPES = Object.freeze([
  "monitor:stats",
  "sessions:update",
  "session:event",
  "logs:stream",
  "workflow:status",
  "tasks:update",
]);

const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "idle", "archived"]);

const rateLimitEntrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    primary: { type: ["number", "null"] },
    secondary: { type: ["number", "null"] },
    credits: { type: ["number", "null"] },
    unit: { type: ["string", "null"] },
  },
  required: ["primary", "secondary", "credits", "unit"],
};

const sessionSummarySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    taskId: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    type: { type: "string" },
    status: { type: "string" },
    workspaceId: { type: ["string", "null"] },
    workspaceDir: { type: ["string", "null"] },
    branch: { type: ["string", "null"] },
    turnCount: { type: "number" },
    createdAt: { type: ["string", "null"] },
    lastActiveAt: { type: ["string", "null"] },
    idleMs: { type: "number" },
    elapsedMs: { type: "number" },
    recommendation: { type: "string" },
    preview: { type: ["string", "null"] },
    lastMessage: { type: ["string", "null"] },
    insights: { type: ["object", "null"] },
  },
  required: [
    "id",
    "taskId",
    "title",
    "type",
    "status",
    "turnCount",
    "createdAt",
    "lastActiveAt",
    "idleMs",
    "elapsedMs",
    "recommendation",
    "preview",
    "lastMessage",
    "insights",
  ],
};

export const TUI_EVENT_SCHEMAS = Object.freeze({
  "monitor:stats": {
    type: "object",
    additionalProperties: true,
    properties: {
      activeAgents: { type: "number" },
      maxAgents: { type: "number" },
      tokensIn: { type: "number" },
      tokensOut: { type: "number" },
      tokensTotal: { type: "number" },
      throughputTps: { type: "number" },
      uptimeMs: { type: "number" },
      rateLimits: {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: rateLimitEntrySchema,
      },
      ts: { type: "number" },
    },
    required: [
      "activeAgents",
      "maxAgents",
      "tokensIn",
      "tokensOut",
      "tokensTotal",
      "throughputTps",
      "uptimeMs",
      "rateLimits",
      "ts",
    ],
  },
  "sessions:update": {
    type: "array",
    items: sessionSummarySchema,
  },
  "session:event": {
    type: "object",
    additionalProperties: true,
    properties: {
      sessionId: { type: "string" },
      taskId: { type: ["string", "null"] },
      message: { type: "object" },
      session: { type: "object" },
      ts: { type: "number" },
    },
    required: ["sessionId", "taskId", "message", "session", "ts"],
  },
  "logs:stream": {
    type: "object",
    additionalProperties: true,
    properties: {
      logType: { type: "string" },
      source: { type: ["string", "null"] },
      level: { type: "string" },
      message: { type: "string" },
      raw: { type: "string" },
      timestamp: { type: "string" },
      parsed: { type: ["object", "null"] },
      ts: { type: "number" },
    },
    required: ["logType", "source", "level", "message", "raw", "timestamp", "parsed", "ts"],
  },
  "workflow:status": {
    type: "object",
    additionalProperties: true,
    properties: {
      eventType: { type: "string" },
      workflowId: { type: "string" },
      workflowName: { type: ["string", "null"] },
      runId: { type: "string" },
      status: { type: "string" },
      nodeId: { type: ["string", "null"] },
      nodeType: { type: ["string", "null"] },
      nodeLabel: { type: ["string", "null"] },
      error: { type: ["string", "null"] },
      duration: { type: ["number", "null"] },
      outputPreview: { type: ["object", "null"] },
      timestamp: { type: "number" },
    },
    required: ["eventType", "workflowId", "runId", "status", "timestamp"],
  },
  "tasks:update": {
    type: "object",
    additionalProperties: true,
    properties: {
      reason: { type: "string" },
      taskId: { type: ["string", "null"] },
      status: { type: ["string", "null"] },
      parentTaskId: { type: ["string", "null"] },
      task: { type: ["object", "null"] },
      kanbanBackend: { type: ["string", "null"] },
      timestamp: { type: "number" },
    },
    required: ["reason", "taskId", "status", "parentTaskId", "task", "kanbanBackend", "timestamp"],
  },
});

function toNonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function normalizeRateLimitEntry(entry = {}) {
  return {
    primary: entry?.primary == null ? null : toNonNegativeNumber(entry.primary, 0),
    secondary: entry?.secondary == null ? null : toNonNegativeNumber(entry.secondary, 0),
    credits: entry?.credits == null ? null : toNonNegativeNumber(entry.credits, 0),
    unit: entry?.unit == null ? null : String(entry.unit || "") || null,
  };
}

export function normalizeRateLimits(rateLimits = {}) {
  const normalized = {};
  if (!rateLimits || typeof rateLimits !== "object") return normalized;
  for (const [provider, entry] of Object.entries(rateLimits)) {
    const key = String(provider || "").trim();
    if (!key) continue;
    normalized[key] = normalizeRateLimitEntry(entry);
  }
  return normalized;
}

function readMaxAgentsOverride() {
  const envValue = Number(process.env.INTERNAL_EXECUTOR_PARALLEL || "");
  if (Number.isFinite(envValue) && envValue > 0) return Math.trunc(envValue);
  try {
    const config = loadConfig();
    const configured = Number(config?.internalExecutor?.maxParallel || "");
    if (Number.isFinite(configured) && configured > 0) return Math.trunc(configured);
  } catch {
    // best effort
  }
  return null;
}

function extractTokenUsage(entry = {}) {
  const tokenUsage = entry?.insights?.tokenUsage && typeof entry.insights.tokenUsage === "object"
    ? entry.insights.tokenUsage
    : entry?.tokenUsage && typeof entry.tokenUsage === "object"
      ? entry.tokenUsage
      : null;
  const inputTokens = toNonNegativeNumber(
    tokenUsage?.inputTokens ?? entry?.inputTokens ?? entry?.promptTokens ?? entry?.prompt_tokens,
    0,
  );
  const outputTokens = toNonNegativeNumber(
    tokenUsage?.outputTokens ?? entry?.outputTokens ?? entry?.completionTokens ?? entry?.completion_tokens,
    0,
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens: toNonNegativeNumber(
      tokenUsage?.totalTokens ?? entry?.tokenCount ?? entry?.totalTokens ?? entry?.total_tokens,
      inputTokens + outputTokens,
    ),
  };
}

export function buildMonitorStats(options = {}) {
  const activeSessions = Array.isArray(options.activeSessions)
    ? options.activeSessions
    : (typeof options.getActiveSessions === "function" ? options.getActiveSessions() : getActiveSessions());
  const sessions = Array.isArray(options.sessions)
    ? options.sessions
    : (typeof options.listAllSessions === "function" ? options.listAllSessions() : listAllSessions());
  const completedSessions = Array.isArray(options.completedSessions)
    ? options.completedSessions
    : (typeof options.getCompletedSessions === "function"
      ? options.getCompletedSessions()
      : getCompletedSessions(Number.MAX_SAFE_INTEGER));

  let tokensIn = 0;
  let tokensOut = 0;

  for (const session of completedSessions) {
    const usage = extractTokenUsage(session);
    tokensIn += usage.inputTokens;
    tokensOut += usage.outputTokens;
  }

  for (const session of sessions) {
    if (TERMINAL_SESSION_STATUSES.has(String(session?.status || "").trim().toLowerCase())) {
      continue;
    }
    const usage = extractTokenUsage(session);
    tokensIn += usage.inputTokens;
    tokensOut += usage.outputTokens;
  }

  const activeAgents = Array.isArray(activeSessions) ? activeSessions.length : 0;
  const maxAgents = Math.max(activeAgents, options.maxAgents ?? readMaxAgentsOverride() ?? 1);
  const uptimeMs = toNonNegativeNumber(options.uptimeMs, process.uptime() * 1000);
  const tokensTotal = tokensIn + tokensOut;

  return {
    activeAgents,
    maxAgents,
    tokensIn,
    tokensOut,
    tokensTotal,
    throughputTps: uptimeMs > 0 ? Number((tokensTotal / Math.max(uptimeMs / 1000, 1)).toFixed(3)) : 0,
    uptimeMs,
    rateLimits: normalizeRateLimits(options.rateLimits),
    ts: toNonNegativeNumber(options.ts, Date.now()),
  };
}

export function buildSessionsUpdatePayload(sessions = []) {
  return Array.isArray(sessions) ? sessions.map((session) => ({ ...session })) : [];
}

export function buildSessionEventPayload(payload = {}) {
  return {
    sessionId: String(payload?.sessionId || payload?.taskId || "").trim(),
    taskId: String(payload?.taskId || payload?.sessionId || "").trim() || null,
    message: payload?.message && typeof payload.message === "object" ? { ...payload.message } : {},
    session: payload?.session && typeof payload.session === "object" ? { ...payload.session } : {},
    ts: toNonNegativeNumber(payload?.ts, Date.now()),
  };
}

export function buildWorkflowStatusPayload(event = {}) {
  return {
    eventType: String(event?.eventType || "").trim(),
    workflowId: String(event?.workflowId || "").trim(),
    workflowName: event?.workflowName == null ? null : String(event.workflowName || "") || null,
    runId: String(event?.runId || "").trim(),
    status: String(event?.status || "").trim() || "unknown",
    nodeId: event?.nodeId == null ? null : String(event.nodeId || "") || null,
    nodeType: event?.nodeType == null ? null : String(event.nodeType || "") || null,
    nodeLabel: event?.nodeLabel == null ? null : String(event.nodeLabel || "") || null,
    error: event?.error == null ? null : String(event.error || "") || null,
    duration: event?.duration == null ? null : toNonNegativeNumber(event.duration, 0),
    outputPreview: event?.outputPreview && typeof event.outputPreview === "object"
      ? { ...event.outputPreview }
      : null,
    timestamp: toNonNegativeNumber(event?.timestamp, Date.now()),
  };
}

export function buildTaskUpdatePayload(payload = {}) {
  return {
    reason: String(payload?.reason || "updated").trim() || "updated",
    taskId: payload?.taskId == null ? null : String(payload.taskId || "") || null,
    status: payload?.status == null ? null : String(payload.status || "") || null,
    parentTaskId: payload?.parentTaskId == null ? null : String(payload.parentTaskId || "") || null,
    task: payload?.task && typeof payload.task === "object" ? { ...payload.task } : null,
    kanbanBackend: payload?.kanbanBackend == null ? null : String(payload.kanbanBackend || "") || null,
    timestamp: toNonNegativeNumber(payload?.timestamp, Date.now()),
  };
}

export function buildStructuredLogLine(rawLine, options = {}) {
  const raw = String(rawLine || "").replace(/\r$/, "");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const detectedLevel = parsed?.level || parsed?.severity || parsed?.lvl || raw.match(/\b(trace|debug|info|warn|warning|error|fatal)\b/i)?.[1] || "info";
  const detectedTimestamp = parsed?.timestamp || parsed?.time || parsed?.ts || parsed?.date;
  const level = String(detectedLevel || "info").trim().toLowerCase();
  const timestamp = typeof detectedTimestamp === "number"
    ? new Date(detectedTimestamp).toISOString()
    : String(detectedTimestamp || new Date().toISOString());
  const message = String(
    parsed?.message
      ?? parsed?.msg
      ?? parsed?.event
      ?? parsed?.text
      ?? raw,
  ).trim();

  return {
    logType: String(options.logType || "system").trim() || "system",
    source: options.filePath ? String(options.filePath) : null,
    level,
    message,
    raw,
    timestamp,
    parsed: parsed && typeof parsed === "object" ? parsed : null,
    ts: toNonNegativeNumber(options.ts, Date.now()),
  };
}
