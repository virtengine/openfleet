import { getBosunSessionManager } from "../agent/session-manager.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function normalizeScope(adapterName, explicitScope = "") {
  const scope = toTrimmedString(explicitScope);
  if (scope) return scope;
  return `shell:${toTrimmedString(adapterName) || "adapter"}`;
}

function buildMetadata(adapterName, input = {}) {
  return {
    shellCompat: true,
    adapterName: toTrimmedString(adapterName) || null,
    ...toPlainObject(input.metadata),
  };
}

function buildCommonInput(adapterName, scope, providerSelection, sessionType, input = {}) {
  const sessionId = toTrimmedString(input.sessionId || input.id || "");
  if (!sessionId) return null;
  return {
    sessionId,
    scope,
    sessionType: toTrimmedString(input.sessionType || sessionType) || sessionType,
    taskKey: toTrimmedString(input.taskKey || sessionId) || sessionId,
    threadId: toTrimmedString(input.threadId || "") || null,
    cwd: toTrimmedString(input.cwd || ""),
    providerSelection: toTrimmedString(input.providerSelection || providerSelection) || providerSelection,
    adapterName: toTrimmedString(input.adapterName || adapterName) || adapterName,
    status: toTrimmedString(input.status || "idle") || "idle",
    metadata: buildMetadata(adapterName, input),
  };
}

function mergeRecords(primary = {}, fallback = {}) {
  const primaryRecord = toPlainObject(primary);
  const fallbackRecord = toPlainObject(fallback);
  return {
    ...fallbackRecord,
    ...primaryRecord,
    metadata: {
      ...toPlainObject(fallbackRecord.metadata),
      ...toPlainObject(primaryRecord.metadata),
    },
  };
}

function matchesAdapter(record, adapterName) {
  const normalizedAdapter = toTrimmedString(adapterName);
  if (!normalizedAdapter) return true;
  const metadataAdapter = toTrimmedString(record?.metadata?.adapterName || "");
  return !metadataAdapter || metadataAdapter === normalizedAdapter;
}

function formatSessionRecord(record, adapterName, activeSessionId = "") {
  if (!record) return null;
  const sessionId = toTrimmedString(record.sessionId || record.id || "");
  if (!sessionId) return null;
  const metadata = toPlainObject(record.metadata);
  const isActive = toTrimmedString(activeSessionId) === sessionId;
  return {
    id: sessionId,
    sessionId,
    adapter: adapterName,
    status: toTrimmedString(record.status || "idle") || "idle",
    threadId: toTrimmedString(record.activeThreadId || record.threadId || metadata.providerThreadId || "") || null,
    cwd: toTrimmedString(metadata.cwd || metadata.workingDirectory || "") || null,
    active: isActive,
    isActive,
    turnCount: Number(metadata.turnCount || 0),
    createdAt: record.createdAt || null,
    lastActiveAt: record.lastActiveAt || null,
    metadata,
  };
}

export function createShellSessionCompat(options = {}) {
  const adapterName = toTrimmedString(options.adapterName || options.name || "adapter") || "adapter";
  const providerSelection = toTrimmedString(options.providerSelection || adapterName) || adapterName;
  const sessionType = toTrimmedString(options.sessionType || "primary") || "primary";
  const scope = normalizeScope(adapterName, options.scope);
  const sessionManager = options.sessionManager || getBosunSessionManager();

  function ensureSession(input = {}) {
    const common = buildCommonInput(adapterName, scope, providerSelection, sessionType, input);
    if (!common) return null;
    const record = sessionManager.ensureSession(common);
    if (input.activate === true) {
      sessionManager.switchSession(common.sessionId, common);
      return sessionManager.getSession(common.sessionId) || record;
    }
    return record;
  }

  function activateSession(sessionId, input = {}) {
    const common = buildCommonInput(adapterName, scope, providerSelection, sessionType, {
      ...input,
      sessionId,
    });
    if (!common) return null;
    sessionManager.ensureSession(common);
    return sessionManager.switchSession(common.sessionId, common);
  }

  function registerExecution(sessionId, input = {}) {
    const common = buildCommonInput(adapterName, scope, providerSelection, sessionType, {
      ...input,
      sessionId,
    });
    if (!common) return null;
    if (input.activate === true) {
      sessionManager.switchSession(common.sessionId, common);
    } else {
      sessionManager.ensureSession(common);
    }
    return sessionManager.registerExecution(common.sessionId, common);
  }

  function hydrate(input = {}) {
    const sessionId = toTrimmedString(input.sessionId || input.id || "");
    if (!sessionId) return null;
    return ensureSession({
      ...input,
      sessionId,
      activate: input.activate !== false,
    });
  }

  function getActiveSession() {
    const active = sessionManager.getActiveSession(scope);
    return matchesAdapter(active, adapterName) ? active : null;
  }

  function getActiveSessionId() {
    return getActiveSession()?.sessionId || null;
  }

  function clearActiveSession() {
    if (typeof sessionManager.clearActiveSession === "function") {
      sessionManager.clearActiveSession(scope);
    }
  }

  function getSessionRecord(sessionId) {
    const record = sessionManager.getSession(toTrimmedString(sessionId));
    return matchesAdapter(record, adapterName)
      ? formatSessionRecord(record, adapterName, getActiveSessionId())
      : null;
  }

  function getSessionInfo(fallback = {}) {
    const localSessionId = toTrimmedString(
      fallback.sessionId || fallback.namedSessionId || fallback.id || "",
    );
    const activeSessionId = getActiveSessionId();
    const active = sessionManager.getSession(localSessionId || activeSessionId || "");
    return mergeRecords(
      fallback,
      formatSessionRecord(active, adapterName, activeSessionId) || {},
    );
  }

  function listSessions(options = {}) {
    const activeSessionId = getActiveSessionId();
    const compatSessions = sessionManager
      .listSessions({ scope })
      .filter((record) => matchesAdapter(record, adapterName));
    const merged = new Map();
    for (const record of compatSessions) {
      const formatted = formatSessionRecord(record, adapterName, activeSessionId);
      const key = toTrimmedString(formatted?.sessionId || "");
      if (key) merged.set(key, formatted);
    }
    for (const record of Array.isArray(options.extraSessions) ? options.extraSessions : []) {
      const key = toTrimmedString(record?.sessionId || record?.id || "");
      if (!key) continue;
      merged.set(key, mergeRecords(merged.get(key), record));
    }
    return [...merged.values()];
  }

  function reset(options = {}) {
    const sessionId = toTrimmedString(
      options.sessionId || getActiveSessionId() || options.id || "",
    );
    clearActiveSession();
    if (options.keepManagedRecord === false || !sessionId) {
      return null;
    }
    return sessionManager.ensureSession({
      ...(buildCommonInput(adapterName, scope, providerSelection, sessionType, {
        ...options,
        sessionId,
        status: options.status || "idle",
      }) || {}),
    });
  }

  return {
    adapterName,
    scope,
    sessionType,
    providerSelection,
    sessionManager,
    ensureSession,
    ensureManagedSession(sessionId, input = {}) {
      return ensureSession({
        ...input,
        sessionId,
      });
    },
    activateSession,
    switchSession(sessionId, input = {}) {
      return activateSession(sessionId, input);
    },
    createSession(sessionId, input = {}) {
      return ensureSession({
        ...input,
        sessionId,
        activate: false,
      });
    },
    registerExecution,
    hydrate,
    getActiveSession,
    getActiveSessionId,
    clearActiveSession,
    getSessionRecord,
    getSessionInfo,
    listSessions,
    reset,
  };
}

export default createShellSessionCompat;
