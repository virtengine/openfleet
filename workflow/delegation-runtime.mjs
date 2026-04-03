function ensureWorkflowRuntimeState(ctx) {
  if (!ctx || typeof ctx !== "object") return {};
  if (!ctx.__workflowRuntimeState || typeof ctx.__workflowRuntimeState !== "object") {
    ctx.__workflowRuntimeState = {};
  }
  return ctx.__workflowRuntimeState;
}

function parseDelegationEventTime(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeDelegationEvent(event = {}) {
  return {
    ...event,
    type: String(event?.type || event?.eventType || "").trim() || "unknown",
    eventType: String(event?.eventType || event?.type || "").trim() || "unknown",
    at: Number(event?.at) || Date.now(),
    timestamp: event?.timestamp || new Date().toISOString(),
  };
}

export function normalizeDelegationTrail(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({ ...entry }))
    .sort((left, right) => parseDelegationEventTime(left?.at || left?.timestamp) - parseDelegationEventTime(right?.at || right?.timestamp));
}

export function normalizeDelegationGuardMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key, value]) => String(key || "").trim() && value && typeof value === "object")
      .map(([key, value]) => [String(key).trim(), { ...value }]),
  );
}

export function getDelegationTransitionGuard(ctx, key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return null;
  const guards = normalizeDelegationGuardMap(ctx?.data?._delegationTransitionGuards);
  return guards[normalizedKey] ? { ...guards[normalizedKey] } : null;
}

export function setDelegationTransitionGuard(ctx, key, value = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey || !ctx || typeof ctx !== "object") return null;
  if (!ctx.data || typeof ctx.data !== "object") ctx.data = {};
  const guards = normalizeDelegationGuardMap(ctx.data._delegationTransitionGuards);
  const nextValue = { ...value, transitionKey: value?.transitionKey || normalizedKey };
  guards[normalizedKey] = nextValue;
  ctx.data._delegationTransitionGuards = guards;
  return { ...nextValue };
}

export function extractDelegationGuardMap(detail, run = null) {
  return normalizeDelegationGuardMap(
    detail?.data?._delegationTransitionGuards ??
    run?.detail?.data?._delegationTransitionGuards ??
    run?.delegationTransitionGuards,
  );
}

export function getDelegationAuditTrail(ctx) {
  const runtimeState = ensureWorkflowRuntimeState(ctx);
  if (!Array.isArray(runtimeState.delegationAuditTrail)) {
    runtimeState.delegationAuditTrail = normalizeDelegationTrail(
      ctx?.data?._delegationAuditTrail ??
      ctx?.data?._workflowDelegationTrail ??
      ctx?.data?._delegationTrail,
    );
  }
  if (ctx?.data && !Array.isArray(ctx.data._delegationAuditTrail)) {
    ctx.data._delegationAuditTrail = runtimeState.delegationAuditTrail;
    ctx.data._workflowDelegationTrail = runtimeState.delegationAuditTrail;
    ctx.data._delegationTrail = runtimeState.delegationAuditTrail;
  }
  return runtimeState.delegationAuditTrail;
}

export function appendDelegationAuditEvent(ctx, event = {}) {
  if (!ctx || !event || typeof event !== "object") return [];
  const trail = getDelegationAuditTrail(ctx);
  const normalized = normalizeDelegationEvent(event);
  const transitionKey = String(normalized.transitionKey || normalized.idempotencyKey || "").trim();
  if (transitionKey) {
    const existing = trail.find((entry) => String(entry?.transitionKey || entry?.idempotencyKey || "").trim() === transitionKey);
    if (existing) return trail;
  }
  const ownerMismatchKey = `${normalized.type}:${normalized.taskId || ""}:${normalized.claimToken || ""}:${normalized.instanceId || ""}`;
  if (normalized.type === "owner-mismatch") {
    const exists = trail.some((entry) => `${entry?.type || "unknown"}:${entry?.taskId || ""}:${entry?.claimToken || ""}:${entry?.instanceId || ""}` === ownerMismatchKey);
    if (exists) return trail;
  }
  const nextTrail = normalizeDelegationTrail([...trail, normalized]);
  const runtimeState = ensureWorkflowRuntimeState(ctx);
  runtimeState.delegationAuditTrail = nextTrail;
  if (ctx?.data && typeof ctx.data === "object") {
    ctx.data._delegationAuditTrail = nextTrail;
    ctx.data._workflowDelegationTrail = nextTrail;
    ctx.data._delegationTrail = nextTrail;
  }
  return nextTrail;
}

export function recordDelegationEvent(ctx, event = {}) {
  if (!ctx || typeof ctx !== "object") {
    return {
      ...normalizeDelegationEvent(event),
      recorded: false,
    };
  }
  if (!ctx.data || typeof ctx.data !== "object") ctx.data = {};
  ctx.data._delegationTransitionGuards = normalizeDelegationGuardMap(ctx.data._delegationTransitionGuards);
  const entry = normalizeDelegationEvent(event);
  const key = String(event?.transitionKey || event?.idempotencyKey || "").trim();
  if (key) {
    const existing = getDelegationTransitionGuard(ctx, key);
    if (existing) {
      return {
        ...existing,
        recorded: false,
      };
    }
    entry.transitionKey = entry.transitionKey || key;
    entry.idempotencyKey = entry.idempotencyKey || key;
    setDelegationTransitionGuard(ctx, key, entry);
  }
  appendDelegationAuditEvent(ctx, entry);
  return {
    ...entry,
    recorded: true,
  };
}

export function recordDelegationAuditEvent(ctx, event = {}) {
  if (typeof ctx?.recordDelegationEvent === "function") {
    return ctx.recordDelegationEvent(event);
  }
  const entry = normalizeDelegationEvent({
    ...event,
    transitionKey: event?.transitionKey || event?.idempotencyKey,
    idempotencyKey: event?.idempotencyKey || event?.transitionKey,
  });
  appendDelegationAuditEvent(ctx, entry);
  return {
    ...entry,
    recorded: true,
  };
}

export function getDelegationTransitionStore(ctx) {
  const runtimeState = ensureWorkflowRuntimeState(ctx);
  if (!runtimeState.delegationTransitionResults || typeof runtimeState.delegationTransitionResults !== "object") {
    runtimeState.delegationTransitionResults = {};
  }
  return runtimeState.delegationTransitionResults;
}

const delegationTransitionResultCache = new Map();

export function getExistingDelegationTransition(ctx, transitionKey) {
  const key = String(transitionKey || "").trim();
  if (!key) return null;
  return getDelegationTransitionStore(ctx)[key] || delegationTransitionResultCache.get(key) || null;
}

export function setDelegationTransitionResult(ctx, transitionKey, value) {
  const key = String(transitionKey || "").trim();
  if (!key) return null;
  getDelegationTransitionStore(ctx)[key] = value;
  delegationTransitionResultCache.set(key, value);
  return value;
}

export function extractDelegationTrail(detail, run = null) {
  const candidates = [
    detail?.delegationAuditTrail,
    detail?.delegationTrail,
    detail?.data?._delegationAuditTrail,
    detail?.data?._workflowDelegationTrail,
    detail?.data?._delegationTrail,
    run?.detail?.delegationAuditTrail,
    run?.detail?.delegationTrail,
    run?.detail?.data?._delegationAuditTrail,
    run?.detail?.data?._workflowDelegationTrail,
    run?.detail?.data?._delegationTrail,
    run?.delegationTrail,
    run?.delegationAuditTrail,
  ];
  return normalizeDelegationTrail(candidates.find((value) => Array.isArray(value)) || []);
}

export function hydrateDelegationReadModel(detail, options = {}) {
  if (!detail || typeof detail !== "object") return detail;
  const delegationTrail = normalizeDelegationTrail(options.trail ?? extractDelegationTrail(detail, options.run || null));
  const delegationTransitionGuards = normalizeDelegationGuardMap(
    options.guards ?? extractDelegationGuardMap(detail, options.run || null),
  );
  if (delegationTrail.length === 0 && Object.keys(delegationTransitionGuards).length === 0) {
    return detail;
  }
  if (!detail.data || typeof detail.data !== "object") {
    detail.data = {};
  }
  if (delegationTrail.length > 0) {
    detail.data._delegationAuditTrail = delegationTrail.map((entry) => ({ ...entry }));
    detail.data._workflowDelegationTrail = delegationTrail.map((entry) => ({ ...entry }));
    detail.data._delegationTrail = delegationTrail.map((entry) => ({ ...entry }));
    detail.delegationAuditTrail = delegationTrail.map((entry) => ({ ...entry }));
    detail.delegationTrail = delegationTrail.map((entry) => ({ ...entry }));
  }
  if (Object.keys(delegationTransitionGuards).length > 0) {
    detail.data._delegationTransitionGuards = { ...delegationTransitionGuards };
    detail.delegationTransitionGuards = { ...delegationTransitionGuards };
  }
  return detail;
}

export function persistDelegationTransitionGuard(ctx, transitionKey, value = {}) {
  const key = String(transitionKey || "").trim();
  if (!key || typeof ctx?.setDelegationTransitionGuard !== "function") return null;
  return ctx.setDelegationTransitionGuard(key, {
    ...value,
    transitionKey: value?.transitionKey || key,
    idempotencyKey: value?.idempotencyKey || key,
  });
}

function parseWatchdogTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function buildDelegationWatchdogDecision(detail = {}, options = {}) {
  const watchdog = detail?.data?._delegationWatchdog;
  if (!watchdog || typeof watchdog !== "object") return null;

  const delegationType = String(watchdog.delegationType || "").trim().toLowerCase();
  if (watchdog.taskScoped === true || delegationType === "task") return null;

  const state = String(watchdog.state || "").trim().toLowerCase();
  if (state && state !== "delegated" && state !== "running" && state !== "stalled") {
    return null;
  }

  const startedAt = parseWatchdogTimestamp(watchdog.startedAt)
    ?? parseWatchdogTimestamp(watchdog.updatedAt)
    ?? parseWatchdogTimestamp(detail?.startedAt);
  if (!Number.isFinite(startedAt)) return null;

  const minTimeoutMs = Number.isFinite(Number(options.minTimeoutMs)) ? Number(options.minTimeoutMs) : 1000;
  const maxTimeoutMs = Number.isFinite(Number(options.maxTimeoutMs)) ? Number(options.maxTimeoutMs) : Number.MAX_SAFE_INTEGER;
  const defaultTimeoutMs = Number.isFinite(Number(options.defaultTimeoutMs)) ? Number(options.defaultTimeoutMs) : 300000;
  const defaultMaxRecoveries = Number.isFinite(Number(options.defaultMaxRecoveries)) ? Number(options.defaultMaxRecoveries) : 1;

  const timeoutMs = Math.max(
    minTimeoutMs,
    Math.min(
      maxTimeoutMs,
      Number(watchdog.timeoutMs ?? watchdog.delegationWatchdogTimeoutMs ?? defaultTimeoutMs) || defaultTimeoutMs,
    ),
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < timeoutMs) return null;

  const maxRecoveries = Math.max(
    0,
    Math.trunc((() => {
      const raw = watchdog.maxRecoveries
        ?? watchdog.delegationWatchdogMaxRecoveries
        ?? detail?.data?.delegationWatchdogMaxRecoveries
        ?? defaultMaxRecoveries;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : defaultMaxRecoveries;
    })()),
  );
  const recoveryAttempts = Math.max(
    0,
    Math.trunc((() => {
      const parsed = Number(watchdog.recoveryAttempts);
      if (Number.isFinite(parsed)) return parsed;
      return watchdog.recoveryAttempted === true ? 1 : 0;
    })()),
  );

  const reasonBase = `delegation_watchdog:${watchdog.nodeId || "unknown"}:${elapsedMs}ms>${timeoutMs}ms`;
  if (recoveryAttempts >= maxRecoveries) {
    return {
      type: "exhausted",
      reason: `delegation_watchdog_exhausted:${watchdog.nodeId || "unknown"}:${recoveryAttempts}/${maxRecoveries}`,
      nodeId: watchdog.nodeId || null,
      elapsedMs,
      timeoutMs,
      recoveryAttempts,
      maxRecoveries,
    };
  }

  return {
    type: "retry",
    mode: "from_failed",
    reason: `${reasonBase}:retryable`,
    nodeId: watchdog.nodeId || null,
    elapsedMs,
    timeoutMs,
    recoveryAttempts,
    maxRecoveries,
  };
}
