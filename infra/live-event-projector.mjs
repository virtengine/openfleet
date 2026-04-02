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

export class LiveEventProjector {
  constructor(options = {}) {
    this._recentLimit = Math.max(10, Math.trunc(Number(options.recentLimit) || 100));
    this._recentEvents = [];
    this._sessions = new Map();
    this._runs = new Map();
    this._providers = new Map();
    this._tools = new Map();
    this._approvals = new Map();
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
        lastEventType: null,
        lastToolName: null,
        lastApprovalId: null,
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
      };
      runEntry.updatedAt = timestamp;
      runEntry.status = asText(event.status) || runEntry.status;
      runEntry.threadId = asText(event.threadId) || runEntry.threadId;
      runEntry.sessionId = asText(event.sessionId) || runEntry.sessionId;
      runEntry.totalEvents += 1;
      if (asText(event.toolName || event.toolId)) runEntry.toolCalls += 1;
      if (asText(event.approvalId)) runEntry.approvalCount += 1;
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
  }

  getSnapshot() {
    return {
      sessions: Array.from(this._sessions.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      runs: Array.from(this._runs.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      providers: Array.from(this._providers.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      tools: Array.from(this._tools.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      approvals: Array.from(this._approvals.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
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
  }
}

