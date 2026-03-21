import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const TUI_EVENT_TYPES = Object.freeze([
  "monitor:stats",
  "sessions:update",
  "session:event",
  "logs:stream",
  "workflow:status",
  "tasks:update",
]);

const RATE_LIMIT_BUCKET_SCHEMA = {
  type: "object",
  required: ["primary", "secondary", "credits", "unit"],
  additionalProperties: false,
  properties: {
    primary: { type: ["number", "null"] },
    secondary: { type: ["number", "null"] },
    credits: { type: ["number", "null"] },
    unit: { type: "string", minLength: 1 },
  },
};

const SESSION_SUMMARY_SCHEMA = {
  type: "object",
  required: [
    "id",
    "taskId",
    "title",
    "type",
    "status",
    "workspaceId",
    "workspaceDir",
    "branch",
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
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    taskId: { type: "string", minLength: 1 },
    title: { type: ["string", "null"] },
    type: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
    workspaceId: { type: ["string", "null"] },
    workspaceDir: { type: ["string", "null"] },
    branch: { type: ["string", "null"] },
    turnCount: { type: "number", minimum: 0 },
    createdAt: { type: "string", minLength: 1 },
    lastActiveAt: { type: "string", minLength: 1 },
    idleMs: { type: "number", minimum: 0 },
    elapsedMs: { type: "number", minimum: 0 },
    recommendation: { type: "string" },
    preview: { type: ["string", "null"] },
    lastMessage: { type: ["string", "null"] },
    insights: {},
  },
};

export const TUI_EVENT_SCHEMAS = Object.freeze({
  "monitor:stats": {
    type: "object",
    required: [
      "activeAgents",
      "maxAgents",
      "tokensIn",
      "tokensOut",
      "tokensTotal",
      "throughputTps",
      "uptimeMs",
      "rateLimits",
    ],
    additionalProperties: false,
    properties: {
      activeAgents: { type: "number", minimum: 0 },
      maxAgents: { type: "number", minimum: 0 },
      tokensIn: { type: "number", minimum: 0 },
      tokensOut: { type: "number", minimum: 0 },
      tokensTotal: { type: "number", minimum: 0 },
      throughputTps: { type: "number", minimum: 0 },
      uptimeMs: { type: "number", minimum: 0 },
      rateLimits: {
        type: "object",
        additionalProperties: RATE_LIMIT_BUCKET_SCHEMA,
      },
    },
  },
  "sessions:update": {
    type: "array",
    items: SESSION_SUMMARY_SCHEMA,
  },
  "session:event": {
    type: "object",
    required: ["sessionId", "taskId", "session", "event"],
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 1 },
      taskId: { type: "string", minLength: 1 },
      session: {
        type: "object",
        required: ["id", "taskId", "type", "status", "lastActiveAt", "turnCount"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          taskId: { type: "string", minLength: 1 },
          type: { type: "string", minLength: 1 },
          status: { type: "string", minLength: 1 },
          lastActiveAt: { type: "string", minLength: 1 },
          turnCount: { type: "number", minimum: 0 },
        },
      },
      event: {
        type: "object",
        required: ["kind"],
        additionalProperties: true,
        properties: {
          kind: { type: "string", enum: ["message", "state"] },
        },
      },
    },
  },
  "logs:stream": {
    type: "object",
    required: ["logType", "raw", "line", "level", "timestamp", "filePath"],
    additionalProperties: false,
    properties: {
      logType: { type: "string", minLength: 1 },
      query: { type: ["string", "null"] },
      filePath: { type: ["string", "null"] },
      line: { type: "string" },
      raw: { type: "string" },
      level: { type: "string", minLength: 1 },
      timestamp: { type: ["string", "null"] },
    },
  },
  "workflow:status": {
    type: "object",
    required: ["runId", "workflowId", "eventType", "status", "timestamp"],
    additionalProperties: false,
    properties: {
      runId: { type: "string", minLength: 1 },
      workflowId: { type: "string", minLength: 1 },
      workflowName: { type: ["string", "null"] },
      eventType: { type: "string", minLength: 1 },
      status: { type: "string", minLength: 1 },
      nodeId: { type: ["string", "null"] },
      nodeType: { type: ["string", "null"] },
      nodeLabel: { type: ["string", "null"] },
      error: { type: ["string", "null"] },
      durationMs: { type: ["number", "null"], minimum: 0 },
      timestamp: { type: "number", minimum: 0 },
      meta: { type: ["object", "null"] },
    },
  },
  "tasks:update": {
    type: "object",
    required: ["reason", "sourceEvent", "patch"],
    additionalProperties: false,
    properties: {
      reason: { type: "string", minLength: 1 },
      sourceEvent: { type: "string", minLength: 1 },
      taskId: { type: ["string", "null"] },
      taskIds: {
        type: ["array", "null"],
        items: { type: "string", minLength: 1 },
      },
      status: { type: ["string", "null"] },
      workspaceId: { type: ["string", "null"] },
      projectId: { type: ["string", "null"] },
      patch: { type: "object", additionalProperties: true },
    },
  },
});

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  return Math.max(0, numberOr(value, fallback));
}

function roundMetric(value, precision = 4) {
  const numeric = nonNegativeNumber(value, 0);
  return Number(numeric.toFixed(precision));
}

function resolveCacheDir({ cacheDir, configDir } = {}) {
  if (cacheDir) return resolve(String(cacheDir));
  return resolve(String(configDir || process.cwd()), ".cache");
}

function normalizeRateLimits(rateLimits = {}) {
  const normalized = {};
  for (const [provider, bucket] of Object.entries(rateLimits || {})) {
    const key = String(provider || "").trim();
    if (!key || !bucket || typeof bucket !== "object") continue;
    normalized[key] = {
      primary: Number.isFinite(Number(bucket.primary)) ? Number(bucket.primary) : null,
      secondary: Number.isFinite(Number(bucket.secondary)) ? Number(bucket.secondary) : null,
      credits: bucket.credits == null ? null : (Number.isFinite(Number(bucket.credits)) ? Number(bucket.credits) : null),
      unit: String(bucket.unit || "count").trim() || "count",
    };
  }
  return normalized;
}

function sumRuntimeTokens(runtimeStats = {}) {
  const sessions = Array.isArray(runtimeStats?.sessions) ? runtimeStats.sessions : [];
  return sessions.reduce((acc, session) => {
    acc.tokensIn += nonNegativeNumber(session?.inputTokens, 0);
    acc.tokensOut += nonNegativeNumber(session?.outputTokens, 0);
    return acc;
  }, { tokensIn: 0, tokensOut: 0 });
}

export function buildMonitorStatsPayload({ agentPool, runtimeStats = {}, uptimeMs = 0 } = {}) {
  const agentPoolStats = typeof agentPool?.getTuiStats === "function"
    ? (agentPool.getTuiStats() || {})
    : (agentPool && typeof agentPool === "object" ? agentPool : {});

  const runtimeTokenTotals = sumRuntimeTokens(runtimeStats);
  const tokensIn = nonNegativeNumber(
    agentPoolStats.tokensIn,
    runtimeStats.totalInputTokens ?? runtimeTokenTotals.tokensIn,
  );
  const tokensOut = nonNegativeNumber(
    agentPoolStats.tokensOut,
    runtimeStats.totalOutputTokens ?? runtimeTokenTotals.tokensOut,
  );
  const tokensTotal = nonNegativeNumber(agentPoolStats.tokensTotal, tokensIn + tokensOut);
  const resolvedUptimeMs = nonNegativeNumber(
    uptimeMs,
    runtimeStats.startedAt ? Date.now() - Number(runtimeStats.startedAt) : 0,
  );
  const throughputTps = Number.isFinite(Number(agentPoolStats.throughputTps))
    ? roundMetric(agentPoolStats.throughputTps)
    : (resolvedUptimeMs > 0 ? roundMetric(tokensTotal / (resolvedUptimeMs / 1000)) : 0);

  return {
    activeAgents: nonNegativeNumber(agentPoolStats.activeAgents, 0),
    maxAgents: nonNegativeNumber(agentPoolStats.maxAgents, 0),
    tokensIn,
    tokensOut,
    tokensTotal,
    throughputTps,
    uptimeMs: resolvedUptimeMs,
    rateLimits: normalizeRateLimits(agentPoolStats.rateLimits),
  };
}

export function buildSessionsUpdatePayload(sessions = []) {
  return Array.isArray(sessions) ? sessions.map((session) => ({ ...session })) : [];
}

export function buildSessionEventPayload(payload = {}) {
  const event = payload?.event && typeof payload.event === "object"
    ? { ...payload.event }
    : { kind: "message", ...(payload?.message ? { message: payload.message } : {}) };
  return {
    sessionId: String(payload?.sessionId || payload?.session?.id || "").trim(),
    taskId: String(payload?.taskId || payload?.session?.taskId || "").trim(),
    session: payload?.session && typeof payload.session === "object" ? { ...payload.session } : {},
    event,
  };
}

export function buildWorkflowStatusPayload(payload = {}) {
  return {
    runId: String(payload?.runId || "").trim(),
    workflowId: String(payload?.workflowId || "").trim(),
    workflowName: String(payload?.workflowName || payload?.name || "").trim() || null,
    eventType: String(payload?.eventType || payload?.event || "").trim(),
    status: String(payload?.status || "unknown").trim() || "unknown",
    nodeId: String(payload?.nodeId || "").trim() || null,
    nodeType: String(payload?.nodeType || "").trim() || null,
    nodeLabel: String(payload?.nodeLabel || "").trim() || null,
    error: String(payload?.error || "").trim() || null,
    durationMs: Number.isFinite(Number(payload?.durationMs)) ? Number(payload.durationMs) : null,
    timestamp: nonNegativeNumber(payload?.timestamp, Date.now()),
    meta: payload?.meta && typeof payload.meta === "object" ? { ...payload.meta } : null,
  };
}

export function buildLogStreamPayload({ logType, query = null, filePath = null, line = "" } = {}) {
  const raw = String(line || "");
  const levelMatch = raw.match(/\b(trace|debug|info|warn|warning|error|fatal)\b/i);
  const timestampMatch = raw.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/);
  return {
    logType: String(logType || "system").trim() || "system",
    query: query == null ? null : String(query),
    filePath: filePath == null ? null : String(filePath),
    line: raw,
    raw,
    level: levelMatch ? levelMatch[1].toLowerCase().replace("warning", "warn") : "info",
    timestamp: timestampMatch ? timestampMatch[0] : null,
  };
}

export function buildTasksUpdatePayload(payload = {}, { sourceEvent = "invalidate" } = {}) {
  const normalized = payload && typeof payload === "object" ? payload : {};
  const patch = normalized.patch && typeof normalized.patch === "object"
    ? { ...normalized.patch }
    : { ...normalized };
  const reason = String(normalized.reason || sourceEvent || "tasks-changed").trim() || "tasks-changed";
  const taskIds = Array.isArray(normalized.taskIds)
    ? normalized.taskIds.map((taskId) => String(taskId || "").trim()).filter(Boolean)
    : null;
  return {
    reason,
    sourceEvent: String(sourceEvent || "invalidate").trim() || "invalidate",
    taskId: String(normalized.taskId || normalized.id || "").trim() || null,
    taskIds: taskIds && taskIds.length ? taskIds : null,
    status: String(normalized.status || "").trim() || null,
    workspaceId: String(normalized.workspaceId || "").trim() || null,
    projectId: String(normalized.projectId || "").trim() || null,
    patch,
  };
}

export function resolveTuiAuthToken({ env = process.env, cacheDir, configDir = process.cwd() } = {}) {
  const envCandidates = [
    env?.BOSUN_TUI_AUTH_TOKEN,
    env?.BOSUN_TUI_WS_TOKEN,
    env?.BOSUN_UI_TOKEN,
    env?.BOSUN_WS_TOKEN,
  ];
  for (const candidate of envCandidates) {
    const token = String(candidate || "").trim();
    if (token) return token;
  }

  const resolvedCacheDir = resolveCacheDir({ cacheDir, configDir });
  const candidateFiles = [
    resolve(resolvedCacheDir, "ui-token"),
    resolve(resolvedCacheDir, "ui-session-token.json"),
  ];
  for (const filePath of candidateFiles) {
    try {
      if (!existsSync(filePath)) continue;
      const raw = readFileSync(filePath, "utf8").trim();
      if (!raw) continue;
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw);
        const token = String(parsed?.token || "").trim();
        if (token) return token;
        continue;
      }
      return raw;
    } catch {
      // ignore invalid cache files
    }
  }
  return "";
}

export function persistCompatibleTuiAuthToken(token, { cacheDir, configDir = process.cwd() } = {}) {
  const normalized = String(token || "").trim();
  if (!normalized) return "";
  const resolvedCacheDir = resolveCacheDir({ cacheDir, configDir });
  mkdirSync(resolvedCacheDir, { recursive: true });
  writeFileSync(resolve(resolvedCacheDir, "ui-token"), `${normalized}\n`, "utf8");
  return normalized;
}

export function createTuiStatsEmitter({ intervalMs = 2000, getPayload, emit } = {}) {
  let timer = null;
  let inFlight = null;

  const tick = async () => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => (typeof getPayload === "function" ? getPayload() : null))
      .then(async (payload) => {
        if (payload && typeof emit === "function") {
          await emit(payload);
        }
        return payload;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    async tick() {
      return tick();
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, Math.max(250, Number(intervalMs) || 2000));
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    get isRunning() {
      return Boolean(timer);
    },
  };
}

