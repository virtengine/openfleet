import {
  expireApprovalRequest,
  getApprovalRequest,
  upsertWorkflowActionApprovalRequest,
} from "./approval-queue.mjs";

const DEFAULT_ACTION_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_ACTION_APPROVAL_POLL_INTERVAL_MS = 5000;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseBooleanLike(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.trunc(numeric));
}

function collectCommandSegments(command, args = []) {
  const pieces = [];
  const commandText = normalizeText(command);
  if (commandText) pieces.push(commandText);
  if (Array.isArray(args) && args.length > 0) {
    pieces.push(
      ...args
        .map((entry) => normalizeText(entry))
        .filter(Boolean),
    );
  }
  return pieces;
}

function matchesShellCommandPattern(commandLine, pattern) {
  return pattern.test(commandLine);
}

function hasGitCleanFlags(tokens = []) {
  return tokens.some((token) => token.includes("f"))
    && tokens.some((token) => token.includes("d"));
}

function buildCommandPreview(command, args = []) {
  return collectCommandSegments(command, args).join(" ").trim();
}

function classifyRunCommandRisk(command, args = []) {
  const segments = collectCommandSegments(command, args);
  if (segments.length === 0) return null;
  const [head, ...tail] = segments;
  const normalizedHead = head.toLowerCase();
  const normalizedTail = tail.map((entry) => entry.toLowerCase());
  const preview = buildCommandPreview(command, args);
  const normalizedPreview = preview.toLowerCase().replace(/\s+/g, " ").trim();

  if (normalizedHead === "git") {
    if (normalizedTail[0] === "push") {
      return {
        actionKey: "run-command-git-push",
        actionLabel: "Run git push",
        reason: "This command will push commits to a remote repository.",
        preview,
      };
    }
    if (normalizedTail[0] === "reset" && normalizedTail.includes("--hard")) {
      return {
        actionKey: "run-command-git-reset-hard",
        actionLabel: "Run git reset --hard",
        reason: "This command will discard local repository changes.",
        preview,
      };
    }
    if (normalizedTail[0] === "clean" && hasGitCleanFlags(normalizedTail.slice(1))) {
      return {
        actionKey: "run-command-git-clean",
        actionLabel: "Run git clean -fd",
        reason: "This command will permanently remove untracked files from the worktree.",
        preview,
      };
    }
    if (normalizedTail[0] === "worktree" && normalizedTail[1] === "remove" && normalizedTail.includes("--force")) {
      return {
        actionKey: "run-command-git-worktree-remove",
        actionLabel: "Remove git worktree",
        reason: "This command will forcibly remove a git worktree.",
        preview,
      };
    }
  }

  if (normalizedHead === "gh") {
    if (normalizedTail[0] === "pr" && normalizedTail[1] === "close" && normalizedTail.includes("--delete-branch")) {
      return {
        actionKey: "run-command-gh-pr-close",
        actionLabel: "Close PR and delete branch",
        reason: "This command will close a pull request and delete its branch.",
        preview,
      };
    }
    if (normalizedTail[0] === "release" && normalizedTail[1] === "create") {
      return {
        actionKey: "run-command-gh-release-create",
        actionLabel: "Create GitHub release",
        reason: "This command will create a GitHub release.",
        preview,
      };
    }
  }

  if ((normalizedHead === "npm" || normalizedHead.endsWith("/npm") || normalizedHead.endsWith("\\npm")) && normalizedTail[0] === "publish") {
    return {
      actionKey: "run-command-npm-publish",
      actionLabel: "Publish npm package",
      reason: "This command will publish a package to npm.",
      preview,
    };
  }

  const shellPatterns = [
    {
      key: "run-command-git-push",
      label: "Run git push",
      reason: "This command will push commits to a remote repository.",
      pattern: /(^|[;&|]\s*|&&\s*|\|\|\s*)git\s+push(?:\s|$)/i,
    },
    {
      key: "run-command-git-reset-hard",
      label: "Run git reset --hard",
      reason: "This command will discard local repository changes.",
      pattern: /(^|[;&|]\s*|&&\s*|\|\|\s*)git\s+reset\s+--hard(?:\s|$)/i,
    },
    {
      key: "run-command-git-clean",
      label: "Run git clean -fd",
      reason: "This command will permanently remove untracked files from the worktree.",
      pattern: /(^|[;&|]\s*|&&\s*|\|\|\s*)git\s+clean\s+-[^\n\r]*f[^\n\r]*d(?:\s|$)/i,
    },
    {
      key: "run-command-git-worktree-remove",
      label: "Remove git worktree",
      reason: "This command will forcibly remove a git worktree.",
      pattern: /(^|[;&|]\s*|&&\s*|\|\|\s*)git\s+worktree\s+remove(?:\s+[^\n\r;&|]+)*\s+--force(?:\s|$)/i,
    },
    {
      key: "run-command-gh-pr-close",
      label: "Close PR and delete branch",
      reason: "This command will close a pull request and delete its branch.",
      pattern: /(^|[;&|]\s*|&&\s*|\|\|\s*)gh\s+pr\s+close(?:\s+[^\n\r;&|]+)*\s+--delete-branch(?:\s|$)/i,
    },
    {
      key: "run-command-gh-release-create",
      label: "Create GitHub release",
      reason: "This command will create a GitHub release.",
      pattern: /(^|[;&|]\s*|&&\s*|\|\|\s*)gh\s+release\s+create(?:\s|$)/i,
    },
    {
      key: "run-command-npm-publish",
      label: "Publish npm package",
      reason: "This command will publish a package to npm.",
      pattern: /(^|[;&|]\s*|&&\s*|\|\|\s*)npm\s+publish(?:\s|$)/i,
    },
  ];

  for (const candidate of shellPatterns) {
    if (matchesShellCommandPattern(normalizedPreview, candidate.pattern)) {
      return {
        actionKey: candidate.key,
        actionLabel: candidate.label,
        reason: candidate.reason,
        preview,
      };
    }
  }

  return null;
}

export function isWorkflowRiskyActionApprovalEnabled() {
  return parseBooleanLike(process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED, false);
}

export function describeRiskyWorkflowAction({ nodeType, nodeConfig = {}, command = "", args = [] } = {}) {
  const normalizedNodeType = normalizeText(nodeType);
  if (!normalizedNodeType) return null;

  if (normalizedNodeType === "action.push_branch") {
    const branch = normalizeText(nodeConfig.branch) || "current branch";
    const remote = normalizeText(nodeConfig.remote) || "origin";
    return {
      actionKey: "push-branch",
      actionLabel: "Push branch",
      reason: `This action will push ${branch} to ${remote}.`,
      preview: `git push --set-upstream ${remote} ${branch === "current branch" ? "HEAD" : branch}`,
    };
  }

  if (normalizedNodeType === "action.create_pr") {
    const title = normalizeText(nodeConfig.title) || "workflow-generated pull request";
    return {
      actionKey: "create-pr",
      actionLabel: "Create pull request",
      reason: `This action will open or update a pull request for ${title}.`,
      preview: title,
    };
  }

  if (normalizedNodeType === "action.git_operations") {
    const operations = Array.isArray(nodeConfig.operations) && nodeConfig.operations.length > 0
      ? nodeConfig.operations
      : [nodeConfig];
    const includesPush = operations.some((entry) => {
      const op = normalizeText(entry?.op || entry?.operation || nodeConfig.operation).toLowerCase();
      return op === "push";
    });
    if (!includesPush) return null;
    return {
      actionKey: "git-operations-push",
      actionLabel: "Run git push operations",
      reason: "This action batch includes a push to a remote repository.",
      preview: "git push --set-upstream origin HEAD",
    };
  }

  if (normalizedNodeType === "action.refresh_worktree") {
    const operation = normalizeText(nodeConfig.operation).toLowerCase();
    if (operation === "reset_hard") {
      return {
        actionKey: "refresh-worktree-reset-hard",
        actionLabel: "Reset worktree hard",
        reason: "This action will discard local repository changes and clean untracked files.",
        preview: "git reset --hard HEAD && git clean -fd",
      };
    }
    if (operation === "clean") {
      return {
        actionKey: "refresh-worktree-clean",
        actionLabel: "Clean worktree",
        reason: "This action will permanently remove untracked files from the worktree.",
        preview: "git clean -fd",
      };
    }
    return null;
  }

  if (normalizedNodeType === "action.bosun_cli") {
    const subcommand = normalizeText(nodeConfig.subcommand).toLowerCase();
    if (subcommand !== "task delete") return null;
    const extraArgs = normalizeText(nodeConfig.args);
    return {
      actionKey: "bosun-cli-task-delete",
      actionLabel: "Delete Bosun task",
      reason: "This action will delete a Bosun task through the CLI.",
      preview: `bosun task delete ${extraArgs}`.trim(),
    };
  }

  if (normalizedNodeType === "action.run_command") {
    return classifyRunCommandRisk(command, args);
  }

  return null;
}

function buildWorkflowActionScopeId(runId, nodeId) {
  const normalizedRunId = normalizeText(runId);
  const normalizedNodeId = normalizeText(nodeId);
  if (!normalizedRunId || !normalizedNodeId) return "";
  return `${normalizedRunId}:${normalizedNodeId}`;
}

function clearPendingApprovalRequest(ctx, requestId, engine) {
  if (!requestId || !ctx?.data?._pendingApprovalRequests?.[requestId]) return;
  delete ctx.data._pendingApprovalRequests[requestId];
  engine?._checkpointRun?.(ctx);
}

function ensurePendingApprovalRequest(ctx, request, engine) {
  if (!ctx?.data || !request?.requestId) return;
  if (!ctx.data._pendingApprovalRequests || typeof ctx.data._pendingApprovalRequests !== "object") {
    ctx.data._pendingApprovalRequests = {};
  }
  ctx.data._pendingApprovalRequests[request.requestId] = {
    requestId: request.requestId,
    scopeType: request.scopeType,
    scopeId: request.scopeId,
    nodeId: request.nodeId,
    nodeLabel: request.nodeLabel,
    nodeType: request.nodeType || null,
    reason: request.reason,
    status: request.status,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt || null,
  };
  engine?._checkpointRun?.(ctx);
}

export async function requireWorkflowActionApproval({
  node,
  ctx,
  engine,
  nodeType,
  repoRoot,
  command = "",
  args = [],
} = {}) {
  const resolvedNodeType = normalizeText(nodeType || node?.type);
  const risk = describeRiskyWorkflowAction({
    nodeType: resolvedNodeType,
    nodeConfig: node?.config || {},
    command,
    args,
  });
  const explicitApproval = node?.config?.requireApproval === true;
  const approvalsEnabled = explicitApproval || isWorkflowRiskyActionApprovalEnabled();
  if (!risk || !approvalsEnabled) return null;

  const executionId =
    normalizeText(ctx?.data?._dagState?.runId)
    || normalizeText(ctx?.id)
    || normalizeText(ctx?.data?.taskId);
  const requestScopeId = buildWorkflowActionScopeId(executionId, node?.id);
  if (!requestScopeId) return null;

  const rootDir = normalizeText(repoRoot)
    || normalizeText(ctx?.data?.repoRoot)
    || normalizeText(ctx?.data?.repoPath)
    || process.cwd();
  const timeoutMs = parseInteger(node?.config?.approvalTimeoutMs, DEFAULT_ACTION_APPROVAL_TIMEOUT_MS);
  const pollIntervalMs = parseInteger(node?.config?.approvalPollIntervalMs, DEFAULT_ACTION_APPROVAL_POLL_INTERVAL_MS);
  const reasonSuffix = normalizeText(node?.config?.approvalReason);
  const reason = reasonSuffix
    ? `${risk.reason} ${reasonSuffix}`.trim()
    : risk.reason;
  const onTimeout = normalizeText(node?.config?.approvalOnTimeout).toLowerCase() === "proceed"
    ? "proceed"
    : "fail";

  const existing = getApprovalRequest("workflow-action", requestScopeId, { repoRoot: rootDir });
  if (existing?.status === "approved") return { request: existing, approved: true, risk };
  if (existing?.status === "denied") {
    throw new Error(`Operator denied risky workflow action: ${risk.actionLabel}`);
  }
  if (existing?.status === "expired") {
    throw new Error(`Risky workflow action approval expired: ${risk.actionLabel}`);
  }

  const request = upsertWorkflowActionApprovalRequest({
    runId: executionId,
    rootRunId: ctx?.data?._workflowRootRunId || executionId,
    parentRunId: ctx?.data?._workflowParentRunId || null,
    workflowId: ctx?.data?._workflowId || ctx?.data?._dagState?.workflowId || null,
    workflowName: ctx?.data?._workflowName || ctx?.data?._dagState?.workflowName || null,
    taskId: ctx?.data?.taskId || null,
    taskTitle: ctx?.data?.taskTitle || null,
    nodeId: node?.id,
    nodeLabel: node?.label || null,
    nodeType: resolvedNodeType,
    requestedBy: resolvedNodeType || "workflow-action",
    reason,
    timeoutMs,
    onTimeout,
    pollIntervalMs,
    actionKey: risk.actionKey,
    actionLabel: risk.actionLabel,
    preview: risk.preview || null,
  }, { repoRoot: rootDir }).request;
  if (!request) return null;

  ensurePendingApprovalRequest(ctx, request, engine);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = getApprovalRequest(request.scopeType, request.scopeId, { repoRoot: rootDir }) || request;
    const status = normalizeText(current?.status).toLowerCase();
    if (status === "approved") {
      clearPendingApprovalRequest(ctx, request.requestId, engine);
      return { request: current, approved: true, risk };
    }
    if (status === "denied") {
      clearPendingApprovalRequest(ctx, request.requestId, engine);
      throw new Error(`Operator denied risky workflow action: ${risk.actionLabel}`);
    }
    if (status === "expired") {
      clearPendingApprovalRequest(ctx, request.requestId, engine);
      throw new Error(`Risky workflow action approval expired: ${risk.actionLabel}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs));
  }

  try {
    const pending = getApprovalRequest(request.scopeType, request.scopeId, { repoRoot: rootDir });
    if (pending?.status === "pending") {
      expireApprovalRequest(request.requestId, {
        repoRoot: rootDir,
        actorId: "system:timeout",
        note: `Risky workflow action approval timed out after ${timeoutMs}ms.`,
      });
    }
  } catch {
    // best effort
  }
  clearPendingApprovalRequest(ctx, request.requestId, engine);
  if (onTimeout === "proceed") {
    return { request, approved: false, timedOut: true, risk };
  }
  throw new Error(`Risky workflow action approval timed out: ${risk.actionLabel}`);
}
