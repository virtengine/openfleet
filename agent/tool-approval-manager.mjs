function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeApprovalState(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["approved", "pending", "denied", "expired"].includes(normalized)) return normalized;
  return null;
}

function normalizeApprovalMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["never", "manual", "always", "auto", "inherit"].includes(normalized)) return normalized;
  return "auto";
}

function asSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => normalizeText(value))
      .filter(Boolean),
  );
}

function inferToolRiskLevel(tool = {}) {
  const normalized = normalizeText(tool.riskLevel || tool.metadata?.riskLevel).toLowerCase();
  if (["critical", "high", "medium", "low"].includes(normalized)) return normalized;
  if (tool.requiresApproval === true) return "high";
  return "low";
}

function resolveScopeType(context = {}, defaults = {}) {
  return normalizeText(
    context?.approval?.scopeType || context.approvalScopeType || defaults.approvalScopeType || "harness-run",
  ) || "harness-run";
}

function resolveScopeId(context = {}, defaults = {}) {
  return normalizeText(
    context?.approval?.scopeId
    || context.approvalScopeId
    || context.runId
    || context.sessionId
    || context.taskKey
    || defaults.approvalScopeId,
  ) || null;
}

export function evaluateToolApproval(tool = {}, context = {}, options = {}) {
  const toolId = normalizeText(tool.id || tool.name);
  const allowlisted = asSet(options.allowlistedTools);
  const denylisted = asSet(options.denylistedTools);
  const mode = normalizeApprovalMode(
    tool.approvalMode
    ?? context?.approval?.mode
    ?? context.approvalMode
    ?? options.defaultMode,
  );
  const currentState = normalizeApprovalState(
    context?.approval?.decision
    || context?.approval?.state
    || context.approvalDecision
    || context.approvalState,
  );
  const riskLevel = inferToolRiskLevel(tool);
  const policyRequiresApproval = context.executionPolicy?.approvalRequired === true;
  const needsApproval = (
    denylisted.has(toolId)
    || (toolId && !allowlisted.has(toolId) && (
      tool.requiresApproval === true
      || policyRequiresApproval
      || mode === "always"
      || (mode !== "never" && ["high", "critical"].includes(riskLevel))
    ))
  );

  if (currentState === "approved") {
    return {
      toolId,
      approvalRequired: needsApproval,
      approvalState: "approved",
      blocked: false,
      mode,
      riskLevel,
      reason: null,
      scopeType: resolveScopeType(context, options),
      scopeId: resolveScopeId(context, options),
    };
  }

  if (currentState === "denied" || currentState === "expired") {
    return {
      toolId,
      approvalRequired: needsApproval,
      approvalState: currentState,
      blocked: true,
      mode,
      riskLevel,
      reason: normalizeText(context?.approval?.note || context.approvalNote)
        || `Tool ${toolId || "execution"} was ${currentState}.`,
      scopeType: resolveScopeType(context, options),
      scopeId: resolveScopeId(context, options),
    };
  }

  if (!needsApproval || mode === "never" || allowlisted.has(toolId)) {
    return {
      toolId,
      approvalRequired: false,
      approvalState: "not_required",
      blocked: false,
      mode,
      riskLevel,
      reason: null,
      scopeType: resolveScopeType(context, options),
      scopeId: resolveScopeId(context, options),
    };
  }

  return {
    toolId,
    approvalRequired: true,
    approvalState: "pending",
    blocked: true,
    mode,
    riskLevel,
    reason: normalizeText(tool.approvalReason || context?.approval?.note || options.pendingReason)
      || `Tool ${toolId || "execution"} requires operator approval.`,
    scopeType: resolveScopeType(context, options),
    scopeId: resolveScopeId(context, options),
  };
}

export function createToolApprovalManager(defaultOptions = {}) {
  return {
    evaluate(tool, context = {}, options = {}) {
      return evaluateToolApproval(tool, context, { ...defaultOptions, ...options });
    },
    assertApproved(tool, context = {}, options = {}) {
      const result = evaluateToolApproval(tool, context, { ...defaultOptions, ...options });
      if (result.blocked) {
        throw new Error(result.reason || `Tool ${result.toolId || "execution"} is blocked pending approval.`);
      }
      return result;
    },
  };
}

export default createToolApprovalManager;
