import { randomUUID } from "node:crypto";
import { createSessionSnapshotStore } from "./session-snapshot-store.mjs";

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

function nowIso() {
  return new Date().toISOString();
}

function createSnapshotId() {
  return `replay-${randomUUID()}`;
}

function normalizeStatus(value, fallback = "idle") {
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

export function createReplaySnapshot(input = {}) {
  const createdAt = nowIso();
  return {
    snapshotId: toTrimmedString(input.snapshotId || "") || createSnapshotId(),
    sessionId: toTrimmedString(input.sessionId || "") || null,
    runId: toTrimmedString(input.runId || "") || null,
    threadId: toTrimmedString(input.threadId || "") || null,
    parentSessionId: toTrimmedString(input.parentSessionId || "") || null,
    parentThreadId: toTrimmedString(input.parentThreadId || "") || null,
    rootSessionId: toTrimmedString(input.rootSessionId || input.sessionId || "") || null,
    action: toTrimmedString(input.action || "snapshot") || "snapshot",
    eventType: toTrimmedString(input.eventType || "") || null,
    status: normalizeStatus(input.status || "idle"),
    summary: toTrimmedString(input.summary || "") || null,
    createdAt,
    state: cloneValue(input.state || {}),
    result: cloneValue(input.result),
  };
}

function mergeReplaySnapshot(snapshot, patch = {}) {
  const next = {
    ...snapshot,
    ...toPlainObject(patch),
  };
  next.snapshotId = toTrimmedString(next.snapshotId || snapshot.snapshotId);
  next.sessionId = toTrimmedString(next.sessionId || snapshot.sessionId || "") || null;
  next.runId = toTrimmedString(next.runId || snapshot.runId || "") || null;
  next.threadId = toTrimmedString(next.threadId || snapshot.threadId || "") || null;
  next.parentSessionId = toTrimmedString(next.parentSessionId || snapshot.parentSessionId || "") || null;
  next.parentThreadId = toTrimmedString(next.parentThreadId || snapshot.parentThreadId || "") || null;
  next.rootSessionId = toTrimmedString(next.rootSessionId || snapshot.rootSessionId || next.sessionId || "") || null;
  next.action = toTrimmedString(next.action || snapshot.action || "snapshot") || "snapshot";
  next.eventType = toTrimmedString(next.eventType || snapshot.eventType || "") || null;
  next.status = normalizeStatus(next.status || snapshot.status);
  next.summary = toTrimmedString(next.summary || snapshot.summary || "") || null;
  next.state = cloneValue(next.state || snapshot.state || {});
  next.result = cloneValue(next.result ?? snapshot.result);
  next.createdAt = toTrimmedString(next.createdAt || snapshot.createdAt || "") || nowIso();
  return next;
}

export function createSessionReplayStore(options = {}) {
  const events = new Map();
  const snapshotStore = options.snapshotStore || createSessionSnapshotStore({
    maxSnapshotsPerSession: options.maxSnapshotsPerSession,
  });
  const maxSnapshotsPerSession = Number.isFinite(Number(options.maxSnapshotsPerSession))
    ? Math.max(10, Number(options.maxSnapshotsPerSession))
    : 64;
  const maxEventsPerSession = Number.isFinite(Number(options.maxEventsPerSession))
    ? Math.max(25, Number(options.maxEventsPerSession))
    : 256;
  const emitEvent = createEventEmitter([options.onEvent]);

  function getBucket(store, sessionId) {
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) return null;
    if (!store.has(normalizedSessionId)) {
      store.set(normalizedSessionId, []);
    }
    return store.get(normalizedSessionId);
  }

  function captureSnapshot(input = {}) {
    const snapshot = mergeReplaySnapshot(createReplaySnapshot(input), input);
    snapshotStore.capture(snapshot);
    emitEvent({
      type: "replay:snapshot-captured",
      sessionId: snapshot.sessionId,
      snapshotId: snapshot.snapshotId,
      action: snapshot.action,
      status: snapshot.status,
      timestamp: snapshot.createdAt,
    });
    return cloneValue(snapshot);
  }

  function recordEvent(sessionId, event, meta = {}) {
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) {
      throw new Error("Replay event requires a sessionId");
    }
    const bucket = getBucket(events, normalizedSessionId);
    if (bucket.length === 0) {
      const persisted = snapshotStore.readSession(normalizedSessionId);
      for (const entry of Array.isArray(persisted?.events) ? persisted.events : []) {
        bucket.push(cloneValue(entry));
      }
    }
    const entry = {
      eventId: `event-${randomUUID()}`,
      sessionId: normalizedSessionId,
      type: toTrimmedString(event?.type || meta.type || "event") || "event",
      timestamp: toTrimmedString(event?.timestamp || meta.timestamp || "") || nowIso(),
      payload: cloneValue(event || {}),
      meta: cloneValue(meta || {}),
    };
    bucket.push(entry);
    while (bucket.length > maxEventsPerSession) {
      bucket.shift();
    }
    snapshotStore.writeSession(normalizedSessionId, {
      snapshots: snapshotStore.list(normalizedSessionId),
      events: bucket,
    });
    emitEvent({
      type: "replay:event-recorded",
      sessionId: normalizedSessionId,
      eventType: entry.type,
      timestamp: entry.timestamp,
    });
    return cloneValue(entry);
  }

  function listSnapshots(sessionId, options_ = {}) {
    return snapshotStore.list(sessionId, options_);
  }

  function listEvents(sessionId, options_ = {}) {
    const normalizedSessionId = toTrimmedString(sessionId);
    const bucket = normalizedSessionId
      ? (events.get(normalizedSessionId) || snapshotStore.listEvents(normalizedSessionId))
      : [];
    const limit = Number.isFinite(Number(options_.limit)) ? Math.max(1, Number(options_.limit)) : bucket.length;
    return bucket.slice(Math.max(0, bucket.length - limit)).map((entry) => cloneValue(entry));
  }

  function getLatestSnapshot(sessionId) {
    return snapshotStore.getLatest(sessionId);
  }

  function buildResumeState(sessionId, options_ = {}) {
    const latestSnapshot = getLatestSnapshot(sessionId);
    const recentSnapshots = listSnapshots(sessionId, { limit: options_.snapshotLimit || 10 });
    const recentEvents = listEvents(sessionId, { limit: options_.eventLimit || 25 });
    return {
      sessionId: toTrimmedString(sessionId) || null,
      latestSnapshot,
      snapshots: recentSnapshots,
      events: recentEvents,
      resumeFrom: latestSnapshot
        ? {
            snapshotId: latestSnapshot.snapshotId,
            threadId: latestSnapshot.threadId,
            status: latestSnapshot.status,
            action: latestSnapshot.action,
          }
        : null,
    };
  }

  function snapshot() {
    return {
      snapshots: snapshotStore.snapshot(),
      events: Object.fromEntries(
        [...events.entries()].map(([sessionId, entries]) => [sessionId, entries.map((entry) => cloneValue(entry))]),
      ),
    };
  }

  function hydrate(snapshotValue = {}) {
    events.clear();
    snapshotStore.hydrate(snapshotValue?.snapshots || {});
    for (const [sessionId, entries] of Object.entries(snapshotValue?.events || {})) {
      events.set(
        sessionId,
        (Array.isArray(entries) ? entries : []).map((entry) => ({
          eventId: toTrimmedString(entry?.eventId || "") || `event-${randomUUID()}`,
          sessionId: toTrimmedString(entry?.sessionId || sessionId) || sessionId,
          type: toTrimmedString(entry?.type || "event") || "event",
          timestamp: toTrimmedString(entry?.timestamp || "") || nowIso(),
          payload: cloneValue(entry?.payload || {}),
          meta: cloneValue(entry?.meta || {}),
        })),
      );
    }
    return snapshot();
  }

  return {
    captureSnapshot,
    recordEvent,
    listSnapshots,
    listEvents,
    getLatestSnapshot,
    buildResumeState,
    getSnapshotStore() {
      return snapshotStore;
    },
    snapshot,
    hydrate,
  };
}

export default createSessionReplayStore;
