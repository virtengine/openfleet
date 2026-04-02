function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function uniquePush(list, value, limit = 20) {
  const normalized = asText(value);
  if (!normalized) return;
  if (!list.includes(normalized)) {
    list.push(normalized);
  }
  while (list.length > limit) list.shift();
}

function normalizeTimestamp(value) {
  const text = asText(value);
  if (text) return text;
  return new Date().toISOString();
}

function pushBounded(list, value, limit) {
  list.push(value);
  while (list.length > limit) list.shift();
}

function sortByUpdatedAtDescending(left, right) {
  const leftTime = Date.parse(String(left?.updatedAt || left?.timestamp || 0));
  const rightTime = Date.parse(String(right?.updatedAt || right?.timestamp || 0));
  return rightTime - leftTime;
}

function pickIdentity(event = {}) {
  return asText(event.sessionId || event.threadId || event.taskId);
}

function hasArtifactIdentity(event = {}) {
  return Boolean(
    asText(event.artifactId)
    || asText(event.artifactPath)
    || asText(event.filePath)
    || asText(event.patchHash),
  );
}

function hasSubagentIdentity(event = {}) {
  return Boolean(
    asText(event.subagentId)
    || asText(event.childSessionId)
    || asText(event.childTaskId)
    || asText(event.childRunId),
  );
}

export class LiveEventProjector {
  constructor(options = {}) {
    this._recentLimit = Math.max(10, Math.trunc(Number(options.recentLimit) || 100));
    this._recentEvents = [];
    this._sessions = new Map();
    this._runs = new Map();
    this._providers = new Map();
    this._tools = new Map();
    this._approvals = new Map();
    this._artifacts = new Map();
    this._subagents = new Map();
  }

  record(event = {}) {
    const timestamp = normalizeTimestamp(event.timestamp);
    pushBounded(this._recentEvents, {
      id: asText(event.id),
      timestamp,
      eventType: asText(event.eventType || event.type) || "event",
      category: asText(event.category) || "runtime",
      source: asText(event.source) || "unknown",
      sessionId: asText(event.sessionId),
      runId: asText(event.runId),
      taskId: asText(event.taskId),
      providerId: asText(event.providerId),
      toolName: asText(event.toolName || event.toolId),
      approvalId: asText(event.approvalId),
      filePath: asText(event.filePath || event.artifactPath),
      patchHash: asText(event.patchHash),
      childSessionId: asText(event.childSessionId),
      childTaskId: asText(event.childTaskId),
      childRunId: asText(event.childRunId),
      subagentId: asText(event.subagentId),
      surface: asText(event.surface || event.channel),
      action: asText(event.action || event.commandName),
      status: asText(event.status),
      summary: asText(event.summary || event.reason || event.message),
    }, this._recentLimit);

    const sessionKey = pickIdentity(event);
    if (sessionKey) {
      const sessionEntry = this._sessions.get(sessionKey) || {
        id: sessionKey,
        sessionId: asText(event.sessionId) || sessionKey,
        taskId: asText(event.taskId),
        threadId: asText(event.threadId),
        runId: asText(event.runId),
        rootRunId: asText(event.rootRunId),
        workflowId: asText(event.workflowId),
        workflowName: asText(event.workflowName),
        providerId: asText(event.providerId),
        modelId: asText(event.modelId),
        status: null,
        updatedAt: timestamp,
        totalEvents: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalRetries: 0,
        artifactMutations: 0,
        subagentEvents: 0,
        lastEventType: null,
        lastToolName: null,
        lastApprovalId: null,
        lastArtifactPath: null,
        childSessionIds: [],
        childTaskIds: [],
        childRunIds: [],
      };
      sessionEntry.updatedAt = timestamp;
      sessionEntry.status = asText(event.status) || sessionEntry.status;
      sessionEntry.providerId = asText(event.providerId) || sessionEntry.providerId;
      sessionEntry.modelId = asText(event.modelId) || sessionEntry.modelId;
      sessionEntry.lastEventType = asText(event.eventType || event.type) || sessionEntry.lastEventType;
      sessionEntry.lastToolName = asText(event.toolName || event.toolId) || sessionEntry.lastToolName;
      sessionEntry.lastApprovalId = asText(event.approvalId) || sessionEntry.lastApprovalId;
      sessionEntry.totalEvents += 1;
      sessionEntry.totalTokens += Number(event.tokenUsage?.totalTokens || 0);
      sessionEntry.totalCostUsd += Number(event.costUsd || 0);
      sessionEntry.totalRetries += Number(event.retryCount || 0);
      if (hasArtifactIdentity(event)) {
        sessionEntry.artifactMutations += 1;
        sessionEntry.lastArtifactPath = asText(event.filePath || event.artifactPath) || sessionEntry.lastArtifactPath;
      }
      if (hasSubagentIdentity(event)) {
        sessionEntry.subagentEvents += 1;
        uniquePush(sessionEntry.childSessionIds, event.childSessionId);
        uniquePush(sessionEntry.childTaskIds, event.childTaskId);
        uniquePush(sessionEntry.childRunIds, event.childRunId);
      }
      this._sessions.set(sessionKey, sessionEntry);
    }

    const runKey = asText(event.runId || event.rootRunId || event.childRunId);
    if (runKey) {
      const runEntry = this._runs.get(runKey) || {
        runId: runKey,
        rootRunId: asText(event.rootRunId) || runKey,
        parentRunId: asText(event.parentRunId),
        threadId: asText(event.threadId),
        sessionId: asText(event.sessionId),
        workflowId: asText(event.workflowId),
        workflowName: asText(event.workflowName),
        status: null,
        updatedAt: timestamp,
        totalEvents: 0,
        toolCalls: 0,
        approvalCount: 0,
        artifactMutations: 0,
        subagentEvents: 0,
        childSessionIds: [],
        childTaskIds: [],
        childRunIds: [],
      };
      runEntry.updatedAt = timestamp;
      runEntry.status = asText(event.status) || runEntry.status;
      runEntry.threadId = asText(event.threadId) || runEntry.threadId;
      runEntry.sessionId = asText(event.sessionId) || runEntry.sessionId;
      runEntry.totalEvents += 1;
      if (asText(event.toolName || event.toolId)) runEntry.toolCalls += 1;
      if (asText(event.approvalId)) runEntry.approvalCount += 1;
      if (hasArtifactIdentity(event)) {
        runEntry.artifactMutations += 1;
      }
      if (hasSubagentIdentity(event)) {
        runEntry.subagentEvents += 1;
        uniquePush(runEntry.childSessionIds, event.childSessionId);
        uniquePush(runEntry.childTaskIds, event.childTaskId);
        uniquePush(runEntry.childRunIds, event.childRunId);
      }
      this._runs.set(runKey, runEntry);
    }

    const providerKey = asText(event.providerId || event.modelId);
    if (providerKey) {
      const providerEntry = this._providers.get(providerKey) || {
        key: providerKey,
        providerId: asText(event.providerId),
        modelId: asText(event.modelId),
        updatedAt: timestamp,
        totalEvents: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalLatencyMs: 0,
      };
      providerEntry.updatedAt = timestamp;
      providerEntry.totalEvents += 1;
      providerEntry.totalTokens += Number(event.tokenUsage?.totalTokens || 0);
      providerEntry.totalCostUsd += Number(event.costUsd || 0);
      providerEntry.totalLatencyMs += Number(event.latencyMs || event.durationMs || 0);
      this._providers.set(providerKey, providerEntry);
    }

    const toolKey = asText(event.toolId || event.toolName);
    if (toolKey) {
      const toolEntry = this._tools.get(toolKey) || {
        key: toolKey,
        toolId: asText(event.toolId),
        toolName: asText(event.toolName || event.toolId),
        updatedAt: timestamp,
        totalCalls: 0,
        totalLatencyMs: 0,
        totalRetries: 0,
      };
      toolEntry.updatedAt = timestamp;
      toolEntry.totalCalls += 1;
      toolEntry.totalLatencyMs += Number(event.latencyMs || event.durationMs || 0);
      toolEntry.totalRetries += Number(event.retryCount || 0);
      this._tools.set(toolKey, toolEntry);
    }

    const approvalKey = asText(event.approvalId);
    if (approvalKey) {
      const approvalEntry = this._approvals.get(approvalKey) || {
        approvalId: approvalKey,
        sessionId: asText(event.sessionId),
        runId: asText(event.runId),
        taskId: asText(event.taskId),
        status: null,
        updatedAt: timestamp,
        decisions: 0,
      };
      approvalEntry.updatedAt = timestamp;
      approvalEntry.status = asText(event.status) || approvalEntry.status;
      approvalEntry.decisions += 1;
      this._approvals.set(approvalKey, approvalEntry);
    }

    const artifactKey = asText(event.artifactId || event.filePath || event.artifactPath || event.patchHash);
    if (artifactKey) {
      const artifactEntry = this._artifacts.get(artifactKey) || {
        key: artifactKey,
        artifactId: asText(event.artifactId),
        artifactPath: asText(event.artifactPath),
        patchHash: asText(event.patchHash),
        filePath: asText(event.filePath || event.artifactPath),
        taskId: asText(event.taskId),
        sessionId: asText(event.sessionId),
        runId: asText(event.runId),
        workflowId: asText(event.workflowId),
        updatedAt: timestamp,
        totalEvents: 0,
        lastEventType: null,
        status: null,
      };
      artifactEntry.updatedAt = timestamp;
      artifactEntry.totalEvents += 1;
      artifactEntry.lastEventType = asText(event.eventType || event.type) || artifactEntry.lastEventType;
      artifactEntry.status = asText(event.status) || artifactEntry.status;
      artifactEntry.artifactId = asText(event.artifactId) || artifactEntry.artifactId;
      artifactEntry.artifactPath = asText(event.artifactPath) || artifactEntry.artifactPath;
      artifactEntry.filePath = asText(event.filePath || event.artifactPath) || artifactEntry.filePath;
      artifactEntry.patchHash = asText(event.patchHash) || artifactEntry.patchHash;
      this._artifacts.set(artifactKey, artifactEntry);
    }

    const subagentKey = asText(event.subagentId || event.childSessionId || event.childTaskId || event.childRunId);
    if (subagentKey) {
      const subagentEntry = this._subagents.get(subagentKey) || {
        key: subagentKey,
        subagentId: asText(event.subagentId),
        childSessionId: asText(event.childSessionId),
        childTaskId: asText(event.childTaskId),
        childRunId: asText(event.childRunId),
        parentSessionId: asText(event.parentSessionId || event.sessionId),
        parentTaskId: asText(event.parentTaskId || event.taskId),
        runId: asText(event.runId),
        workflowId: asText(event.workflowId),
        updatedAt: timestamp,
        totalEvents: 0,
        lastEventType: null,
        status: null,
      };
      subagentEntry.updatedAt = timestamp;
      subagentEntry.totalEvents += 1;
      subagentEntry.lastEventType = asText(event.eventType || event.type) || subagentEntry.lastEventType;
      subagentEntry.status = asText(event.status) || subagentEntry.status;
      subagentEntry.subagentId = asText(event.subagentId) || subagentEntry.subagentId;
      subagentEntry.childSessionId = asText(event.childSessionId) || subagentEntry.childSessionId;
      subagentEntry.childTaskId = asText(event.childTaskId) || subagentEntry.childTaskId;
      subagentEntry.childRunId = asText(event.childRunId) || subagentEntry.childRunId;
      subagentEntry.parentSessionId = asText(event.parentSessionId || event.sessionId) || subagentEntry.parentSessionId;
      subagentEntry.parentTaskId = asText(event.parentTaskId || event.taskId) || subagentEntry.parentTaskId;
      this._subagents.set(subagentKey, subagentEntry);
    }
  }

  getSnapshot() {
    return {
      sessions: Array.from(this._sessions.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      runs: Array.from(this._runs.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      providers: Array.from(this._providers.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      tools: Array.from(this._tools.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      approvals: Array.from(this._approvals.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      artifacts: Array.from(this._artifacts.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      subagents: Array.from(this._subagents.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      recentEvents: this._recentEvents.map(cloneValue),
    };
  }

  reset() {
    this._recentEvents = [];
    this._sessions.clear();
    this._runs.clear();
    this._providers.clear();
    this._tools.clear();
    this._approvals.clear();
    this._artifacts.clear();
    this._subagents.clear();
  }
}
