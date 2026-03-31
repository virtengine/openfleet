import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WorkflowExecutionLedger } from "./execution-ledger.mjs";

const APPROVAL_QUEUE_RELATIVE_PATH = [".bosun", "approvals", "requests.json"];
const WORKFLOW_RUNS_RELATIVE_PATH = [".bosun", "workflow-runs"];
const APPROVAL_SCOPE_TYPES = new Set(["workflow-run", "workflow-gate", "workflow-action", "harness-run"]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeTimestamp(value) {
  return normalizeText(value) || new Date().toISOString();
}

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return cloneJson(fallback);
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return cloneJson(fallback);
  }
}

function writeJsonFile(filePath, value) {
  ensureParentDir(filePath);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveWorkflowRunsDir(repoRoot) {
  return resolve(String(repoRoot || process.cwd()), ...WORKFLOW_RUNS_RELATIVE_PATH);
}

function resolveRunDetailPath(repoRoot, runId) {
  return resolve(resolveWorkflowRunsDir(repoRoot), `${runId}.json`);
}

function resolveRunIndexPath(repoRoot) {
  return resolve(resolveWorkflowRunsDir(repoRoot), "index.json");
}

export function resolveApprovalQueuePath(repoRoot) {
  return resolve(String(repoRoot || process.cwd()), ...APPROVAL_QUEUE_RELATIVE_PATH);
}

function readApprovalQueue(repoRoot) {
  const filePath = resolveApprovalQueuePath(repoRoot);
  const data = readJsonFile(filePath, { version: 1, requests: [] });
  return {
    path: filePath,
    data: {
      version: Number(data?.version || 1) || 1,
      requests: Array.isArray(data?.requests) ? data.requests : [],
    },
  };
}

function writeApprovalQueue(repoRoot, requests) {
  const filePath = resolveApprovalQueuePath(repoRoot);
  writeJsonFile(filePath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    requests,
  });
  return filePath;
}

function normalizeApprovalRequestStatus(value, fallback = "pending") {
  const normalized = normalizeText(value).toLowerCase();
  if (["pending", "approved", "denied", "expired"].includes(normalized)) return normalized;
  return fallback;
}

function normalizeApprovalScopeType(value, fallback = "workflow-run") {
  const normalized = normalizeText(value).toLowerCase();
  return APPROVAL_SCOPE_TYPES.has(normalized) ? normalized : fallback;
}

function buildApprovalRequestBase(request = {}, existing = null, scopeTypeFallback = "workflow-run") {
  const scopeType = normalizeApprovalScopeType(request?.scopeType || existing?.scopeType, scopeTypeFallback);
  const scopeId = normalizeText(request?.scopeId || existing?.scopeId);
  if (!scopeId) return null;
  const requestedAt = normalizeTimestamp(
    existing?.requestedAt || request?.requestedAt || request?.updatedAt || request?.startedAt,
  );
  const now = new Date().toISOString();
  const requestId = normalizeText(existing?.requestId || request?.requestId || `${scopeType}:${scopeId}`);
  return {
    requestId,
    scopeType,
    scopeId,
    status: "pending",
    requestedAt,
    updatedAt: now,
    reason: normalizeText(request?.reason || existing?.reason) || null,
    runId: normalizeText(request?.runId || existing?.runId) || null,
    rootRunId: normalizeText(request?.rootRunId || existing?.rootRunId) || null,
    parentRunId: normalizeText(request?.parentRunId || existing?.parentRunId) || null,
    workflowId: normalizeText(request?.workflowId || existing?.workflowId) || null,
    workflowName: normalizeText(request?.workflowName || existing?.workflowName) || null,
    taskId: normalizeText(request?.taskId || existing?.taskId) || null,
    taskTitle: normalizeText(request?.taskTitle || existing?.taskTitle) || null,
    history: Array.isArray(existing?.history) ? existing.history : [],
    resolution: null,
  };
}

export function isWorkflowRunApprovalPending(run = {}) {
  const executionPolicy =
    run?.executionPolicy && typeof run.executionPolicy === "object"
      ? run.executionPolicy
      : (run?.detail?.executionPolicy && typeof run.detail.executionPolicy === "object"
          ? run.detail.executionPolicy
          : (run?.detail?.data?._executionPolicy && typeof run.detail.data._executionPolicy === "object"
              ? run.detail.data._executionPolicy
              : (run?.detail?.data?.executionPolicy && typeof run.detail.data.executionPolicy === "object"
                  ? run.detail.data.executionPolicy
                  : null)));
  return executionPolicy?.approvalRequired === true
    && normalizeApprovalRequestStatus(executionPolicy?.approvalState, "pending") === "pending";
}

function buildWorkflowRunApprovalReason(run = {}) {
  const executionPolicy =
    run?.executionPolicy && typeof run.executionPolicy === "object"
      ? run.executionPolicy
      : (run?.detail?.executionPolicy && typeof run.detail.executionPolicy === "object"
          ? run.detail.executionPolicy
          : (run?.detail?.data?._executionPolicy && typeof run.detail.data._executionPolicy === "object"
              ? run.detail.data._executionPolicy
              : null));
  const policyOutcome =
    run?.policyOutcome && typeof run.policyOutcome === "object"
      ? run.policyOutcome
      : (run?.detail?.policyOutcome && typeof run.detail.policyOutcome === "object"
          ? run.detail.policyOutcome
          : null);
  const mode = normalizeText(executionPolicy?.mode).replaceAll("_", " ");
  const violationCount = Number(policyOutcome?.violationCount || 0);
  if (mode && violationCount > 0) {
    return `Execution policy ${mode} requires approval with ${violationCount} violation(s).`;
  }
  if (mode) {
    return `Execution policy ${mode} requires operator approval before continuation.`;
  }
  return "Workflow run is blocked pending operator approval.";
}

function normalizeWorkflowRunApprovalRequest(run = {}, existing = null) {
  const runId = normalizeText(run?.runId || existing?.scopeId);
  const base = buildApprovalRequestBase({
    scopeType: "workflow-run",
    scopeId: runId,
    requestId: runId ? `workflow-run:${runId}` : existing?.requestId,
    requestedAt: run?.updatedAt || run?.startedAt || run?.detail?.updatedAt,
    runId,
    workflowId: run?.workflowId,
    workflowName: run?.workflowName,
    taskId: run?.taskId || run?.detail?.data?.taskId,
    taskTitle: run?.taskTitle,
    reason: buildWorkflowRunApprovalReason(run),
  }, existing, "workflow-run");
  if (!base) return null;
  return {
    ...base,
    primaryGoalId: normalizeText(run?.primaryGoalId || existing?.primaryGoalId) || null,
    primaryGoalTitle: normalizeText(run?.primaryGoalTitle || existing?.primaryGoalTitle) || null,
    governance: {
      executionPolicy: cloneJson(run?.executionPolicy || run?.detail?.executionPolicy || run?.detail?.data?._executionPolicy || null),
      policyOutcome: cloneJson(run?.policyOutcome || run?.detail?.policyOutcome || null),
    },
  };
}

export function buildWorkflowGateScopeId(runId, nodeId) {
  const normalizedRunId = normalizeText(runId);
  const normalizedNodeId = normalizeText(nodeId);
  if (!normalizedRunId || !normalizedNodeId) return "";
  return `${normalizedRunId}:${normalizedNodeId}`;
}

export function buildWorkflowActionScopeId(runId, nodeId) {
  const normalizedRunId = normalizeText(runId);
  const normalizedNodeId = normalizeText(nodeId);
  if (!normalizedRunId || !normalizedNodeId) return "";
  return `${normalizedRunId}:${normalizedNodeId}`;
}

function normalizeWorkflowGateApprovalRequest(request = {}, existing = null) {
  const runId = normalizeText(request?.runId || existing?.runId);
  const nodeId = normalizeText(request?.nodeId || existing?.nodeId);
  const scopeId = buildWorkflowGateScopeId(runId, nodeId) || normalizeText(existing?.scopeId);
  const base = buildApprovalRequestBase({
    ...request,
    scopeType: "workflow-gate",
    scopeId,
    requestId: scopeId ? `workflow-gate:${scopeId}` : existing?.requestId,
    runId,
    reason: request?.reason || existing?.reason || "Workflow gate is waiting for operator approval.",
  }, existing, "workflow-gate");
  if (!base) return null;
  const timeoutMs = Number.isFinite(Number(request?.timeoutMs ?? existing?.gate?.timeoutMs))
    ? Math.max(0, Math.trunc(Number(request?.timeoutMs ?? existing?.gate?.timeoutMs)))
    : null;
  const requestedAtMs = Date.parse(base.requestedAt);
  const expiresAt = timeoutMs != null && Number.isFinite(requestedAtMs)
    ? new Date(requestedAtMs + timeoutMs).toISOString()
    : (normalizeText(request?.expiresAt || existing?.expiresAt) || null);
  return {
    ...base,
    nodeId,
    nodeLabel: normalizeText(request?.nodeLabel || existing?.nodeLabel) || null,
    requestedBy: normalizeText(request?.requestedBy || existing?.requestedBy) || "workflow",
    expiresAt,
    gate: cleanGateConfig({
      timeoutMs,
      onTimeout: request?.onTimeout ?? existing?.gate?.onTimeout,
      pollIntervalMs: request?.pollIntervalMs ?? existing?.gate?.pollIntervalMs,
      mode: request?.mode ?? existing?.gate?.mode ?? "manual",
    }),
  };
}

function normalizeWorkflowActionApprovalRequest(request = {}, existing = null) {
  const runId = normalizeText(request?.runId || existing?.runId);
  const nodeId = normalizeText(request?.nodeId || existing?.nodeId);
  const scopeId = buildWorkflowActionScopeId(runId, nodeId) || normalizeText(existing?.scopeId);
  const base = buildApprovalRequestBase({
    ...request,
    scopeType: "workflow-action",
    scopeId,
    requestId: scopeId ? `workflow-action:${scopeId}` : existing?.requestId,
    runId,
    reason: request?.reason || existing?.reason || "Workflow action is waiting for operator approval.",
  }, existing, "workflow-action");
  if (!base) return null;
  const timeoutMs = Number.isFinite(Number(request?.timeoutMs ?? existing?.action?.timeoutMs))
    ? Math.max(0, Math.trunc(Number(request?.timeoutMs ?? existing?.action?.timeoutMs)))
    : null;
  const pollIntervalMs = Number.isFinite(Number(request?.pollIntervalMs ?? existing?.action?.pollIntervalMs))
    ? Math.max(1, Math.trunc(Number(request?.pollIntervalMs ?? existing?.action?.pollIntervalMs)))
    : null;
  const requestedAtMs = Date.parse(base.requestedAt);
  const expiresAt = timeoutMs != null && Number.isFinite(requestedAtMs)
    ? new Date(requestedAtMs + timeoutMs).toISOString()
    : (normalizeText(request?.expiresAt || existing?.expiresAt) || null);
  return {
    ...base,
    nodeId,
    nodeLabel: normalizeText(request?.nodeLabel || existing?.nodeLabel) || null,
    nodeType: normalizeText(request?.nodeType || existing?.nodeType) || null,
    requestedBy: normalizeText(request?.requestedBy || existing?.requestedBy) || "workflow",
    expiresAt,
    action: {
      timeoutMs,
      onTimeout: normalizeText(request?.onTimeout || existing?.action?.onTimeout) || "fail",
      pollIntervalMs,
      key: normalizeText(request?.actionKey || existing?.action?.key) || null,
      label: normalizeText(request?.actionLabel || existing?.action?.label) || null,
      preview: normalizeText(request?.preview || existing?.action?.preview) || null,
    },
  };
}

function normalizeHarnessRunApprovalRequest(request = {}, existing = null) {
  const runId = normalizeText(request?.runId || existing?.scopeId);
  const base = buildApprovalRequestBase({
    ...request,
    scopeType: "harness-run",
    scopeId: runId,
    requestId: runId ? `harness-run:${runId}` : existing?.requestId,
    requestedAt: request?.requestedAt || request?.updatedAt || existing?.requestedAt,
    runId,
    taskId: request?.taskId || existing?.taskId,
    taskTitle: request?.taskTitle || existing?.taskTitle,
    reason: request?.reason || existing?.reason || "Harness run is waiting for operator approval.",
  }, existing, "harness-run");
  if (!base) return null;
  const timeoutMs = Number.isFinite(Number(request?.timeoutMs ?? existing?.approval?.timeoutMs))
    ? Math.max(0, Math.trunc(Number(request?.timeoutMs ?? existing?.approval?.timeoutMs)))
    : null;
  const requestedAtMs = Date.parse(base.requestedAt);
  const expiresAt = timeoutMs != null && Number.isFinite(requestedAtMs)
    ? new Date(requestedAtMs + timeoutMs).toISOString()
    : (normalizeText(request?.expiresAt || existing?.expiresAt) || null);
  return {
    ...base,
    stageId: normalizeText(request?.stageId || existing?.stageId) || null,
    stageType: normalizeText(request?.stageType || existing?.stageType) || null,
    agentId: normalizeText(request?.agentId || existing?.agentId) || null,
    artifactId: normalizeText(request?.artifactId || existing?.artifactId) || null,
    sourceOrigin: normalizeText(request?.sourceOrigin || existing?.sourceOrigin) || null,
    sourcePath: normalizeText(request?.sourcePath || existing?.sourcePath) || null,
    requestedBy: normalizeText(request?.requestedBy || existing?.requestedBy) || "harness",
    preview: normalizeText(request?.preview || existing?.preview) || null,
    expiresAt,
    approval: {
      timeoutMs,
      mode: normalizeText(request?.mode || existing?.approval?.mode) || "manual",
      note: normalizeText(request?.approvalNote || existing?.approval?.note) || null,
    },
  };
}

function cleanGateConfig(config = {}) {
  const timeoutMs = Number.isFinite(Number(config?.timeoutMs))
    ? Math.max(0, Math.trunc(Number(config.timeoutMs)))
    : null;
  const pollIntervalMs = Number.isFinite(Number(config?.pollIntervalMs))
    ? Math.max(1, Math.trunc(Number(config.pollIntervalMs)))
    : null;
  return {
    timeoutMs,
    onTimeout: normalizeText(config?.onTimeout) || null,
    pollIntervalMs,
    mode: normalizeText(config?.mode) || "manual",
  };
}

function recordWorkflowGateLedgerEvent(repoRoot, request, resolution = null) {
  const runId = normalizeText(request?.runId || request?.scopeId?.split?.(":")?.[0]);
  if (!runId) return null;
  const decision = normalizeApprovalRequestStatus(resolution?.decision, "");
  const ledger = new WorkflowExecutionLedger({ runsDir: resolveWorkflowRunsDir(repoRoot) });
  ledger.ensureRun({
    runId,
    workflowId: request.workflowId || null,
    workflowName: request.workflowName || null,
    rootRunId: request.rootRunId || null,
    parentRunId: request.parentRunId || null,
    updatedAt: normalizeTimestamp(resolution?.resolvedAt || request.updatedAt || request.requestedAt),
  });
  const status = decision === "approved"
    ? "completed"
    : (decision === "denied" ? "blocked" : (decision === "expired" ? "expired" : "waiting"));
  const eventType = decision
    ? (decision === "expired" ? "approval.expired" : "approval.resolved")
    : "approval.requested";
  const summary = decision === "approved"
    ? "Workflow gate approval granted by operator."
    : (decision === "denied"
        ? "Workflow gate approval denied by operator."
        : (decision === "expired"
            ? "Workflow gate approval request expired before a decision was made."
            : "Workflow gate is waiting for operator approval."));
  ledger.appendEvent({
    runId,
    workflowId: request.workflowId || null,
    workflowName: request.workflowName || null,
    eventType,
    status,
    summary,
    timestamp: normalizeTimestamp(resolution?.resolvedAt || request.updatedAt || request.requestedAt),
    meta: {
      requestId: request.requestId,
      scopeType: request.scopeType,
      scopeId: request.scopeId,
      nodeId: request.nodeId || null,
      nodeLabel: request.nodeLabel || null,
      actorId: resolution?.actorId || null,
      note: resolution?.note || null,
      decision: decision || null,
      taskId: request.taskId || null,
      taskTitle: request.taskTitle || null,
      reason: request.reason || null,
    },
  });
  return { runId, decision: decision || null };
}

function recordWorkflowActionLedgerEvent(repoRoot, request, resolution = null) {
  const runId = normalizeText(request?.runId || request?.scopeId?.split?.(":")?.[0]);
  if (!runId) return null;
  const decision = normalizeApprovalRequestStatus(resolution?.decision, "");
  const ledger = new WorkflowExecutionLedger({ runsDir: resolveWorkflowRunsDir(repoRoot) });
  ledger.ensureRun({
    runId,
    workflowId: request.workflowId || null,
    workflowName: request.workflowName || null,
    rootRunId: request.rootRunId || null,
    parentRunId: request.parentRunId || null,
    updatedAt: normalizeTimestamp(resolution?.resolvedAt || request.updatedAt || request.requestedAt),
  });
  const status = decision === "approved"
    ? "completed"
    : (decision === "denied" ? "blocked" : (decision === "expired" ? "expired" : "waiting"));
  const eventType = decision
    ? (decision === "expired" ? "approval.expired" : "approval.resolved")
    : "approval.requested";
  const summary = decision === "approved"
    ? "Workflow action approval granted by operator."
    : (decision === "denied"
        ? "Workflow action approval denied by operator."
        : (decision === "expired"
            ? "Workflow action approval request expired before a decision was made."
            : "Workflow action is waiting for operator approval."));
  ledger.appendEvent({
    runId,
    workflowId: request.workflowId || null,
    workflowName: request.workflowName || null,
    eventType,
    status,
    summary,
    timestamp: normalizeTimestamp(resolution?.resolvedAt || request.updatedAt || request.requestedAt),
    meta: {
      requestId: request.requestId,
      scopeType: request.scopeType,
      scopeId: request.scopeId,
      nodeId: request.nodeId || null,
      nodeLabel: request.nodeLabel || null,
      nodeType: request.nodeType || null,
      actorId: resolution?.actorId || null,
      note: resolution?.note || null,
      decision: decision || null,
      taskId: request.taskId || null,
      taskTitle: request.taskTitle || null,
      reason: request.reason || null,
      actionKey: request?.action?.key || null,
      actionLabel: request?.action?.label || null,
      preview: request?.action?.preview || null,
    },
  });
  return { runId, decision: decision || null };
}

function normalizeApprovalRequest(request = {}, existing = null) {
  const scopeType = normalizeApprovalScopeType(request?.scopeType || existing?.scopeType, "workflow-run");
  if (scopeType === "workflow-run") return normalizeWorkflowRunApprovalRequest(request, existing);
  if (scopeType === "workflow-gate") return normalizeWorkflowGateApprovalRequest(request, existing);
  if (scopeType === "workflow-action") return normalizeWorkflowActionApprovalRequest(request, existing);
  if (scopeType === "harness-run") return normalizeHarnessRunApprovalRequest(request, existing);
  return null;
}

function getApprovalRequestIndex(requests, scopeType, scopeId) {
  const normalizedScopeType = normalizeApprovalScopeType(scopeType, "");
  const normalizedScopeId = normalizeText(scopeId);
  return requests.findIndex(
    (entry) =>
      normalizeApprovalScopeType(entry?.scopeType, "") === normalizedScopeType
      && normalizeText(entry?.scopeId) === normalizedScopeId,
  );
}

export function getApprovalRequest(scopeType, scopeId, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  const queue = readApprovalQueue(repoRoot);
  const requests = Array.isArray(queue.data.requests) ? queue.data.requests : [];
  const index = getApprovalRequestIndex(requests, scopeType, scopeId);
  return index >= 0 ? cloneJson(requests[index]) : null;
}

export function getApprovalRequestById(requestId, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  const queue = readApprovalQueue(repoRoot);
  const normalizedRequestId = normalizeText(requestId);
  const request = (queue.data.requests || []).find(
    (entry) => normalizeText(entry?.requestId) === normalizedRequestId,
  ) || null;
  return request ? cloneJson(request) : null;
}

export function upsertApprovalRequest(request = {}, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  const queue = readApprovalQueue(repoRoot);
  const requests = Array.isArray(queue.data.requests) ? queue.data.requests.slice() : [];
  const existingIndex = getApprovalRequestIndex(requests, request?.scopeType, request?.scopeId);
  const existing = existingIndex >= 0 ? requests[existingIndex] : null;
  const next = normalizeApprovalRequest(request, existing);
  if (!next) return { ok: false, request: null, path: queue.path };
  if (existingIndex >= 0) requests[existingIndex] = next;
  else requests.push(next);
  writeApprovalQueue(repoRoot, requests);
  const created = existingIndex < 0;
  const reopened = existing && normalizeApprovalRequestStatus(existing?.status, "pending") !== "pending";
  if (next.scopeType === "workflow-gate" && (created || reopened)) {
    recordWorkflowGateLedgerEvent(repoRoot, next);
  }
  if (next.scopeType === "workflow-action" && (created || reopened)) {
    recordWorkflowActionLedgerEvent(repoRoot, next);
  }
  return { ok: true, request: next, path: queue.path, created, reopened };
}

export function upsertWorkflowRunApprovalRequest(run = {}, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  if (!isWorkflowRunApprovalPending(run)) return { ok: false, request: null, path: resolveApprovalQueuePath(repoRoot) };
  return upsertApprovalRequest({
    scopeType: "workflow-run",
    ...run,
    scopeId: run?.runId,
  }, { repoRoot });
}

export function getWorkflowRunApprovalRequest(runId, options = {}) {
  return getApprovalRequest("workflow-run", runId, options);
}

export function upsertWorkflowGateApprovalRequest(request = {}, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  return upsertApprovalRequest({
    ...request,
    scopeType: "workflow-gate",
    scopeId: buildWorkflowGateScopeId(request?.runId, request?.nodeId),
  }, { repoRoot });
}

export function upsertWorkflowActionApprovalRequest(request = {}, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  return upsertApprovalRequest({
    ...request,
    scopeType: "workflow-action",
    scopeId: buildWorkflowActionScopeId(request?.runId, request?.nodeId),
  }, { repoRoot });
}

export function upsertHarnessRunApprovalRequest(request = {}, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  return upsertApprovalRequest({
    ...request,
    scopeType: "harness-run",
    scopeId: request?.runId,
  }, { repoRoot });
}

export function getHarnessRunApprovalRequest(runId, options = {}) {
  return getApprovalRequest("harness-run", runId, options);
}

export function listApprovalRequests(options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  const queue = readApprovalQueue(repoRoot);
  const status = normalizeText(options.status).toLowerCase();
  const scopeType = normalizeText(options.scopeType).toLowerCase();
  const includeResolved = options.includeResolved === true;
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(500, Math.trunc(Number(options.limit)))) : 100;
  let requests = Array.isArray(queue.data.requests) ? queue.data.requests.slice() : [];
  if (scopeType) {
    requests = requests.filter((entry) => normalizeText(entry?.scopeType).toLowerCase() === scopeType);
  }
  if (status) {
    requests = requests.filter((entry) => normalizeApprovalRequestStatus(entry?.status, "") === status);
  } else if (!includeResolved) {
    requests = requests.filter((entry) => normalizeApprovalRequestStatus(entry?.status, "pending") === "pending");
  }
  requests.sort((left, right) =>
    normalizeTimestamp(right?.updatedAt || right?.requestedAt).localeCompare(
      normalizeTimestamp(left?.updatedAt || left?.requestedAt),
    ));
  return {
    ok: true,
    path: queue.path,
    requests: requests.slice(0, limit).map((entry) => cloneJson(entry)),
  };
}

function buildResolvedPolicyOutcome(policyOutcome = {}, decision) {
  const blocked = decision !== "approved";
  return {
    ...(policyOutcome && typeof policyOutcome === "object" ? policyOutcome : {}),
    blocked,
    status: decision === "approved" ? "approved" : "denied",
  };
}

function applyApprovalResolutionRecord(existing, resolution) {
  const now = normalizeTimestamp(resolution?.resolvedAt);
  const decision = normalizeApprovalRequestStatus(resolution?.decision, "approved");
  const actorId = normalizeText(resolution?.actorId) || "operator";
  const note = normalizeText(resolution?.note) || null;
  const history = Array.isArray(existing?.history) ? existing.history.slice() : [];
  history.push({
    timestamp: now,
    decision,
    actorId,
    note,
  });
  return {
    ...existing,
    status: decision,
    updatedAt: now,
    history,
    resolution: {
      decision,
      actorId,
      note,
      resolvedAt: now,
    },
  };
}

function updateWorkflowRunApprovalState(repoRoot, request, resolution = {}) {
  const runId = normalizeText(request?.scopeId);
  if (!runId) throw new Error("Workflow-run approval request is missing scopeId.");
  const detailPath = resolveRunDetailPath(repoRoot, runId);
  if (!existsSync(detailPath)) {
    throw new Error(`Workflow run detail not found for ${runId}.`);
  }
  const detail = readJsonFile(detailPath, {});
  const now = normalizeTimestamp(resolution.resolvedAt);
  const actorId = normalizeText(resolution.actorId) || null;
  const note = normalizeText(resolution.note) || null;
  const decision = normalizeApprovalRequestStatus(resolution.decision, "approved");
  if (!detail.data || typeof detail.data !== "object") detail.data = {};
  const currentExecutionPolicy = {
    ...(detail.data.executionPolicy && typeof detail.data.executionPolicy === "object" ? detail.data.executionPolicy : {}),
    ...(detail.data._executionPolicy && typeof detail.data._executionPolicy === "object" ? detail.data._executionPolicy : {}),
    ...(detail.executionPolicy && typeof detail.executionPolicy === "object" ? detail.executionPolicy : {}),
  };
  const nextExecutionPolicy = {
    ...currentExecutionPolicy,
    approvalRequired: true,
    approvalState: decision,
    blocked: decision !== "approved",
    resolvedAt: now,
    resolvedBy: actorId,
    approvalNote: note,
  };
  detail.data.executionPolicy = cloneJson(nextExecutionPolicy);
  detail.data._executionPolicy = cloneJson(nextExecutionPolicy);
  detail.executionPolicy = cloneJson(nextExecutionPolicy);
  if (detail.data._workflowGovernance && typeof detail.data._workflowGovernance === "object") {
    detail.data._workflowGovernance.executionPolicy = cloneJson(nextExecutionPolicy);
    detail.data._workflowGovernance.policyOutcome = buildResolvedPolicyOutcome(
      detail.data._workflowGovernance.policyOutcome,
      decision,
    );
  }
  detail.policyOutcome = buildResolvedPolicyOutcome(detail.policyOutcome, decision);
  detail.data.policyOutcome = cloneJson(detail.policyOutcome);
  detail.data._workflowApproval = {
    requestId: request.requestId,
    decision,
    resolvedAt: now,
    actorId,
    note,
  };
  writeJsonFile(detailPath, detail);

  const indexPath = resolveRunIndexPath(repoRoot);
  const indexData = readJsonFile(indexPath, { runs: [] });
  const runs = Array.isArray(indexData?.runs) ? indexData.runs.slice() : [];
  const index = runs.findIndex((entry) => normalizeText(entry?.runId) === runId);
  if (index >= 0) {
    runs[index] = {
      ...runs[index],
      executionPolicy: cloneJson(nextExecutionPolicy),
      policyOutcome: buildResolvedPolicyOutcome(runs[index]?.policyOutcome, decision),
      updatedAt: now,
    };
    writeJsonFile(indexPath, { runs });
  }

  const ledger = new WorkflowExecutionLedger({ runsDir: resolveWorkflowRunsDir(repoRoot) });
  ledger.ensureRun({
    runId,
    workflowId: request.workflowId || null,
    workflowName: request.workflowName || null,
    executionPolicy: nextExecutionPolicy,
    policyOutcome: buildResolvedPolicyOutcome(request?.governance?.policyOutcome, decision),
    updatedAt: now,
  });
  ledger.appendEvent({
    runId,
    workflowId: request.workflowId || null,
    workflowName: request.workflowName || null,
    eventType: "approval.resolved",
    status: decision === "approved" ? "completed" : "blocked",
    summary: decision === "approved"
      ? "Workflow approval granted by operator."
      : "Workflow approval denied by operator.",
    timestamp: now,
    meta: {
      requestId: request.requestId,
      actorId,
      note,
      decision,
      taskId: request.taskId || null,
      taskTitle: request.taskTitle || null,
    },
  });

  return {
    runId,
    detail,
    executionPolicy: nextExecutionPolicy,
    policyOutcome: buildResolvedPolicyOutcome(request?.governance?.policyOutcome, decision),
  };
}

function resolveHarnessRunRecordPath(repoRoot, runId) {
  const normalizedRunId = normalizeText(runId);
  if (!normalizedRunId) return "";
  const candidates = [
    resolve(String(repoRoot || process.cwd()), ".cache", "harness", "runs", `${normalizedRunId}.json`),
    resolve(String(repoRoot || process.cwd()), ".bosun", ".cache", "harness", "runs", `${normalizedRunId}.json`),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || "";
}

function updateHarnessRunApprovalState(repoRoot, request, resolution = {}) {
  const runId = normalizeText(request?.scopeId || request?.runId);
  if (!runId) throw new Error("Harness-run approval request is missing scopeId.");
  const runPath = resolveHarnessRunRecordPath(repoRoot, runId);
  if (!runPath || !existsSync(runPath)) {
    return { runId, runRecord: null, runPath };
  }
  const runRecord = readJsonFile(runPath, {});
  const decision = normalizeApprovalRequestStatus(resolution.decision, "approved");
  const now = normalizeTimestamp(resolution.resolvedAt);
  const actorId = normalizeText(resolution.actorId) || null;
  const note = normalizeText(resolution.note) || null;
  const approvals = Array.isArray(runRecord?.approvals) ? runRecord.approvals.slice() : [];
  approvals.push({
    requestId: request.requestId,
    scopeType: "harness-run",
    runId,
    stageId: request.stageId || null,
    stageType: request.stageType || null,
    decision,
    resolvedAt: now,
    actorId,
    note,
  });
  runRecord.approvals = approvals;
  runRecord.latestApproval = approvals[approvals.length - 1] || null;
  writeJsonFile(runPath, runRecord);
  return {
    runId,
    runRecord: cloneJson(runRecord),
    runPath,
    latestApproval: cloneJson(runRecord.latestApproval),
  };
}

export function resolveApprovalRequest(requestId, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  const decision = normalizeApprovalRequestStatus(options.decision, "");
  if (!["approved", "denied"].includes(decision)) {
    throw new Error("decision must be approved or denied");
  }
  const queue = readApprovalQueue(repoRoot);
  const requests = Array.isArray(queue.data.requests) ? queue.data.requests.slice() : [];
  const normalizedRequestId = normalizeText(requestId);
  const index = requests.findIndex((entry) => normalizeText(entry?.requestId) === normalizedRequestId);
  if (index < 0) {
    throw new Error(`Approval request not found: ${normalizedRequestId}`);
  }
  const existing = requests[index];
  const next = applyApprovalResolutionRecord(existing, {
    decision,
    actorId: options.actorId,
    note: options.note,
    resolvedAt: new Date().toISOString(),
  });
  let updateResult = null;
  if (normalizeText(existing?.scopeType) === "workflow-run") {
    updateResult = updateWorkflowRunApprovalState(repoRoot, next, next.resolution);
  } else if (normalizeText(existing?.scopeType) === "workflow-gate") {
    updateResult = recordWorkflowGateLedgerEvent(repoRoot, next, next.resolution);
  } else if (normalizeText(existing?.scopeType) === "workflow-action") {
    updateResult = recordWorkflowActionLedgerEvent(repoRoot, next, next.resolution);
  } else if (normalizeText(existing?.scopeType) === "harness-run") {
    updateResult = updateHarnessRunApprovalState(repoRoot, next, next.resolution);
  }
  requests[index] = next;
  writeApprovalQueue(repoRoot, requests);
  return {
    ok: true,
    request: cloneJson(next),
    updateResult,
    path: queue.path,
  };
}

export function expireApprovalRequest(requestId, options = {}) {
  const repoRoot = resolve(String(options.repoRoot || process.cwd()));
  const queue = readApprovalQueue(repoRoot);
  const requests = Array.isArray(queue.data.requests) ? queue.data.requests.slice() : [];
  const normalizedRequestId = normalizeText(requestId);
  const index = requests.findIndex((entry) => normalizeText(entry?.requestId) === normalizedRequestId);
  if (index < 0) {
    throw new Error(`Approval request not found: ${normalizedRequestId}`);
  }
  const existing = requests[index];
  const next = applyApprovalResolutionRecord(existing, {
    decision: "expired",
    actorId: normalizeText(options.actorId) || "system:timeout",
    note: normalizeText(options.note) || "Approval request timed out.",
    resolvedAt: new Date().toISOString(),
  });
  let updateResult = null;
  if (normalizeText(existing?.scopeType) === "workflow-gate") {
    updateResult = recordWorkflowGateLedgerEvent(repoRoot, next, next.resolution);
  } else if (normalizeText(existing?.scopeType) === "workflow-action") {
    updateResult = recordWorkflowActionLedgerEvent(repoRoot, next, next.resolution);
  } else if (normalizeText(existing?.scopeType) === "harness-run") {
    updateResult = updateHarnessRunApprovalState(repoRoot, next, next.resolution);
  }
  requests[index] = next;
  writeApprovalQueue(repoRoot, requests);
  return {
    ok: true,
    request: cloneJson(next),
    updateResult,
    path: queue.path,
  };
}
