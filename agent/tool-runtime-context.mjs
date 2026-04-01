function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean),
  ));
}

function normalizeApprovalState(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["approved", "pending", "denied", "expired"].includes(normalized)) return normalized;
  return null;
}

function normalizeApprovalMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["inherit", "never", "manual", "always", "auto"].includes(normalized)) return normalized;
  return "inherit";
}

function normalizeNetworkMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["inherit", "deny", "allow", "restricted", "offline"].includes(normalized)) return normalized;
  return "inherit";
}

function normalizeApprovalContext(context = {}, defaults = {}) {
  const merged = {
    ...(defaults?.approval && typeof defaults.approval === "object" ? defaults.approval : {}),
    ...(context?.approval && typeof context.approval === "object" ? context.approval : {}),
  };
  return {
    mode: normalizeApprovalMode(
      merged.mode ?? context.approvalMode ?? defaults.approvalMode,
    ),
    state: normalizeApprovalState(
      merged.state ?? context.approvalState ?? defaults.approvalState,
    ),
    decision: normalizeApprovalState(
      merged.decision ?? context.approvalDecision ?? defaults.approvalDecision,
    ),
    requestId: normalizeOptionalText(
      merged.requestId ?? context.approvalRequestId ?? defaults.approvalRequestId,
    ),
    scopeType: normalizeOptionalText(
      merged.scopeType ?? context.approvalScopeType ?? defaults.approvalScopeType,
    ),
    scopeId: normalizeOptionalText(
      merged.scopeId ?? context.approvalScopeId ?? defaults.approvalScopeId,
    ),
    note: normalizeOptionalText(
      merged.note ?? context.approvalNote ?? defaults.approvalNote,
    ),
    requestedBy: normalizeOptionalText(
      merged.requestedBy ?? context.requestedBy ?? defaults.requestedBy,
    ),
  };
}

function normalizeNetworkContext(context = {}, defaults = {}) {
  const merged = {
    ...(defaults?.network && typeof defaults.network === "object" ? defaults.network : {}),
    ...(context?.network && typeof context.network === "object" ? context.network : {}),
  };
  return {
    mode: normalizeNetworkMode(
      merged.mode ?? context.networkMode ?? defaults.networkMode,
    ),
    requestedHosts: uniqueStrings(
      merged.requestedHosts ?? context.requestedHosts ?? defaults.requestedHosts,
    ),
    allowedHosts: uniqueStrings(
      merged.allowedHosts ?? context.allowedHosts ?? defaults.allowedHosts,
    ),
    blockedHosts: uniqueStrings(
      merged.blockedHosts ?? context.blockedHosts ?? defaults.blockedHosts,
    ),
  };
}

export function normalizeToolRuntimeContext(context = {}, defaults = {}) {
  const mergedMetadata = {
    ...(defaults?.metadata && typeof defaults.metadata === "object" ? cloneJson(defaults.metadata) : {}),
    ...(context?.metadata && typeof context.metadata === "object" ? cloneJson(context.metadata) : {}),
  };
  const sessionId = normalizeOptionalText(context.sessionId ?? defaults.sessionId ?? context.threadId ?? defaults.threadId);
  return {
    cwd: normalizeOptionalText(context.cwd ?? defaults.cwd),
    repoRoot: normalizeOptionalText(context.repoRoot ?? defaults.repoRoot),
    sessionId,
    rootSessionId: normalizeOptionalText(context.rootSessionId ?? defaults.rootSessionId ?? sessionId),
    parentSessionId: normalizeOptionalText(context.parentSessionId ?? defaults.parentSessionId),
    threadId: normalizeOptionalText(context.threadId ?? defaults.threadId ?? sessionId),
    runId: normalizeOptionalText(context.runId ?? defaults.runId),
    workflowId: normalizeOptionalText(context.workflowId ?? defaults.workflowId),
    taskId: normalizeOptionalText(context.taskId ?? defaults.taskId),
    taskKey: normalizeOptionalText(context.taskKey ?? defaults.taskKey),
    sessionType: normalizeOptionalText(context.sessionType ?? defaults.sessionType),
    surface: normalizeOptionalText(context.surface ?? defaults.surface),
    providerId: normalizeOptionalText(context.providerId ?? defaults.providerId),
    executor: normalizeOptionalText(context.executor ?? defaults.executor),
    model: normalizeOptionalText(context.model ?? defaults.model),
    agentProfileId: normalizeOptionalText(context.agentProfileId ?? defaults.agentProfileId),
    requestId: normalizeOptionalText(context.requestId ?? defaults.requestId),
    correlationId: normalizeOptionalText(context.correlationId ?? defaults.correlationId),
    sandbox: normalizeOptionalText(context.sandbox ?? defaults.sandbox),
    requestedBy: normalizeOptionalText(context.requestedBy ?? defaults.requestedBy),
    approval: normalizeApprovalContext(context, defaults),
    network: normalizeNetworkContext(context, defaults),
    metadata: mergedMetadata,
  };
}

export function mergeToolRuntimeContext(base = {}, override = {}) {
  return normalizeToolRuntimeContext(override, base);
}

export function buildToolExecutionEnvelope(toolName, args = {}, context = {}, defaults = {}) {
  return {
    toolName: normalizeText(toolName),
    args: cloneJson(args) ?? {},
    context: normalizeToolRuntimeContext(context, defaults),
  };
}

export default normalizeToolRuntimeContext;
