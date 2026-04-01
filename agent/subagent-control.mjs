import { randomUUID } from "node:crypto";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((entry) => toTrimmedString(entry))
      .filter(Boolean),
  )];
}

function nowIso() {
  return new Date().toISOString();
}

function createSpawnId() {
  return `spawn-${randomUUID()}`;
}

function normalizeStatus(value, fallback = "pending") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  return normalized.replace(/[^a-z0-9_-]+/g, "_");
}

function createEventEmitter(hooks = []) {
  const listeners = [...new Set(hooks.filter((hook) => typeof hook === "function"))];
  return (payload) => {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
      }
    }
  };
}

function buildSubagentRecord(input = {}) {
  const createdAt = nowIso();
  return {
    spawnId: toTrimmedString(input.spawnId || "") || createSpawnId(),
    parentSessionId: toTrimmedString(input.parentSessionId || "") || null,
    parentThreadId: toTrimmedString(input.parentThreadId || "") || null,
    childSessionId: toTrimmedString(input.childSessionId || "") || null,
    childThreadId: toTrimmedString(input.childThreadId || "") || null,
    taskKey: toTrimmedString(input.taskKey || "") || null,
    role: toTrimmedString(input.role || "subagent") || "subagent",
    status: normalizeStatus(input.status || "pending"),
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    lastError: toTrimmedString(input.lastError || "") || null,
    metadata: toPlainObject(input.metadata),
    lastEventType: toTrimmedString(input.lastEventType || "") || null,
  };
}

function mergeSubagentRecord(record, patch = {}) {
  const next = {
    ...record,
    ...toPlainObject(patch),
    updatedAt: nowIso(),
  };
  next.spawnId = toTrimmedString(next.spawnId || record.spawnId);
  next.parentSessionId = toTrimmedString(next.parentSessionId || record.parentSessionId || "") || null;
  next.parentThreadId = toTrimmedString(next.parentThreadId || record.parentThreadId || "") || null;
  next.childSessionId = toTrimmedString(next.childSessionId || record.childSessionId || "") || null;
  next.childThreadId = toTrimmedString(next.childThreadId || record.childThreadId || "") || null;
  next.taskKey = toTrimmedString(next.taskKey || record.taskKey || "") || null;
  next.role = toTrimmedString(next.role || record.role || "subagent") || "subagent";
  next.status = normalizeStatus(next.status || record.status);
  next.lastError = toTrimmedString(next.lastError || record.lastError || "") || null;
  next.lastEventType = toTrimmedString(next.lastEventType || record.lastEventType || "") || null;
  next.metadata = {
    ...(toPlainObject(record.metadata)),
    ...(toPlainObject(next.metadata)),
  };
  if (["completed", "failed", "aborted"].includes(next.status)) {
    next.completedAt = toTrimmedString(next.completedAt || record.completedAt || "") || next.updatedAt;
  } else {
    next.completedAt = toTrimmedString(next.completedAt || record.completedAt || "") || null;
  }
  return next;
}

function matchesFilters(record, filters = {}) {
  const parentSessionId = toTrimmedString(filters.parentSessionId);
  if (parentSessionId && toTrimmedString(record.parentSessionId) !== parentSessionId) return false;
  const parentThreadId = toTrimmedString(filters.parentThreadId);
  if (parentThreadId && toTrimmedString(record.parentThreadId) !== parentThreadId) return false;
  const childSessionId = toTrimmedString(filters.childSessionId);
  if (childSessionId && toTrimmedString(record.childSessionId) !== childSessionId) return false;
  const status = toTrimmedString(filters.status);
  if (status && normalizeStatus(record.status) !== normalizeStatus(status)) return false;
  return true;
}

const activeSessions = new Map();
const ACTIVE_SESSION_LISTENERS = new Set();

function notifyActiveSessionListeners(event, taskKey) {
  const payload = {
    event,
    taskKey,
    timestamp: nowIso(),
  };
  for (const listener of ACTIVE_SESSION_LISTENERS) {
    try {
      listener(payload);
    } catch {
    }
  }
}

export function createSubagentControl(options = {}) {
  const records = new Map();
  const emitEvent = createEventEmitter([options.onEvent]);

  function persist(record, eventType) {
    records.set(record.spawnId, record);
    emitEvent({
      type: eventType,
      spawnId: record.spawnId,
      parentSessionId: record.parentSessionId,
      childSessionId: record.childSessionId,
      childThreadId: record.childThreadId,
      status: record.status,
      timestamp: record.updatedAt,
    });
    return cloneValue(record);
  }

  function registerSubagent(input = {}) {
    const normalizedChildSessionId = toTrimmedString(input.childSessionId || "");
    const existing = normalizedChildSessionId
      ? [...records.values()].find((record) => record.childSessionId === normalizedChildSessionId) || null
      : null;
    const record = existing
      ? mergeSubagentRecord(existing, input)
      : buildSubagentRecord(input);
    if (record.parentThreadId && record.childThreadId && options.threadRegistry?.registerChildThread) {
      try {
        options.threadRegistry.registerChildThread(record.parentThreadId, {
          threadId: record.childThreadId,
          sessionId: record.childSessionId || undefined,
          parentSessionId: record.parentSessionId || undefined,
          role: record.role,
          kind: "subagent",
          status: record.status,
          taskKey: record.taskKey || undefined,
          metadata: record.metadata,
        });
      } catch {
        if (options.threadRegistry?.registerThread) {
          options.threadRegistry.registerThread({
            threadId: record.childThreadId,
            sessionId: record.childSessionId || undefined,
            parentThreadId: record.parentThreadId,
            parentSessionId: record.parentSessionId || undefined,
            role: record.role,
            kind: "subagent",
            status: record.status,
            taskKey: record.taskKey || undefined,
            metadata: record.metadata,
          });
        }
      }
    } else if (record.childThreadId && options.threadRegistry?.registerThread) {
      options.threadRegistry.registerThread({
        threadId: record.childThreadId,
        sessionId: record.childSessionId || undefined,
        parentThreadId: record.parentThreadId || undefined,
        parentSessionId: record.parentSessionId || undefined,
        role: record.role,
        kind: "subagent",
        status: record.status,
        taskKey: record.taskKey || undefined,
        metadata: record.metadata,
      });
    }
    return persist(record, existing ? "subagent:updated" : "subagent:registered");
  }

  function updateSubagent(childSessionIdOrSpawnId, patch = {}) {
    const normalized = toTrimmedString(childSessionIdOrSpawnId);
    const existing = [...records.values()].find((record) => {
      return record.spawnId === normalized || record.childSessionId === normalized;
    }) || null;
    if (!existing) return null;
    const record = mergeSubagentRecord(existing, patch);
    return persist(record, "subagent:updated");
  }

  function getSubagent(childSessionIdOrSpawnId) {
    const normalized = toTrimmedString(childSessionIdOrSpawnId);
    if (!normalized) return null;
    const record = [...records.values()].find((entry) => {
      return entry.spawnId === normalized || entry.childSessionId === normalized;
    }) || null;
    return record ? cloneValue(record) : null;
  }

  function listChildren(filters = {}) {
    return [...records.values()]
      .filter((record) => matchesFilters(record, filters))
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
      .map((record) => cloneValue(record));
  }

  function getParent(childSessionIdOrSpawnId) {
    const record = getSubagent(childSessionIdOrSpawnId);
    if (!record) return null;
    return {
      parentSessionId: record.parentSessionId,
      parentThreadId: record.parentThreadId,
      role: record.role,
    };
  }

  function planSubagentSpawn(input = {}) {
    const spawn = buildSubagentRecord({
      ...input,
      status: input.status || "pending",
      childSessionId: input.childSessionId || null,
      childThreadId: input.childThreadId || null,
    });
    records.set(spawn.spawnId, spawn);
    emitEvent({
      type: "subagent:planned",
      spawnId: spawn.spawnId,
      parentSessionId: spawn.parentSessionId,
      parentThreadId: spawn.parentThreadId,
      status: spawn.status,
      timestamp: spawn.updatedAt,
    });
    return cloneValue(spawn);
  }

  function snapshot() {
    return {
      records: listChildren(),
      parentSessionIds: uniqueStrings(listChildren().map((record) => record.parentSessionId)),
    };
  }

  function hydrate(snapshot = {}) {
    records.clear();
    for (const entry of Array.isArray(snapshot?.records) ? snapshot.records : []) {
      const record = mergeSubagentRecord(buildSubagentRecord(entry), entry);
      records.set(record.spawnId, record);
    }
    return snapshot();
  }

  return {
    planSubagentSpawn,
    registerSubagent,
    updateSubagent,
    getSubagent,
    getParent,
    listChildren,
    snapshot,
    hydrate,
  };
}

export function registerActiveSession(taskKey, sdk, threadId, sendFn, metadata = {}) {
  const normalizedTaskKey = toTrimmedString(taskKey);
  if (!normalizedTaskKey || typeof sendFn !== "function") return false;
  activeSessions.set(normalizedTaskKey, {
    sdk: toTrimmedString(sdk || "") || "unknown",
    threadId: toTrimmedString(threadId || "") || null,
    send: sendFn,
    metadata: toPlainObject(metadata),
    registeredAt: Date.now(),
  });
  notifyActiveSessionListeners("start", normalizedTaskKey);
  return true;
}

export function unregisterActiveSession(taskKey) {
  const normalizedTaskKey = toTrimmedString(taskKey);
  if (!normalizedTaskKey) return false;
  const existed = activeSessions.delete(normalizedTaskKey);
  if (existed) notifyActiveSessionListeners("end", normalizedTaskKey);
  return existed;
}

export function steerActiveThread(taskKey, prompt) {
  const normalizedTaskKey = toTrimmedString(taskKey);
  const session = normalizedTaskKey ? activeSessions.get(normalizedTaskKey) : null;
  if (!session || typeof session.send !== "function") return false;
  try {
    session.send(prompt);
    return true;
  } catch {
    return false;
  }
}

export function hasActiveSession(taskKey) {
  return activeSessions.has(toTrimmedString(taskKey));
}

export function addActiveSessionListener(listener) {
  if (typeof listener !== "function") return () => {};
  ACTIVE_SESSION_LISTENERS.add(listener);
  return () => ACTIVE_SESSION_LISTENERS.delete(listener);
}

export function getActiveSessions() {
  const now = Date.now();
  return [...activeSessions.entries()].map(([taskKey, session]) => ({
    id: taskKey,
    taskId: taskKey,
    taskKey,
    sdk: session.sdk,
    threadId: session.threadId,
    age: Math.max(0, now - Number(session.registeredAt || now)),
    metadata: cloneValue(session.metadata || {}),
  }));
}

export default createSubagentControl;
