import { randomUUID } from "node:crypto";

import { compileInternalHarnessProfile } from "./internal-harness-profile.mjs";
import { createInternalHarnessSession as createHarnessRuntimeSession } from "./internal-harness-runtime.mjs";
import { getSessionTracker } from "../infra/session-tracker.mjs";
import { createSessionReplayStore } from "./session-replay.mjs";
import { createSubagentControl } from "./subagent-control.mjs";
import { createThreadId, createThreadRegistry } from "./thread-registry.mjs";

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

function normalizeStatus(value, fallback = "idle") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  return normalized.replace(/[^a-z0-9_-]+/g, "_");
}

function createSessionId(prefix = "session") {
  const normalized = toTrimmedString(prefix).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "session";
  return `${normalized}-${randomUUID()}`;
}

function formatHarnessValidationError(validationReport = {}) {
  const errors = Array.isArray(validationReport?.errors) ? validationReport.errors : [];
  if (errors.length === 0) return "Harness validation failed";
  return errors
    .map((issue) => String(issue?.message || issue?.code || "Harness validation failed").trim())
    .filter(Boolean)
    .join("; ");
}

function resolveTurnExecutor(options = {}) {
  if (typeof options.executeTurn === "function") return options.executeTurn;
  if (typeof options.turnExecutor === "function") return options.turnExecutor;
  if (typeof options.buildTurnExecutor === "function") return options.buildTurnExecutor(options);
  return async () => {
    throw new Error("Harness runtime requires an executeTurn function when dryRun is false");
  };
}

function compileProfileSource(profileSource, options = {}) {
  if (typeof options.compileHarnessSource === "function") {
    return options.compileHarnessSource(profileSource, options);
  }
  return compileInternalHarnessProfile(profileSource, options.compileOptions || options);
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

function buildSessionRecord(compiledProfile, options = {}, parentRecord = null) {
  const createdAt = nowIso();
  const sessionId = toTrimmedString(options.sessionId || options.id || options.logicalSessionId || "")
    || createSessionId(compiledProfile?.name || compiledProfile?.agentId || "harness");
  const threadId = toTrimmedString(options.threadId || "") || createThreadId(parentRecord ? "subthread" : "thread");
  const rootSessionId = parentRecord?.rootSessionId || parentRecord?.sessionId || sessionId;
  return {
    sessionId,
    runId: toTrimmedString(options.runId || sessionId) || sessionId,
    taskKey: toTrimmedString(options.taskKey || compiledProfile?.taskKey || compiledProfile?.agentId || sessionId),
    taskId: toTrimmedString(options.taskId || compiledProfile?.taskId || ""),
    taskTitle: toTrimmedString(options.taskTitle || compiledProfile?.taskTitle || compiledProfile?.name || ""),
    sessionType: toTrimmedString(options.sessionType || (parentRecord ? "subagent" : "primary")) || "primary",
    status: normalizeStatus(options.status || "idle"),
    createdAt,
    updatedAt: createdAt,
    lastActiveAt: createdAt,
    startedAt: null,
    completedAt: null,
    lastError: null,
    activeThreadId: threadId,
    threadIds: [threadId],
    childSessionIds: [],
    parentSessionId: parentRecord?.sessionId || toTrimmedString(options.parentSessionId || "") || null,
    parentThreadId: parentRecord?.activeThreadId || toTrimmedString(options.parentThreadId || "") || null,
    rootSessionId,
    lineageDepth: parentRecord ? Number(parentRecord.lineageDepth || 0) + 1 : 0,
    agentId: toTrimmedString(compiledProfile?.agentId || ""),
    profileName: toTrimmedString(compiledProfile?.name || compiledProfile?.agentId || compiledProfile?.taskKey || "harness-session"),
    entryStageId: toTrimmedString(compiledProfile?.entryStageId || ""),
    replayCursor: null,
    metadata: {
      ...(toPlainObject(compiledProfile?.metadata)),
      ...(toPlainObject(options.metadata)),
    },
  };
}

function mergeSessionRecord(record, patch = {}) {
  const next = {
    ...record,
    ...toPlainObject(patch),
    updatedAt: nowIso(),
  };
  next.status = normalizeStatus(next.status || record.status);
  next.threadIds = uniqueStrings([...(record.threadIds || []), ...(next.threadIds || [])]);
  next.childSessionIds = uniqueStrings([...(record.childSessionIds || []), ...(next.childSessionIds || [])]);
  next.activeThreadId = toTrimmedString(next.activeThreadId || record.activeThreadId || "") || null;
  next.parentSessionId = toTrimmedString(next.parentSessionId || record.parentSessionId || "") || null;
  next.parentThreadId = toTrimmedString(next.parentThreadId || record.parentThreadId || "") || null;
  next.rootSessionId = toTrimmedString(next.rootSessionId || record.rootSessionId || next.sessionId) || next.sessionId;
  next.metadata = {
    ...(toPlainObject(record.metadata)),
    ...(toPlainObject(next.metadata)),
  };
  next.lastActiveAt = toTrimmedString(next.lastActiveAt || record.lastActiveAt || next.updatedAt) || next.updatedAt;
  return next;
}

function createLifecyclePatch(event = {}, sessionRecord = {}) {
  const type = toTrimmedString(event.type).toLowerCase();
  if (type === "harness:session-start" || type === "harness:stage-start") {
    return {
      status: "running",
      startedAt: sessionRecord.startedAt || event.timestamp || nowIso(),
      currentStageId: toTrimmedString(event.stageId || sessionRecord.currentStageId || "") || null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:approval-requested") {
    return {
      status: "waiting_approval",
      currentStageId: toTrimmedString(event.stageId || sessionRecord.currentStageId || "") || null,
      approvalRequestId: toTrimmedString(event.requestId || "") || null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:approval-resolved") {
    return {
      status: event.decision === "approved" ? "running" : normalizeStatus(event.decision || "blocked"),
      approvalRequestId: null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:completed") {
    return {
      status: "completed",
      completedAt: event.timestamp || nowIso(),
      currentStageId: toTrimmedString(event.stageId || sessionRecord.currentStageId || "") || null,
      lastError: null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:failed") {
    return {
      status: normalizeStatus(event?.result?.status || "failed"),
      completedAt: event.timestamp || nowIso(),
      lastError: toTrimmedString(event?.result?.error || "") || null,
      currentStageId: toTrimmedString(event.stageId || sessionRecord.currentStageId || "") || null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:aborted") {
    return {
      status: "aborted",
      completedAt: event.timestamp || nowIso(),
      lastError: toTrimmedString(event.reason || "aborted"),
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  return {
    lastActiveAt: event.timestamp || nowIso(),
  };
}

function createInternalSessionManager(defaultOptions = {}) {
  const sessions = new Map();
  const activeSessions = new Map();
  const threadRegistry = defaultOptions.threadRegistry || createThreadRegistry();
  const replayStore = defaultOptions.replayStore || createSessionReplayStore();
  const subagentControl = defaultOptions.subagentControl || createSubagentControl({ threadRegistry });
  const emitManagerEvent = createEventEmitter([
    defaultOptions.onEvent,
    defaultOptions.onHarnessEvent,
    defaultOptions.onSessionEvent,
  ]);

  function getSessionRecord(sessionId) {
    const normalized = toTrimmedString(sessionId);
    return normalized && sessions.has(normalized) ? cloneValue(sessions.get(normalized)) : null;
  }

  function storeSession(record, patch = {}) {
    const next = mergeSessionRecord(record, patch);
    sessions.set(next.sessionId, next);
    return next;
  }

  function captureReplay(sessionRecord, action, payload = {}) {
    const snapshot = replayStore.captureSnapshot({
      sessionId: sessionRecord.sessionId,
      runId: sessionRecord.runId,
      threadId: payload.threadId || sessionRecord.activeThreadId,
      parentSessionId: sessionRecord.parentSessionId,
      parentThreadId: sessionRecord.parentThreadId,
      rootSessionId: sessionRecord.rootSessionId,
      action,
      eventType: payload.eventType || null,
      status: payload.status || sessionRecord.status,
      summary: toTrimmedString(payload.summary || payload?.result?.error || payload?.result?.status || "") || null,
      state: {
        session: sessionRecord,
        thread: sessionRecord.activeThreadId ? threadRegistry.getThread(sessionRecord.activeThreadId) : null,
        meta: toPlainObject(payload.meta),
      },
      result: payload.result ? cloneValue(payload.result) : undefined,
    });
    return storeSession(sessionRecord, { replayCursor: snapshot.snapshotId });
  }

  function createManagedCompiledSession(compiledProfile, options = {}) {
    if (!compiledProfile || typeof compiledProfile !== "object" || !Array.isArray(compiledProfile.stages)) {
      throw new Error("Compiled harness profile is required");
    }
    const mergedOptions = { ...defaultOptions, ...options };
    const parentRecord = toTrimmedString(mergedOptions.parentSessionId || "")
      ? sessions.get(toTrimmedString(mergedOptions.parentSessionId))
      : null;
    let sessionRecord = buildSessionRecord(compiledProfile, mergedOptions, parentRecord);
    const eventHook = createEventEmitter([emitManagerEvent, mergedOptions.onHarnessEvent, mergedOptions.onEvent]);
    const threadRecord = threadRegistry.registerThread({
      threadId: sessionRecord.activeThreadId,
      sessionId: sessionRecord.sessionId,
      parentThreadId: sessionRecord.parentThreadId || undefined,
      parentSessionId: sessionRecord.parentSessionId || undefined,
      rootSessionId: sessionRecord.rootSessionId,
      role: parentRecord ? "subagent" : "primary",
      kind: sessionRecord.sessionType,
      status: sessionRecord.status,
      taskKey: sessionRecord.taskKey,
      taskId: sessionRecord.taskId || undefined,
      taskTitle: sessionRecord.taskTitle || undefined,
      metadata: { sessionType: sessionRecord.sessionType, agentId: sessionRecord.agentId },
    });
    sessionRecord = storeSession(sessionRecord, { activeThreadId: threadRecord.threadId, threadIds: [threadRecord.threadId] });
    activeSessions.set(sessionRecord.sessionType || "default", sessionRecord.sessionId);
    if (parentRecord) {
      storeSession(parentRecord, { childSessionIds: [sessionRecord.sessionId] });
      subagentControl.registerSubagent({
        parentSessionId: parentRecord.sessionId,
        parentThreadId: parentRecord.activeThreadId,
        childSessionId: sessionRecord.sessionId,
        childThreadId: sessionRecord.activeThreadId,
        taskKey: sessionRecord.taskKey,
        status: sessionRecord.status,
        metadata: mergedOptions.metadata,
      });
    }
    sessionRecord = captureReplay(sessionRecord, "session_created", {
      status: sessionRecord.status,
      meta: { entryStageId: compiledProfile.entryStageId || null },
    });

    const runtimeController = createHarnessRuntimeSession(compiledProfile, {
      onEvent: (event) => {
        eventHook(event);
        const current = sessions.get(sessionRecord.sessionId) || sessionRecord;
        const patch = createLifecyclePatch(event, current);
        const resultThreadId = toTrimmedString(event?.result?.threadId || event?.threadId || current.activeThreadId || "");
        if (resultThreadId) {
          threadRegistry.registerThread({
            threadId: resultThreadId,
            sessionId: current.sessionId,
            parentThreadId: current.parentThreadId || undefined,
            parentSessionId: current.parentSessionId || undefined,
            rootSessionId: current.rootSessionId,
            status: patch.status || current.status,
            taskKey: current.taskKey,
            taskId: current.taskId || undefined,
            taskTitle: current.taskTitle || undefined,
            metadata: { eventType: event.type, sessionType: current.sessionType },
          });
        }
        sessionRecord = storeSession(current, {
          ...patch,
          activeThreadId: resultThreadId || current.activeThreadId,
          threadIds: resultThreadId ? [resultThreadId] : current.threadIds,
        });
        if (sessionRecord.activeThreadId) {
          if (sessionRecord.status === "completed") {
            threadRegistry.markThreadCompleted(sessionRecord.activeThreadId, { result: event.result });
          } else if (sessionRecord.status === "aborted") {
            threadRegistry.closeThread(sessionRecord.activeThreadId, { status: "aborted", error: sessionRecord.lastError });
          } else if (sessionRecord.status.includes("failed") || sessionRecord.status.startsWith("approval_")) {
            threadRegistry.markThreadFailed(sessionRecord.activeThreadId, sessionRecord.lastError || event?.result?.error || "session_failed");
          } else {
            threadRegistry.markThreadRunning(sessionRecord.activeThreadId, { lastStageId: event.stageId || undefined });
          }
        }
        if (sessionRecord.parentSessionId) {
          subagentControl.updateSubagent(sessionRecord.sessionId, {
            status: sessionRecord.status,
            childThreadId: sessionRecord.activeThreadId,
            lastError: sessionRecord.lastError,
            lastEventType: event.type,
          });
        }
        sessionRecord = captureReplay(sessionRecord, event.type, {
          eventType: event.type,
          status: sessionRecord.status,
          result: event.result,
          threadId: resultThreadId || sessionRecord.activeThreadId,
          meta: { stageId: event.stageId || null, toStageId: event.toStageId || null, requestId: event.requestId || null },
        });
      },
      runId: mergedOptions.runId || sessionRecord.runId,
      dryRun: mergedOptions.dryRun === true,
      abortController: mergedOptions.abortController || null,
      taskKey: sessionRecord.taskKey,
      taskId: sessionRecord.taskId,
      taskTitle: sessionRecord.taskTitle,
      artifactId: mergedOptions.artifactId,
      sourceOrigin: mergedOptions.sourceOrigin,
      sourcePath: mergedOptions.sourcePath,
      approvalRepoRoot: mergedOptions.approvalRepoRoot,
      requestedBy: mergedOptions.requestedBy,
      emitApprovalResolutionEvent: mergedOptions.emitApprovalResolutionEvent,
      steerActiveTurn: typeof mergedOptions.steerActiveTurn === "function" ? mergedOptions.steerActiveTurn : undefined,
      executeTurn: resolveTurnExecutor(mergedOptions),
      extensions: mergedOptions.extensions,
      extensionRegistry: mergedOptions.extensionRegistry,
    });

    let running = null;
    const controller = {
      abort(reason = "aborted") {
        runtimeController.abort(reason);
        sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
          status: "aborted",
          completedAt: nowIso(),
          lastError: toTrimmedString(reason) || "aborted",
        });
        if (sessionRecord.activeThreadId) {
          threadRegistry.closeThread(sessionRecord.activeThreadId, { status: "aborted", error: sessionRecord.lastError });
        }
        if (sessionRecord.parentSessionId) {
          subagentControl.updateSubagent(sessionRecord.sessionId, { status: "aborted", lastError: sessionRecord.lastError });
        }
        sessionRecord = captureReplay(sessionRecord, "session_aborted", { status: "aborted", summary: sessionRecord.lastError });
      },
      canSteer() {
        return runtimeController.canSteer?.() === true;
      },
      steer(prompt, meta = {}) {
        const response = runtimeController.steer?.(prompt, meta) || {
          ok: false,
          delivered: false,
          reason: "not_steerable",
          interventionType: toTrimmedString(meta?.kind || meta?.type || "nudge") || "nudge",
          stageId: null,
          targetTaskKey: null,
        };
        sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, { lastActiveAt: nowIso() });
        sessionRecord = captureReplay(sessionRecord, response.delivered ? "steer_delivered" : "steer_rejected", {
          status: sessionRecord.status,
          summary: response.reason,
          meta: { prompt, ...toPlainObject(meta), delivered: response.delivered === true },
        });
        return response;
      },
      async run() {
        if (running) return running;
        sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
          status: mergedOptions.dryRun === true ? "dry_run" : "running",
          startedAt: sessionRecord.startedAt || nowIso(),
        });
        if (sessionRecord.activeThreadId) {
          threadRegistry.markThreadRunning(sessionRecord.activeThreadId);
        }
        sessionRecord = captureReplay(sessionRecord, "session_run_requested", { status: sessionRecord.status });
        running = runtimeController.run()
          .then((result) => {
            const nextStatus = normalizeStatus(result?.status || (result?.success === false ? "failed" : "completed"));
            sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
              status: nextStatus,
              completedAt: nowIso(),
              lastError: toTrimmedString(result?.error || "") || null,
            });
            if (sessionRecord.activeThreadId) {
              if (result?.success === false) {
                threadRegistry.markThreadFailed(sessionRecord.activeThreadId, result?.error || nextStatus, { result });
              } else {
                threadRegistry.markThreadCompleted(sessionRecord.activeThreadId, { result });
              }
            }
            if (sessionRecord.parentSessionId) {
              subagentControl.updateSubagent(sessionRecord.sessionId, { status: nextStatus, lastError: sessionRecord.lastError });
            }
            sessionRecord = captureReplay(sessionRecord, result?.success === false ? "session_failed" : "session_completed", {
              status: nextStatus,
              result,
            });
            return result;
          })
          .catch((error) => {
            sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
              status: "failed",
              completedAt: nowIso(),
              lastError: String(error?.message || error || "Harness session failed"),
            });
            if (sessionRecord.activeThreadId) {
              threadRegistry.markThreadFailed(sessionRecord.activeThreadId, sessionRecord.lastError);
            }
            if (sessionRecord.parentSessionId) {
              subagentControl.updateSubagent(sessionRecord.sessionId, { status: "failed", lastError: sessionRecord.lastError });
            }
            sessionRecord = captureReplay(sessionRecord, "session_failed", { status: "failed", summary: sessionRecord.lastError });
            throw error;
          })
          .finally(() => {
            running = null;
          });
        return running;
      },
    };

    return {
      agentId: compiledProfile.agentId || "",
      sessionId: sessionRecord.sessionId,
      threadId: sessionRecord.activeThreadId,
      compiledProfile,
      compiledProfileJson: JSON.stringify(compiledProfile, null, 2),
      validationReport: { errors: [], warnings: [], stats: compiledProfile.metadata || {} },
      isValid: true,
      controller,
      runtimeController,
      get session() {
        return getSessionRecord(sessionRecord.sessionId);
      },
      get replay() {
        return replayStore.buildResumeState(sessionRecord.sessionId);
      },
      canSteer: () => controller.canSteer(),
      steer: (prompt, meta = {}) => controller.steer(prompt, meta),
      abort: (reason = "aborted") => controller.abort(reason),
      run: () => controller.run(),
      getSessionRecord: () => getSessionRecord(sessionRecord.sessionId),
      listReplaySnapshots: (replayOptions = {}) => replayStore.listSnapshots(sessionRecord.sessionId, replayOptions),
      getReplayState: (replayOptions = {}) => replayStore.buildResumeState(sessionRecord.sessionId, replayOptions),
      listChildSessions: () => subagentControl.listChildren({ parentSessionId: sessionRecord.sessionId }),
    };
  }

  function createManagedSession(profileSource, options = {}) {
    const compiled = compileProfileSource(profileSource, options);
    if (!compiled?.isValid || !compiled?.compiledProfile) {
      const error = new Error(formatHarnessValidationError(compiled?.validationReport));
      error.validationReport = compiled?.validationReport || { errors: [], warnings: [], stats: {} };
      throw error;
    }
    return {
      ...createManagedCompiledSession(compiled.compiledProfile, options),
      ...compiled,
    };
  }

  return {
    createCompiledSession: createManagedCompiledSession,
    createSession: createManagedSession,
    async runCompiledSession(compiledProfile, options = {}) {
      const session = createManagedCompiledSession(compiledProfile, options);
      const result = await session.run();
      return { ...session, result };
    },
    async runSession(profileSource, options = {}) {
      const session = createManagedSession(profileSource, options);
      const result = await session.run();
      return { ...session, result };
    },
    getSession(sessionId) {
      return getSessionRecord(sessionId);
    },
    listSessions(filters = {}) {
      return [...sessions.values()]
        .filter((record) => {
          if (toTrimmedString(filters.scope) && toTrimmedString(record.scope) !== toTrimmedString(filters.scope)) return false;
          if (toTrimmedString(filters.status) && normalizeStatus(record.status) !== normalizeStatus(filters.status)) return false;
          if (toTrimmedString(filters.sessionType) && toTrimmedString(record.sessionType) !== toTrimmedString(filters.sessionType)) return false;
          if (toTrimmedString(filters.taskKey) && toTrimmedString(record.taskKey) !== toTrimmedString(filters.taskKey)) return false;
          if (toTrimmedString(filters.parentSessionId) && toTrimmedString(record.parentSessionId) !== toTrimmedString(filters.parentSessionId)) return false;
          return true;
        })
        .map((record) => cloneValue(record));
    },
    switchSession(sessionId, scope = "default") {
      const normalized = toTrimmedString(sessionId);
      if (!normalized) return null;
      const scopeOptions = typeof scope === "object" && scope !== null ? scope : { scope };
      const normalizedScope = toTrimmedString(scopeOptions.scope || "default") || "default";
      if (!sessions.has(normalized)) {
        this.ensureSession({
          ...scopeOptions,
          sessionId: normalized,
        });
      }
      activeSessions.set(normalizedScope, normalized);
      return getSessionRecord(normalized);
    },
    setActiveSession(sessionId, scope = "default") {
      return this.switchSession(sessionId, scope);
    },
    getActiveSession(scope = "default") {
      const sessionId = activeSessions.get(toTrimmedString(scope || "default") || "default");
      return sessionId ? getSessionRecord(sessionId) : null;
    },
    getActiveSessionId(scope = "default") {
      return this.getActiveSession(scope)?.sessionId || null;
    },
    createSubagentSession(profileSourceOrCompiled, options = {}) {
      const nextOptions = { ...options, sessionType: options.sessionType || "subagent" };
      if (profileSourceOrCompiled && Array.isArray(profileSourceOrCompiled.stages)) {
        return createManagedCompiledSession(profileSourceOrCompiled, nextOptions);
      }
      return createManagedSession(profileSourceOrCompiled, nextOptions);
    },
    ensureSession(input = {}) {
      const sessionId = toTrimmedString(input.sessionId || input.id || "");
      if (sessionId && sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        const patched = storeSession(existing, {
          scope: input.scope || existing.scope || "default",
          sessionType: input.sessionType || existing.sessionType || "primary",
          taskKey: input.taskKey || existing.taskKey,
          metadata: {
            ...(toPlainObject(existing.metadata)),
            ...(toPlainObject(input.metadata)),
            cwd: input.cwd || existing.metadata?.cwd || "",
            providerSelection: input.providerSelection || existing.metadata?.providerSelection || "",
            adapterName: input.adapterName || existing.metadata?.adapterName || "",
          },
        });
        return cloneValue(patched);
      }
      const createdAt = nowIso();
      const record = {
        sessionId: sessionId || createSessionId(input.sessionType || "session"),
        runId: sessionId || createSessionId("run"),
        scope: toTrimmedString(input.scope || "default") || "default",
        taskKey: toTrimmedString(input.taskKey || sessionId || ""),
        taskId: null,
        taskTitle: null,
        sessionType: toTrimmedString(input.sessionType || "primary") || "primary",
        status: normalizeStatus(input.status || "idle"),
        createdAt,
        updatedAt: createdAt,
        lastActiveAt: createdAt,
        startedAt: null,
        completedAt: null,
        lastError: null,
        activeThreadId: toTrimmedString(input.threadId || "") || null,
        threadIds: uniqueStrings(input.threadId ? [input.threadId] : []),
        childSessionIds: [],
        parentSessionId: null,
        parentThreadId: null,
        rootSessionId: sessionId || null,
        lineageDepth: 0,
        agentId: "",
        profileName: toTrimmedString(input.scope || input.sessionType || "session") || "session",
        entryStageId: "",
        replayCursor: null,
        metadata: {
          ...(toPlainObject(input.metadata)),
          cwd: input.cwd || "",
          providerSelection: input.providerSelection || "",
          adapterName: input.adapterName || "",
          scope: input.scope || "default",
        },
      };
      sessions.set(record.sessionId, record);
      if (record.activeThreadId) {
        threadRegistry.registerThread({
          threadId: record.activeThreadId,
          sessionId: record.sessionId,
          status: record.status,
          kind: record.sessionType,
          taskKey: record.taskKey || undefined,
          metadata: record.metadata,
        });
      }
      return cloneValue(record);
    },
    createChildSession(parentSessionId, input = {}) {
      const parent = toTrimmedString(parentSessionId) ? sessions.get(toTrimmedString(parentSessionId)) : null;
      if (!parent) return null;
      const child = this.ensureSession({
        ...input,
        parentSessionId: parent.sessionId,
        sessionType: input.sessionType || "subagent",
      });
      const patchedChild = storeSession(sessions.get(child.sessionId) || child, {
        parentSessionId: parent.sessionId,
        parentThreadId: toTrimmedString(input.parentThreadId || parent.activeThreadId || "") || null,
        rootSessionId: parent.rootSessionId || parent.sessionId,
        lineageDepth: Number(parent.lineageDepth || 0) + 1,
      });
      storeSession(parent, { childSessionIds: [patchedChild.sessionId] });
      subagentControl.registerSubagent({
        parentSessionId: parent.sessionId,
        parentThreadId: parent.activeThreadId,
        childSessionId: patchedChild.sessionId,
        childThreadId: patchedChild.activeThreadId,
        taskKey: patchedChild.taskKey,
        status: patchedChild.status,
        metadata: input.metadata,
      });
      return cloneValue(patchedChild);
    },
    registerExecution(sessionId, execution = {}) {
      const existing = this.ensureSession({
        sessionId,
        sessionType: execution.sessionType || "primary",
        taskKey: execution.taskKey || sessionId,
        threadId: execution.threadId || null,
        metadata: {
          ...(toPlainObject(execution.metadata)),
          cwd: execution.cwd || "",
          providerSelection: execution.providerSelection || "",
          adapterName: execution.adapterName || "",
          scope: execution.scope || "default",
        },
      });
      const next = storeSession(sessions.get(existing.sessionId) || existing, {
        status: normalizeStatus(execution.status || existing.status || "active"),
        activeThreadId: toTrimmedString(execution.threadId || existing.activeThreadId || "") || null,
        threadIds: execution.threadId ? [execution.threadId] : existing.threadIds,
        lastError: toTrimmedString(execution.error || existing.lastError || "") || null,
        lastActiveAt: nowIso(),
      });
      if (next.activeThreadId) {
        threadRegistry.registerThread({
          threadId: next.activeThreadId,
          sessionId: next.sessionId,
          parentThreadId: next.parentThreadId || undefined,
          parentSessionId: next.parentSessionId || undefined,
          rootSessionId: next.rootSessionId,
          status: next.status,
          kind: next.sessionType,
          taskKey: next.taskKey || undefined,
          metadata: {
            ...(toPlainObject(next.metadata)),
            providerSelection: execution.providerSelection || "",
            adapterName: execution.adapterName || "",
          },
        });
      }
      return cloneValue(next);
    },
    spawnSubagent(profileSourceOrCompiled, options = {}) {
      return this.createSubagentSession(profileSourceOrCompiled, options);
    },
    getThreadRegistry() {
      return threadRegistry;
    },
    getReplayStore() {
      return replayStore;
    },
    getSubagentControl() {
      return subagentControl;
    },
    getReplaySnapshot(sessionId, options = {}) {
      const session = sessionId ? this.getSession(sessionId) : null;
      const tracker = getSessionTracker();
      const tracked = sessionId && typeof tracker?.getSession === "function"
        ? tracker.getSession(sessionId)
        : null;
      const replayState = replayStore.buildResumeState(sessionId, options);
      const childSessions = session?.sessionId
        ? subagentControl.listChildren({ parentSessionId: session.sessionId })
        : [];
      const thread = session?.activeThreadId
        ? threadRegistry.getThread(session.activeThreadId)
        : null;
      return {
        sessionId: toTrimmedString(session?.sessionId || sessionId || "") || null,
        taskKey: toTrimmedString(session?.taskKey || tracked?.taskId || sessionId || "") || null,
        status: session?.status || tracked?.status || replayState?.latestSnapshot?.status || "idle",
        createdAt: session?.createdAt || tracked?.createdAt || null,
        lastActiveAt: session?.lastActiveAt || tracked?.lastActiveAt || null,
        replayable: true,
        thread,
        lineage: {
          parentSessionId: session?.parentSessionId || null,
          childSessionIds: childSessions
            .map((entry) => toTrimmedString(entry?.childSessionId || ""))
            .filter(Boolean),
        },
        messages: Array.isArray(tracked?.messages)
          ? tracked.messages.map((message, index) => ({
              index,
              role: toTrimmedString(message?.role || message?.type || "message") || "message",
              type: toTrimmedString(message?.type || message?.role || "message") || "message",
              content: String(message?.content || message?.summary || message?.text || ""),
              timestamp: toTrimmedString(message?.timestamp || message?.createdAt || "") || null,
              meta: toPlainObject(message?.meta),
            }))
          : [],
        replayState,
      };
    },
    getReplayState(sessionId, options = {}) {
      return replayStore.buildResumeState(sessionId, options);
    },
    snapshot() {
      return {
        sessions: this.listSessions(),
        activeSessions: Object.fromEntries(activeSessions.entries()),
        threadRegistry: threadRegistry.snapshot(),
        replayStore: replayStore.snapshot(),
        subagentControl: subagentControl.snapshot(),
      };
    },
  };
}

const defaultHarnessSessionManager = createInternalSessionManager();

export function getDefaultHarnessSessionManager() {
  return defaultHarnessSessionManager;
}

export function getBosunSessionManager() {
  return defaultHarnessSessionManager;
}

export function createCompiledHarnessSession(compiledProfile, options = {}) {
  return (options.sessionManager || defaultHarnessSessionManager).createCompiledSession(compiledProfile, options);
}

export function createHarnessSession(profileSource, options = {}) {
  return (options.sessionManager || defaultHarnessSessionManager).createSession(profileSource, options);
}

export async function runCompiledHarnessSession(compiledProfile, options = {}) {
  return (options.sessionManager || defaultHarnessSessionManager).runCompiledSession(compiledProfile, options);
}

export async function runHarnessSession(profileSource, options = {}) {
  return (options.sessionManager || defaultHarnessSessionManager).runSession(profileSource, options);
}

export function createHarnessSessionManager(defaultOptions = {}) {
  return createInternalSessionManager(defaultOptions);
}

export const createBosunSessionManager = createHarnessSessionManager;

export default createHarnessSessionManager;
