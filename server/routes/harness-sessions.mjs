function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function isTruthyQueryValue(value) {
  return /^(1|true|yes)$/i.test(toTrimmedString(value));
}

function trimText(value, maxLength = 400) {
  const text = value == null ? "" : String(value);
  if (!text) return text;
  if (!Number.isFinite(Number(maxLength)) || maxLength <= 0) return text;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function compactSessionMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return {};
  const compact = {};
  const keys = [
    "agent",
    "mode",
    "model",
    "agentProfileId",
    "workspaceId",
    "workspaceDir",
    "workspaceRoot",
    "source",
    "visibility",
    "hidden",
    "hiddenInLists",
  ];
  for (const key of keys) {
    if (metadata[key] !== undefined) compact[key] = metadata[key];
  }
  return compact;
}

function compactSessionInsights(insights = {}) {
  if (!insights || typeof insights !== "object") return {};
  const compact = {};
  const keys = [
    "totals",
    "fileCounts",
    "contextWindow",
    "contextBreakdown",
    "tokenUsage",
    "runtimeHealth",
    "lastActionAt",
  ];
  for (const key of keys) {
    if (insights[key] !== undefined) compact[key] = insights[key];
  }
  if (Array.isArray(insights.topTools)) compact.topTools = insights.topTools.slice(0, 5);
  if (Array.isArray(insights.recentActions)) compact.recentActions = insights.recentActions.slice(0, 6);
  return compact;
}

function compactSessionListItem(session = {}) {
  if (!session || typeof session !== "object") return session;
  const compact = { ...session };
  const messageCount = Array.isArray(compact.messages) ? compact.messages.length : undefined;
  const turnCountFromRows = Array.isArray(compact.turns) ? compact.turns.length : 0;
  if (messageCount != null) compact.messageCount = messageCount;
  compact.turnCount = Math.max(Number(compact.turnCount || 0), turnCountFromRows);
  compact.preview = trimText(compact.preview, 280);
  compact.lastMessage = trimText(compact.lastMessage, 280);
  compact.summary = trimText(compact.summary, 400);
  if (compact.metadata && typeof compact.metadata === "object") {
    compact.metadata = compactSessionMetadata(compact.metadata);
  }
  if (compact.insights && typeof compact.insights === "object") {
    compact.insights = compactSessionInsights(compact.insights);
  }
  if (Array.isArray(compact.topTools)) compact.topTools = compact.topTools.slice(0, 5);
  if (Array.isArray(compact.recentActions)) compact.recentActions = compact.recentActions.slice(0, 6);
  compact.turns = Array.isArray(compact.turns)
    ? compact.turns.slice(-6).map((turn) => ({ ...turn }))
    : [];
  delete compact.messages;
  delete compact.trajectory;
  return compact;
}

function mergeSessionListItems(primarySessions = [], fallbackSessions = [], mergeSessionRecords) {
  const byId = new Map();
  for (const session of Array.isArray(primarySessions) ? primarySessions : []) {
    const sessionId = toTrimmedString(session?.id || session?.taskId);
    if (!sessionId) continue;
    byId.set(sessionId, session);
  }
  for (const session of Array.isArray(fallbackSessions) ? fallbackSessions : []) {
    const sessionId = toTrimmedString(session?.id || session?.taskId);
    if (!sessionId) continue;
    const existing = byId.get(sessionId) || null;
    byId.set(sessionId, existing ? mergeSessionRecords(existing, session) : session);
  }
  return [...byId.values()].sort((a, b) =>
    String(b?.lastActiveAt || "").localeCompare(String(a?.lastActiveAt || "")),
  );
}

function resolveRequestWorkspace(url, deps, allowAll = true) {
  return deps.resolveWorkspaceContextFromRequest(url, { allowAll });
}

function buildScopedSessionHelpers(sessionId, workspaceContext, deps) {
  const tracker = deps.getSessionTracker();

  const getScopedSession = () => {
    const trackerSession = tracker.getSessionById(sessionId);
    const ledgerSession = deps.normalizeLedgerSessionDocument(
      deps.getSessionActivityFromStateLedger(sessionId, deps.resolveUiStateLedgerOptions(workspaceContext)),
    );
    const session = deps.mergeSessionRecords(trackerSession, ledgerSession);
    if (!session) return null;
    return deps.sessionMatchesWorkspaceContext(session, workspaceContext) ? session : null;
  };

  const getScopedSessionRecord = ({ includeMessages = false } = {}) => {
    const trackerSession = includeMessages
      ? tracker.getSessionMessages(sessionId)
      : (tracker.getSessionById(sessionId) || tracker.getSessionMessages(sessionId));
    const ledgerSession = deps.normalizeLedgerSessionDocument(
      deps.getSessionActivityFromStateLedger(sessionId, deps.resolveUiStateLedgerOptions(workspaceContext)),
      { includeMessages },
    );
    const durableSession = deps.mergeSessionRecords(trackerSession, ledgerSession);
    if (!durableSession) return null;
    return deps.sessionMatchesWorkspaceContext(durableSession, workspaceContext) ? durableSession : null;
  };

  const mutateDurableSessionRecord = (session, nextStatus) => {
    if (!session || typeof session !== "object") return null;
    const now = new Date().toISOString();
    const document = {
      ...session,
      status: nextStatus,
      lifecycleStatus: nextStatus,
      runtimeState: nextStatus,
      runtimeIsLive: false,
      lastActiveAt: now,
      updatedAt: now,
      metadata:
        session.metadata && typeof session.metadata === "object"
          ? { ...session.metadata }
          : {},
    };
    return deps.upsertSessionRecordToStateLedger({
      ...session,
      status: nextStatus,
      lifecycleStatus: nextStatus,
      runtimeState: nextStatus,
      runtimeIsLive: false,
      updatedAt: now,
      lastActiveAt: now,
      eventCount: Math.max(0, Number(session.eventCount ?? session.totalEvents ?? 0) || 0),
      document,
    }, deps.resolveUiStateLedgerOptions(workspaceContext));
  };

  return {
    tracker,
    getScopedSession,
    getScopedSessionRecord,
    mutateDurableSessionRecord,
  };
}

export async function tryHandleHarnessSessionRoutes(context = {}) {
  const { req, res, path, url, deps = {} } = context;
  const {
    jsonResponse,
    getBosunSessionManager,
    getSessionTracker,
    mergeTrackerAndLedgerSessions,
    shouldHideSessionFromDefaultList,
    sessionMatchesWorkspaceContext,
    normalizeCandidatePath,
    repoRoot,
    getPrimaryAgentName,
    getAgentMode,
    broadcastUiEvent,
    broadcastSessionsSnapshot,
    sessionRunAbortControllers,
    readJsonBody,
    resolveSessionWorkspaceDir,
    resolveInteractiveSessionExecutor,
    readMultipartForm,
    sanitizePathSegment,
    ATTACHMENTS_ROOT,
    extname,
    basename,
    randomBytes,
    writeFileSync,
    relative,
    MIME_TYPES,
    resolveAttachmentUrl,
    getSessionActivityFromStateLedger,
    normalizeLedgerSessionDocument,
    mergeSessionRecords,
    listDurableSessionsFromLedger,
    resolveUiStateLedgerOptions,
    upsertSessionRecordToStateLedger,
    invalidateDurableSessionListCache,
    deleteSessionRecordFromStateLedger,
    resolveSessionWorktreePath,
    existsSync,
    collectDiffStats,
    getCompactDiffSummary,
    getRecentCommits,
    resolveActiveWorkspaceExecutionContext,
  } = deps;

  if (path === "/api/harness/sessions" && req.method === "GET") {
    try {
      const sessionManager = getBosunSessionManager();
      const status = toTrimmedString(url.searchParams.get("status") || "");
      const sessionType = toTrimmedString(url.searchParams.get("sessionType") || "");
      const taskKey = toTrimmedString(url.searchParams.get("taskKey") || "");
      const parentSessionId = toTrimmedString(url.searchParams.get("parentSessionId") || "");
      const scope = toTrimmedString(url.searchParams.get("scope") || "");
      const sessions = sessionManager.listSessions({
        ...(status ? { status } : {}),
        ...(sessionType ? { sessionType } : {}),
        ...(taskKey ? { taskKey } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      }).filter((record) => {
        if (!scope) return true;
        return toTrimmedString(record?.scope || "") === scope;
      });
      const items = sessions.map((record) => ({
        ...record,
        replay: sessionManager.getReplayState(record.sessionId),
        lineage: {
          parentSessionId: record.parentSessionId || null,
          childSessionIds: Array.isArray(record.childSessionIds) ? record.childSessionIds.slice() : [],
          rootSessionId: record.rootSessionId || record.sessionId || null,
          lineageDepth: Number(record.lineageDepth || 0),
        },
      }));
      jsonResponse(res, 200, {
        ok: true,
        activeSessions: sessionManager.snapshot().activeSessions,
        items,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  const harnessSessionReplayMatch = path.match(/^\/api\/harness\/sessions\/([^/]+)\/replay$/);
  if (harnessSessionReplayMatch && req.method === "GET") {
    try {
      const sessionId = decodeURIComponent(harnessSessionReplayMatch[1]);
      const sessionManager = getBosunSessionManager();
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: `Harness session not found: ${sessionId}` });
        return true;
      }
      jsonResponse(res, 200, {
        ok: true,
        sessionId,
        replay: sessionManager.getReplaySnapshot(sessionId),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  const harnessSessionMatch = path.match(/^\/api\/harness\/sessions\/([^/]+)$/);
  if (harnessSessionMatch && req.method === "GET") {
    try {
      const sessionId = decodeURIComponent(harnessSessionMatch[1]);
      const sessionManager = getBosunSessionManager();
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: `Harness session not found: ${sessionId}` });
        return true;
      }
      jsonResponse(res, 200, {
        ok: true,
        session,
        replay: sessionManager.getReplaySnapshot(sessionId),
        replayState: sessionManager.getReplayState(sessionId),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/sessions" && req.method === "GET") {
    try {
      const tracker = getSessionTracker();
      const workspaceContext = resolveRequestWorkspace(url, deps, true);
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return true;
      }
      const includeHidden = /^(1|true|yes)$/i.test(toTrimmedString(url.searchParams.get("includeHidden") || ""));
      const typeFilter = url.searchParams.get("type");
      const statusFilter = url.searchParams.get("status");
      const wantsFull = isTruthyQueryValue(url.searchParams.get("full"));
      const parsedLimit = Number(url.searchParams.get("limit"));
      const parsedOffset = Number(url.searchParams.get("offset"));
      const requestedWorkspace = toTrimmedString(url.searchParams.get("workspace") || "").toLowerCase();
      const allowLegacyWithoutWorkspace =
        !typeFilter
        && !statusFilter
        && (!requestedWorkspace || requestedWorkspace === "active");
      const lightweightList = !wantsFull;
      const liveSessions = tracker.listAllSessions({
        includePersisted: false,
        includeRuntimeProgress: wantsFull,
        lightweight: lightweightList,
      });
      const durableSessions = typeof listDurableSessionsFromLedger === "function"
        ? listDurableSessionsFromLedger(workspaceContext, {
            allowLegacyWithoutWorkspace,
            summaryOnly: lightweightList,
          })
        : [];
      let sessions = durableSessions.length > 0 || liveSessions.length > 0
        ? mergeSessionListItems(liveSessions, durableSessions, mergeSessionRecords)
        : mergeTrackerAndLedgerSessions(tracker.listAllSessions({
            includePersisted: false,
            includeRuntimeProgress: wantsFull,
            lightweight: lightweightList,
          }), workspaceContext, {
            allowLegacyWithoutWorkspace,
          });
      if (!includeHidden) {
        sessions = sessions.filter((session) => !shouldHideSessionFromDefaultList(session));
      }
      if (typeFilter) sessions = sessions.filter((session) => session.type === typeFilter);
      if (statusFilter) sessions = sessions.filter((session) => session.status === statusFilter);
      sessions = sessions.filter((session) => sessionMatchesWorkspaceContext(session, workspaceContext, {
        allowLegacyWithoutWorkspace,
      }));
      const total = sessions.length;
      const offset = Number.isFinite(parsedOffset) && parsedOffset > 0
        ? Math.min(Math.trunc(parsedOffset), total)
        : 0;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.max(1, Math.min(Math.trunc(parsedLimit), 500))
        : 0;
      const pagedSessions = limit > 0
        ? sessions.slice(offset, offset + limit)
        : sessions;
      const responseSessions = wantsFull
        ? pagedSessions
        : pagedSessions.map((session) => compactSessionListItem(session));
      jsonResponse(res, 200, {
        ok: true,
        sessions: responseSessions,
        pagination: {
          total,
          offset,
          limit: limit > 0 ? limit : total,
          hasMore: limit > 0 ? offset + pagedSessions.length < total : false,
        },
        loadMeta: {
          stale: false,
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: null,
          staleReason: null,
          staleReasonCode: null,
          staleReasonLabel: null,
          staleReasonMeta: null,
          retryAttempt: 0,
          retryDelayMs: 0,
          nextRetryAt: null,
          retriesExhausted: false,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/sessions/create" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const type = body?.type || "manual";
      const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const workspaceContext = resolveActiveWorkspaceExecutionContext();
      const requestedWorkspaceId = toTrimmedString(body?.workspaceId || "");
      const requestedWorkspaceDir = normalizeCandidatePath(body?.workspaceDir);
      const requestedWorkspaceRoot = normalizeCandidatePath(body?.workspaceRoot);
      const resolvedWorkspaceId = requestedWorkspaceId || workspaceContext.workspaceId;
      const resolvedWorkspaceDir = requestedWorkspaceDir || workspaceContext.workspaceDir || repoRoot;
      const resolvedWorkspaceRoot = requestedWorkspaceRoot || workspaceContext.workspaceRoot || resolvedWorkspaceDir;
      const requestedAgentProfileId = toTrimmedString(body?.agentProfileId || "");
      const tracker = getSessionTracker();
      const session = tracker.createSession({
        id,
        type,
        metadata: {
          prompt: body?.prompt,
          agent: body?.agent || getPrimaryAgentName(),
          mode: body?.mode || getAgentMode(),
          model: body?.model || undefined,
          ...(requestedAgentProfileId ? { agentProfileId: requestedAgentProfileId } : {}),
          ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
          ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
          ...(resolvedWorkspaceRoot ? { workspaceRoot: resolvedWorkspaceRoot } : {}),
        },
      });
      jsonResponse(res, 200, {
        ok: true,
        session: { id: session.id, type: session.type, status: session.status, metadata: session.metadata },
      });
      broadcastUiEvent(["sessions"], "invalidate", { reason: "session-created", sessionId: id });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (!sessionMatch) {
    return false;
  }

  const sessionId = decodeURIComponent(sessionMatch[1]);
  const action = sessionMatch[2] || null;
  const workspaceContext = resolveRequestWorkspace(url, deps, true);
  if (!workspaceContext) {
    jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
    return true;
  }
  const {
    tracker,
    getScopedSession,
    getScopedSessionRecord,
    mutateDurableSessionRecord,
  } = buildScopedSessionHelpers(sessionId, workspaceContext, {
    getSessionTracker,
    getSessionActivityFromStateLedger,
    normalizeLedgerSessionDocument,
    resolveUiStateLedgerOptions,
    mergeSessionRecords,
    sessionMatchesWorkspaceContext,
    upsertSessionRecordToStateLedger,
  });

  if (!action && req.method === "GET") {
    try {
      const session = getScopedSessionRecord({ includeMessages: true });
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      const limitParam = url.searchParams.get("limit");
      const offsetParam = url.searchParams.get("offset");
      const fullParam = toTrimmedString(url.searchParams.get("full") || "").toLowerCase();
      const wantsFull = fullParam === "1" || fullParam === "true" || fullParam === "yes";
      if (wantsFull) {
        jsonResponse(res, 200, { ok: true, session });
        return true;
      }
      const parsedLimit = Number(limitParam);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.max(1, Math.min(Math.floor(parsedLimit), 200))
        : 20;
      const allMessages = session.messages || [];
      const total = allMessages.length;
      const offset = offsetParam != null
        ? Math.max(0, Math.min(Number(offsetParam) || 0, total))
        : Math.max(0, total - limit);
      const sliced = allMessages.slice(offset, offset + limit);
      jsonResponse(res, 200, {
        ok: true,
        session: { ...session, messages: sliced },
        pagination: { total, offset, limit, hasMore: offset > 0 },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "attachments" && req.method === "POST") {
    try {
      const session = getScopedSession();
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      const { files } = await readMultipartForm(req);
      if (!files.length) {
        jsonResponse(res, 400, { ok: false, error: "file required" });
        return true;
      }
      const safeSession = sanitizePathSegment(sessionId);
      const targetDir = deps.resolve(ATTACHMENTS_ROOT, "sessions", safeSession);
      deps.mkdirSync(targetDir, { recursive: true });
      const added = [];
      for (const file of files) {
        const originalName = file.filename || "attachment";
        const fileExt = extname(originalName).toLowerCase();
        const base = sanitizePathSegment(basename(originalName, fileExt)) || "attachment";
        const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
        const storedName = `${base}-${unique}${fileExt}`;
        const filePath = deps.resolve(targetDir, storedName);
        writeFileSync(filePath, file.data);
        const relPath = relative(ATTACHMENTS_ROOT, filePath);
        const contentType = file.contentType || MIME_TYPES[fileExt] || "application/octet-stream";
        const kind =
          contentType.startsWith("image/")
          || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(fileExt)
            ? "image"
            : "file";
        added.push({
          name: originalName,
          filePath,
          relativePath: relPath,
          url: resolveAttachmentUrl(relPath),
          size: file.data.length,
          contentType,
          kind,
          source: "upload",
          sourceType: "session",
          createdAt: new Date().toISOString(),
        });
      }
      jsonResponse(res, 200, { ok: true, attachments: added });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "stop" && req.method === "POST") {
    try {
      const session = getScopedSession();
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }

      const abortController = sessionRunAbortControllers.get(sessionId);
      const wasRunning = Boolean(abortController && !abortController.signal?.aborted);
      if (wasRunning) {
        try {
          abortController.abort("user_stop");
        } catch {
        }
        tracker.recordEvent(sessionId, {
          role: "system",
          type: "system",
          content: "Stop requested. Cancelling current agent turn...",
          timestamp: new Date().toISOString(),
        });
      }

      jsonResponse(res, 200, { ok: true, stopped: wasRunning });
      broadcastUiEvent(["sessions", "agents"], "invalidate", {
        reason: wasRunning ? "session-stop-requested" : "session-stop-noop",
        sessionId,
      });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "message" && req.method === "POST") {
    try {
      const session = getScopedSession();
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      if (session.status === "paused" || session.status === "archived") {
        jsonResponse(res, 400, { ok: false, error: `Session is ${session.status}` });
        return true;
      }
      if (session.status === "completed" || session.status === "failed") {
        tracker.updateSessionStatus(sessionId, "active");
      }
      const body = await readJsonBody(req);
      const content = body?.content ?? body?.message ?? body?.prompt;
      const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
      const attachmentsAppended = body?.attachmentsAppended === true;
      if (!content && attachments.length === 0) {
        jsonResponse(res, 400, { ok: false, error: "content is required" });
        return true;
      }
      const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const messageContent = typeof content === "string" ? content : "";
      const messageMode = body?.mode || undefined;
      const messageModel = body?.model || undefined;
      const messageAgentProfileId = toTrimmedString(
        body?.agentProfileId || session?.metadata?.agentProfileId || "",
      ) || undefined;
      let userMessageRecorded = false;
      const recordUserMessageOnce = () => {
        if (userMessageRecorded) return;
        tracker.recordEvent(sessionId, {
          role: "user",
          content: messageContent,
          attachments,
          timestamp: new Date().toISOString(),
          _sessionType: session.type === "primary" ? "primary" : undefined,
          _mode: messageMode || undefined,
        });
        userMessageRecorded = true;
      };

      const exec = session.type === "primary"
        ? await resolveInteractiveSessionExecutor(deps)
        : null;
      if (exec) {
        const sessionWorkspaceDir = resolveSessionWorkspaceDir(session);
        recordUserMessageOnce();
        jsonResponse(res, 200, { ok: true, messageId, sessionId });
        broadcastUiEvent(["sessions"], "invalidate", { reason: "session-message", sessionId });
        broadcastSessionsSnapshot();

        const streamOnEvent = (err, event) => {
          const ev = event || err;
          if (!ev) return;
          try {
            if (typeof ev === "string") {
              tracker.recordEvent(sessionId, {
                role: "system",
                type: "system",
                content: ev,
                timestamp: new Date().toISOString(),
              });
            } else {
              tracker.recordEvent(sessionId, ev);
            }
          } catch {
          }
        };

        const abortController = new AbortController();
        sessionRunAbortControllers.set(sessionId, abortController);
        exec(messageContent, {
          sessionId,
          sessionType: "primary",
          mode: messageMode,
          model: messageModel,
          agent: session?.metadata?.agent || undefined,
          providerSelection: session?.metadata?.agent || undefined,
          agentProfileId: messageAgentProfileId,
          cwd: sessionWorkspaceDir,
          persistent: true,
          skipUserMessageRecord: userMessageRecorded,
          sendRawEvents: true,
          attachments,
          attachmentsAppended,
          onEvent: streamOnEvent,
          abortController,
        }).then(() => {
          tracker.updateSessionStatus(sessionId, "completed");
          broadcastUiEvent(["sessions"], "invalidate", { reason: "agent-response", sessionId });
          broadcastSessionsSnapshot();
        }).catch((execErr) => {
          const wasAborted =
            abortController.signal.aborted
            || execErr?.name === "AbortError"
            || /abort|cancel|stop/i.test(String(execErr?.message || ""));
          if (wasAborted) {
            tracker.recordEvent(sessionId, {
              role: "system",
              type: "system",
              content: "Agent turn stopped.",
              timestamp: new Date().toISOString(),
            });
            tracker.updateSessionStatus(sessionId, "completed");
            broadcastUiEvent(["sessions"], "invalidate", {
              reason: "agent-stopped",
              sessionId,
            });
            broadcastSessionsSnapshot();
            return;
          }
          tracker.recordEvent(sessionId, {
            role: "system",
            type: "error",
            content: `Agent error: ${execErr.message || "Unknown error"}`,
            timestamp: new Date().toISOString(),
          });
          tracker.updateSessionStatus(sessionId, "failed");
          broadcastUiEvent(["sessions"], "invalidate", { reason: "agent-error", sessionId });
          broadcastSessionsSnapshot();
        }).finally(() => {
          if (sessionRunAbortControllers.get(sessionId) === abortController) {
            sessionRunAbortControllers.delete(sessionId);
          }
          broadcastUiEvent(["agents"], "invalidate", {
            reason: "session-turn-finished",
            sessionId,
          });
        });
      } else {
        recordUserMessageOnce();
        tracker.recordEvent(sessionId, {
          role: "system",
          type: "error",
          content: ":alert: No agent is available to process this message. The primary agent may not be initialized — try restarting bosun or check the Logs tab for details.",
          timestamp: new Date().toISOString(),
        });
        jsonResponse(res, 200, { ok: true, messageId, warning: "no_agent_available", sessionId });
        broadcastUiEvent(["sessions"], "invalidate", { reason: "session-message", sessionId });
        broadcastSessionsSnapshot();
      }
    } catch (err) {
      console.error("[ui-server] session message failed for %s: %s", String(sessionId), String(err?.message || err || "unknown"));
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "message/edit" && req.method === "POST") {
    try {
      const session = getScopedSession();
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      const body = await readJsonBody(req);
      const content = toTrimmedString(body?.content || "");
      if (!content) {
        jsonResponse(res, 400, { ok: false, error: "content is required" });
        return true;
      }

      const edited = tracker.editUserMessage(sessionId, {
        messageId: body?.messageId,
        timestamp: body?.timestamp,
        previousContent: body?.previousContent,
        content,
      });
      if (!edited?.ok) {
        const status = edited?.error === "Message not found" ? 404 : 400;
        jsonResponse(res, status, { ok: false, error: edited?.error || "edit failed" });
        return true;
      }

      jsonResponse(res, 200, { ok: true, message: edited.message });
      broadcastUiEvent(["sessions"], "invalidate", {
        reason: "session-message-edited",
        sessionId,
      });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "archive" && req.method === "POST") {
    try {
      const session = getScopedSessionRecord({ includeMessages: true });
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      tracker.updateSessionStatus(sessionId, "archived");
      mutateDurableSessionRecord(session, "archived");
      invalidateDurableSessionListCache();
      jsonResponse(res, 200, { ok: true });
      broadcastUiEvent(["sessions"], "invalidate", {
        reason: "session-archived",
        sessionId,
      });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "pause" && req.method === "POST") {
    try {
      const session = getScopedSession();
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      tracker.updateSessionStatus(sessionId, "paused");
      jsonResponse(res, 200, { ok: true });
      broadcastUiEvent(["sessions"], "invalidate", { reason: "session-paused", sessionId });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "resume" && req.method === "POST") {
    try {
      const session = getScopedSession();
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      tracker.updateSessionStatus(sessionId, "active");
      jsonResponse(res, 200, { ok: true });
      broadcastUiEvent(["sessions"], "invalidate", { reason: "session-resumed", sessionId });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "delete" && req.method === "POST") {
    try {
      const session = getScopedSession();
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      tracker.removeSession(sessionId);
      deleteSessionRecordFromStateLedger(sessionId, resolveUiStateLedgerOptions(workspaceContext));
      invalidateDurableSessionListCache();
      jsonResponse(res, 200, { ok: true });
      broadcastUiEvent(["sessions"], "invalidate", {
        reason: "session-deleted",
        sessionId,
      });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "rename" && req.method === "POST") {
    try {
      const session = getScopedSession();
      if (!session) {
        jsonResponse(res, 404, { ok: false, error: "Session not found" });
        return true;
      }
      const body = await readJsonBody(req);
      const title = toTrimmedString(body?.title || "");
      if (!title) {
        jsonResponse(res, 400, { ok: false, error: "title is required" });
        return true;
      }
      tracker.renameSession(sessionId, title);
      jsonResponse(res, 200, { ok: true });
      broadcastUiEvent(["sessions"], "invalidate", { reason: "session-renamed", sessionId });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (action === "diff" && req.method === "GET") {
    try {
      const session = getScopedSessionRecord({ includeMessages: true });
      if (!session) {
        jsonResponse(res, 200, {
          ok: true,
          diff: {
            files: [],
            totalFiles: 0,
            totalAdditions: 0,
            totalDeletions: 0,
            formatted: "(session not found)",
          },
          summary: "(session not found)",
          commits: [],
        });
        return true;
      }
      const worktreePath = await resolveSessionWorktreePath(session);
      if (!worktreePath || !existsSync(worktreePath)) {
        jsonResponse(res, 200, {
          ok: true,
          diff: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0, formatted: "(no worktree)" },
          summary: "(no worktree)",
          commits: [],
        });
        return true;
      }
      let stats = collectDiffStats(worktreePath, {
        range: "HEAD",
        includePatch: true,
      });
      if (Number(stats?.totalFiles || 0) === 0 && existsSync(deps.resolve(worktreePath, ".git"))) {
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 25));
        stats = collectDiffStats(worktreePath, {
          range: "HEAD",
          includePatch: true,
        });
      }
      const summary = stats.formatted || getCompactDiffSummary(worktreePath);
      const commits = getRecentCommits(worktreePath);
      jsonResponse(res, 200, {
        ok: true,
        diff: stats,
        summary,
        commits,
        source: {
          kind: "session",
          label: stats.sourceRange || "origin/main...HEAD",
          detail: worktreePath,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  jsonResponse(res, 404, { ok: false, error: "Session action not found" });
  return true;
}
