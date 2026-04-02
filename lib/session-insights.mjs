/*
 * Session insights helpers.
 * Builds high-signal activity metrics from full session message history.
 */

const FILE_PATH_PATTERN =
  /([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|mdx|css|scss|less|html|yml|yaml|toml|env|lock|go|rs|py|sh|ps1|psm1|txt|sql|xml|csv))/g;

const EDIT_TOOL_HINTS = [
  "apply_patch",
  "write",
  "edit",
  "replace",
  "append",
  "create_file",
  "createfile",
  "update_file",
  "move_file",
  "delete_file",
];

const OPEN_TOOL_HINTS = [
  "read",
  "open",
  "view",
  "search",
  "grep",
  "rg",
  "glob",
  "list",
  "cat",
];

const CONTEXT_BREAKDOWN_LABELS = new Set([
  "system instructions",
  "tool definitions",
  "messages",
  "files",
  "tool results",
  "user context",
  "system",
]);

function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseCompactNumber(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)([km])?$/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = String(match[2] || "").toLowerCase();
  if (suffix === "k") return Math.round(n * 1_000);
  if (suffix === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

function normalizeFilePath(raw) {
  let text = String(raw || "").trim();
  while (text.startsWith("`") || text.startsWith("'") || text.startsWith('"')) {
    text = text.slice(1);
  }
  while (text.endsWith("`") || text.endsWith("'") || text.endsWith('"')) {
    text = text.slice(0, -1);
  }
  if (!text) return "";
  if (text.startsWith("..")) return "";
  return text.split("\\").join("/");
}

function addFile(map, path, count = 1, ts = "") {
  const safe = normalizeFilePath(path);
  if (!safe) return;
  const entry = map.get(safe) || { path: safe, count: 0, lastTs: "" };
  entry.count += Number.isFinite(count) ? count : 1;
  if (ts && (!entry.lastTs || String(ts) > String(entry.lastTs))) {
    entry.lastTs = ts;
  }
  map.set(safe, entry);
}

function extractFilesFromPatchText(text) {
  const files = [];
  const source = String(text || "");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    const updatePrefix = "*** Update File:";
    const addPrefix = "*** Add File:";
    const deletePrefix = "*** Delete File:";
    const movePrefix = "*** Move to:";
    let rawPath = "";
    if (trimmed.startsWith(updatePrefix)) rawPath = trimmed.slice(updatePrefix.length).trim();
    else if (trimmed.startsWith(addPrefix)) rawPath = trimmed.slice(addPrefix.length).trim();
    else if (trimmed.startsWith(deletePrefix)) rawPath = trimmed.slice(deletePrefix.length).trim();
    else if (trimmed.startsWith(movePrefix)) rawPath = trimmed.slice(movePrefix.length).trim();
    if (!rawPath) continue;
    const file = normalizeFilePath(rawPath);
    if (file) files.push(file);
  }
  return files;
}

function extractFilesFromText(text) {
  const files = [];
  const source = String(text || "");
  const allowedExt = new Set([
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "mdx", "css", "scss", "less",
    "html", "yml", "yaml", "toml", "env", "lock", "go", "rs", "py", "sh", "ps1", "psm1",
    "txt", "sql", "xml", "csv",
  ]);
  const tokens = source.split(/[^A-Za-z0-9_./-]+/);
  for (const token of tokens) {
    if (!token || token.length < 3) continue;
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx <= 0 || dotIdx >= token.length - 1) continue;
    const ext = token.slice(dotIdx + 1).toLowerCase();
    if (!allowedExt.has(ext)) continue;
    const file = normalizeFilePath(token);
    if (file) files.push(file);
  }
  return files;
}

function classifyToolCall(toolName, content) {
  const tool = String(toolName || "").trim().toLowerCase();
  const cmd = String(content || "").trim().toLowerCase();

  if (EDIT_TOOL_HINTS.some((hint) => tool.includes(hint))) {
    return { kind: "edit", commandLike: tool === "command_execution" };
  }
  if (OPEN_TOOL_HINTS.some((hint) => tool.includes(hint))) {
    return { kind: "open", commandLike: tool === "command_execution" };
  }

  if (tool === "command_execution") {
    const firstLine = cmd.split("\n")[0] || "";
    if (/\b(apply_patch|sed\s+-i|perl\s+-i|tee\s+|cat\s+>)/.test(firstLine)) {
      return { kind: "edit", commandLike: true };
    }
    if (/\b(rg|grep|cat|sed|head|tail|ls|find|stat|git show)\b/.test(firstLine)) {
      return { kind: "open", commandLike: true };
    }
    return { kind: "other", commandLike: true };
  }

  return { kind: "other", commandLike: false };
}

function parseContextWindowSnapshot(text) {
  const source = String(text || "");
  const lower = source.toLowerCase();
  const tokenIdx = lower.indexOf("tokens");
  const slashIdx = source.indexOf("/");

  if (slashIdx > 0 && tokenIdx > slashIdx) {
    const left = source.slice(0, slashIdx).trim().split(/\s+/).pop() || "";
    const rightPart = source.slice(slashIdx + 1, tokenIdx).trim();
    const right = rightPart.split(/\s+/)[0] || "";
    const usedTokens = parseCompactNumber(left);
    const totalTokens = parseCompactNumber(right);

    let explicitPercent = null;
    const percentIdx = source.indexOf("%", tokenIdx);
    if (percentIdx > tokenIdx) {
      const leftSide = source.slice(0, percentIdx);
      const candidate = leftSide.split(/[^0-9.]+/).filter(Boolean).pop();
      if (candidate) {
        const n = Number(candidate);
        if (Number.isFinite(n)) explicitPercent = n;
      }
    }

    const percent =
      explicitPercent != null
        ? explicitPercent
        : usedTokens != null && totalTokens
          ? Math.round((usedTokens / totalTokens) * 1000) / 10
          : null;
    return { usedTokens, totalTokens, percent };
  }

  const marker = "context window:";
  const markerIdx = lower.indexOf(marker);
  if (markerIdx >= 0) {
    const pctIdx = source.indexOf("%", markerIdx);
    if (pctIdx > markerIdx) {
      const raw = source.slice(markerIdx + marker.length, pctIdx).trim();
      const numberText = raw.split(/\s+/)[0];
      const percent = Number(numberText);
      if (Number.isFinite(percent)) {
        return { usedTokens: null, totalTokens: null, percent };
      }
    }
  }

  return null;
}

function parseContextBreakdown(text) {
  const rows = [];
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z ]{1,40})\s+(\d+(?:\.\d+)?)%\s*$/);
    if (!match) continue;
    const label = String(match[1] || "").trim();
    const key = label.toLowerCase();
    if (!CONTEXT_BREAKDOWN_LABELS.has(key)) continue;
    const percent = Number(match[2]);
    if (!Number.isFinite(percent)) continue;
    rows.push({ label, percent });
  }
  return rows;
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const input =
    Number(
      value.inputTokens
      ?? value.input_tokens
      ?? value.promptTokens
      ?? value.prompt_tokens
      ?? value.input
      ?? value.prompt
      ?? 0,
    ) || 0;
  const output =
    Number(
      value.outputTokens
      ?? value.output_tokens
      ?? value.completionTokens
      ?? value.completion_tokens
      ?? value.output
      ?? value.completion
      ?? 0,
    ) || 0;
  const total = Number(value.totalTokens ?? value.total_tokens ?? value.total ?? input + output) || 0;
  if (input <= 0 && output <= 0 && total <= 0) return null;
  return { input, output, total };
}

function normalizeTokenUsageShape(value) {
  const usage = normalizeUsage(value);
  if (!usage) return null;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.total,
  };
}

function pickString(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return null;
}

function toIsoString(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function normalizeDiagnosticsTurn(turn = {}, index = 0) {
  const usage =
    normalizeTokenUsageShape(turn?.tokenUsage)
    || normalizeTokenUsageShape(turn?.usage)
    || normalizeTokenUsageShape(turn?.meta?.usage)
    || null;
  return {
    id: pickString(turn?.id, turn?.turnId, `turn-${index + 1}`),
    index: Number.isFinite(Number(turn?.index)) ? Math.max(0, Math.trunc(Number(turn.index))) : index,
    status: pickString(turn?.status, turn?.state) || "unknown",
    startedAt: toIsoString(turn?.startedAt || turn?.timestamp),
    endedAt: toIsoString(turn?.endedAt),
    durationMs: toPositiveNumber(turn?.durationMs),
    summary: pickString(turn?.summary, turn?.title, turn?.preview, turn?.content),
    inputTokens: usage?.inputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    totalTokens: usage?.totalTokens || 0,
  };
}

function normalizeDiagnosticsMessage(message = {}, index = 0) {
  const usage =
    normalizeTokenUsageShape(message?.meta?.usage)
    || normalizeTokenUsageShape(message?.usage)
    || normalizeTokenUsageShape(message?.meta?.tokenUsage)
    || null;
  return {
    id: pickString(message?.id, message?.messageId, `message-${index + 1}`),
    role: pickString(message?.role, message?.type) || "unknown",
    type: pickString(message?.type, message?.role) || "message",
    timestamp: toIsoString(message?.timestamp || message?.createdAt),
    content: toText(message?.content).slice(0, 4000),
    inputTokens: usage?.inputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    totalTokens: usage?.totalTokens || 0,
  };
}

function normalizeDiagnosticsWorkflowRun(run = {}) {
  const issueAdvisor =
    run?.issueAdvisor && typeof run.issueAdvisor === "object"
      ? {
          recommendedAction: pickString(run.issueAdvisor.recommendedAction, run.issueAdvisor.action),
          summary: pickString(run.issueAdvisor.summary),
        }
      : null;
  return {
    runId: pickString(run?.runId, run?.id),
    workflowId: pickString(run?.workflowId),
    workflowName: pickString(run?.workflowName, run?.name),
    status: pickString(run?.status) || "unknown",
    sessionId: pickString(run?.sessionId),
    primarySessionId: pickString(run?.primarySessionId, run?.sessionId),
    startedAt: toIsoString(run?.startedAt),
    endedAt: toIsoString(run?.endedAt),
    durationMs: toPositiveNumber(run?.durationMs ?? run?.duration),
    issueAdvisor,
    plannerSummary: pickString(
      run?.proofSummary?.plannerSummary,
      run?.proofBundle?.summary?.plannerSummary,
      run?.plannerTimeline?.at?.(-1)?.summary,
    ),
  };
}

export function formatCompactCount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    Math.max(0, n),
  );
}

export function buildSessionInsights(fullSession = null) {
  const persisted =
    fullSession?.insights && typeof fullSession.insights === "object"
      ? fullSession.insights
      : null;
  const messages = Array.isArray(fullSession?.messages) ? fullSession.messages : [];
  const tools = new Map();
  const openedFiles = new Map();
  const editedFiles = new Map();
  const referencedFiles = new Map();
  const recentActions = [];

  let toolCalls = 0;
  let toolResults = 0;
  let errors = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let systemMessages = 0;
  let commandExecutions = 0;
  let openOps = 0;
  let editOps = 0;
  let contextWindow = null;
  let contextBreakdown = [];
  let tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (const msg of messages) {
    if (!msg) continue;
    const type = String(msg.type || "").toLowerCase();
    const role = String(msg.role || "").toLowerCase();
    const content = toText(msg.content);
    const ts = String(msg.timestamp || "");

    if (role === "user") userMessages += 1;
    if (role === "assistant" || type === "agent_message" || type === "assistant_message") {
      assistantMessages += 1;
    }
    if (type === "system" || role === "system") systemMessages += 1;
    if (type === "error" || type === "stream_error") {
      errors += 1;
      recentActions.push({
        type: "error",
        label: content.slice(0, 180),
        level: "error",
        timestamp: ts,
      });
    }

    const usage = normalizeUsage(msg?.meta?.usage) || normalizeUsage(msg?.usage) || null;
    if (usage) {
      tokenUsage.inputTokens += usage.input;
      tokenUsage.outputTokens += usage.output;
      tokenUsage.totalTokens += usage.total;
    }

    const snapshot = parseContextWindowSnapshot(content);
    if (snapshot) contextWindow = snapshot;
    const breakdown = parseContextBreakdown(content);
    if (breakdown.length) contextBreakdown = breakdown;

    if (type === "tool_result" || type === "tool_output") {
      toolResults += 1;
      continue;
    }
    if (type !== "tool_call") continue;
    if (String(msg?.meta?.lifecycle || "").toLowerCase() === "started") continue;

    toolCalls += 1;
    const toolName = String(msg?.meta?.toolName || "tool").trim() || "tool";
    tools.set(toolName, (tools.get(toolName) || 0) + 1);
    if (toolName.toLowerCase() === "command_execution") commandExecutions += 1;

    const classification = classifyToolCall(toolName, content);
    const patchFiles =
      toolName.toLowerCase().includes("apply_patch") || /[*]{3}\s+(?:Update|Add|Delete)\s+File:/.test(content)
        ? extractFilesFromPatchText(content)
        : [];
    const genericFiles = extractFilesFromText(content);
    const combinedFiles = patchFiles.length ? patchFiles : genericFiles;

    for (const file of genericFiles) addFile(referencedFiles, file, 1, ts);
    if (classification.kind === "open") {
      openOps += 1;
      for (const file of combinedFiles) addFile(openedFiles, file, 1, ts);
    } else if (classification.kind === "edit") {
      editOps += 1;
      for (const file of combinedFiles) addFile(editedFiles, file, 1, ts);
    }

    const shortDetail = content.split("\n")[0]?.slice(0, 180) || "";
    recentActions.push({
      type: "tool_call",
      label: `${toolName}${shortDetail ? `: ${shortDetail}` : ""}`,
      level: "info",
      timestamp: ts,
    });
  }

  const edited = Array.from(editedFiles.values()).sort((a, b) => b.count - a.count);
  const opened = Array.from(openedFiles.values()).sort((a, b) => b.count - a.count);
  const referenced = Array.from(referencedFiles.values()).sort((a, b) => b.count - a.count);
  const topTools = Array.from(tools.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  if (tokenUsage.inputTokens <= 0 && tokenUsage.outputTokens <= 0 && tokenUsage.totalTokens <= 0) {
    tokenUsage = null;
  }

  if (!contextWindow && tokenUsage?.totalTokens > 0) {
    contextWindow = {
      usedTokens: tokenUsage.totalTokens,
      totalTokens: null,
      percent: null,
    };
  }

  const derived = {
    totals: {
      messages: messages.length,
      toolCalls,
      toolResults,
      errors,
      userMessages,
      assistantMessages,
      systemMessages,
      commandExecutions,
      uniqueTools: tools.size,
    },
    fileCounts: {
      openedFiles: opened.length,
      editedFiles: edited.length,
      referencedFiles: referenced.length,
      openOps,
      editOps,
    },
    files: {
      opened,
      edited,
      referenced,
    },
    topTools,
    recentActions: recentActions
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
      .slice(0, 10),
    contextWindow,
    contextBreakdown,
    tokenUsage,
    activityDiff: {
      files: edited.map((entry) => ({
        path: entry.path,
        edits: entry.count,
        lastTs: entry.lastTs,
      })),
      totalFiles: edited.length,
    },
    generatedAt: new Date().toISOString(),
  };

  if (!persisted) return derived;

  return {
    ...derived,
    ...persisted,
    totals: persisted.totals || derived.totals,
    fileCounts: persisted.fileCounts || derived.fileCounts,
    files: persisted.files || derived.files,
    topTools: Array.isArray(persisted.topTools) ? persisted.topTools : derived.topTools,
    recentActions: Array.isArray(persisted.recentActions)
      ? persisted.recentActions
      : derived.recentActions,
    contextWindow: persisted.contextWindow || derived.contextWindow,
    contextBreakdown: Array.isArray(persisted.contextBreakdown)
      ? persisted.contextBreakdown
      : derived.contextBreakdown,
    tokenUsage: persisted.tokenUsage || derived.tokenUsage,
    activityDiff: persisted.activityDiff || derived.activityDiff,
    generatedAt: persisted.generatedAt || derived.generatedAt,
  };
}

export function buildSessionDiagnosticsBundle(fullSession = null, options = {}) {
  const session = fullSession && typeof fullSession === "object" ? fullSession : {};
  const exportedAt = toIsoString(options?.exportedAt) || new Date().toISOString();
  const insights = buildSessionInsights(session);
  const tokenUsage =
    normalizeTokenUsageShape(session?.tokenUsage)
    || normalizeTokenUsageShape(insights?.tokenUsage)
    || null;
  const contextWindow =
    insights?.contextWindow && typeof insights.contextWindow === "object"
      ? {
          usedTokens: toPositiveNumber(insights.contextWindow.usedTokens),
          totalTokens: toPositiveNumber(insights.contextWindow.totalTokens),
          percent: Number.isFinite(Number(insights.contextWindow.percent))
            ? Number(insights.contextWindow.percent)
            : null,
        }
      : null;
  const turns = (Array.isArray(session?.turns) ? session.turns : [])
    .slice(-Math.max(1, Number(options?.recentTurnLimit) || 6))
    .map((turn, index) => normalizeDiagnosticsTurn(turn, index));
  const recentMessages = (Array.isArray(session?.messages) ? session.messages : [])
    .filter((message) => {
      const type = String(message?.type || "").toLowerCase();
      return type !== "tool_result" && type !== "tool_output" && type !== "system";
    })
    .slice(-Math.max(1, Number(options?.recentMessageLimit) || 12))
    .map((message, index) => normalizeDiagnosticsMessage(message, index));

  const rawTask = options?.task && typeof options.task === "object" ? options.task : null;
  const linkedWorkflowRuns = (Array.isArray(rawTask?.workflowRuns) ? rawTask.workflowRuns : [])
    .slice(0, Math.max(1, Number(options?.workflowRunLimit) || 6))
    .map((run) => normalizeDiagnosticsWorkflowRun(run));

  const linkedTask = rawTask
    ? {
        id: pickString(rawTask.id, rawTask.taskId),
        title: pickString(rawTask.title, rawTask.taskTitle),
        status: pickString(rawTask.status),
        branch: pickString(rawTask.branch, rawTask.branchName),
        repository: pickString(rawTask.repository, rawTask.repo),
        workspace: pickString(rawTask.workspace, rawTask.meta?.workspace),
        worktreePath: pickString(rawTask.worktreePath, rawTask.meta?.worktreePath),
        primarySessionId: pickString(rawTask.primarySessionId, rawTask.sessionId, rawTask.meta?.primarySessionId),
        linkedSessionIds: Array.isArray(rawTask.linkedSessionIds)
          ? rawTask.linkedSessionIds.map((value) => String(value || "").trim()).filter(Boolean)
          : Array.isArray(rawTask.meta?.linkedSessionIds)
            ? rawTask.meta.linkedSessionIds.map((value) => String(value || "").trim()).filter(Boolean)
            : [],
      }
    : null;

  return {
    schemaVersion: 1,
    exportedAt,
    session: {
      id: pickString(session?.id, session?.sessionId),
      taskId: pickString(session?.taskId),
      title: pickString(session?.title, session?.taskTitle),
      type: pickString(session?.type) || "session",
      status: pickString(session?.status) || "unknown",
      lifecycleStatus: pickString(session?.lifecycleStatus, session?.status),
      runtimeState: pickString(session?.runtimeState, session?.status),
      runtimeIsLive:
        session?.runtimeIsLive === true
        || String(session?.runtimeState || "").trim().toLowerCase() === "running"
        || String(session?.lifecycleStatus || session?.status || "").trim().toLowerCase() === "active",
      recommendation: pickString(session?.recommendation),
      createdAt: toIsoString(session?.createdAt || session?.startedAt),
      lastActiveAt: toIsoString(session?.lastActiveAt || session?.runtimeUpdatedAt || session?.updatedAt),
      elapsedMs: toPositiveNumber(session?.elapsedMs),
      idleMs: toPositiveNumber(session?.idleMs),
      totalEvents: toPositiveNumber(session?.totalEvents) || 0,
      turnCount: toPositiveNumber(session?.turnCount) || turns.length,
      branch: pickString(session?.branch, session?.metadata?.branch),
      workflowId: pickString(session?.workflowId, session?.metadata?.workflowId),
      workflowName: pickString(session?.workflowName, session?.metadata?.workflowName),
      workspaceId: pickString(session?.workspaceId, session?.metadata?.workspaceId),
      workspaceDir: pickString(session?.workspaceDir, session?.metadata?.workspaceDir),
      workspaceRoot: pickString(session?.workspaceRoot, session?.metadata?.workspaceRoot),
      agentId: pickString(session?.agentId, session?.metadata?.agentId, session?.metadata?.agent),
      tokenUsage,
      contextWindow,
    },
    insights: {
      totals: insights?.totals || null,
      fileCounts: insights?.fileCounts || null,
      topTools: Array.isArray(insights?.topTools) ? insights.topTools : [],
      recentActions: Array.isArray(insights?.recentActions) ? insights.recentActions : [],
      activityDiff: insights?.activityDiff || null,
      contextBreakdown: Array.isArray(insights?.contextBreakdown) ? insights.contextBreakdown : [],
    },
    transcript: {
      recentTurns: turns,
      recentMessages,
    },
    linked: {
      task: linkedTask,
      workflowRuns: linkedWorkflowRuns,
    },
  };
}
