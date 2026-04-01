export const SESSION_RETENTION_MS = 10_000;

const TERMINAL_SESSION_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "stuck",
  "idle",
  "archived",
]);

const STATUS_COLOR_MAP = new Map([
  ["active", "green"],
  ["running", "green"],
  ["todo", "yellow"],
  ["queued", "yellow"],
  ["pending", "yellow"],
  ["error", "red"],
  ["failed", "red"],
  ["stuck", "red"],
  ["stalled", "red"],
  ["rework", "magenta"],
  ["paused", "gray"],
  ["completed", "gray"],
  ["idle", "gray"],
  ["archived", "gray"],
]);

function normalizeIsoTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function toTimestamp(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const date = new Date(String(value || ""));
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : fallback;
}

function normalizeSession(session = {}) {
  const normalized = { ...session };
  normalized.id = String(session.id || session.taskId || "").trim();
  normalized.status = String(session.status || session.stage || "queued").trim().toLowerCase();
  normalized.stage = String(session.stage || session.status || "queued").trim();
  normalized.createdAt = normalizeIsoTime(session.createdAt || session.startedAt || session.lastActiveAt);
  normalized.lastActiveAt = normalizeIsoTime(session.lastActiveAt || session.updatedAt || session.createdAt);
  normalized.endedAt = normalizeIsoTime(session.endedAt || "");
  normalized.title = String(
    session.title ||
      session.taskTitle ||
      session.sessionName ||
      session.taskId ||
      session.id ||
      "",
  ).trim();
  normalized.lastMessage = String(
    session.lastMessage || session.preview || session.event || session.message || "",
  ).trim();
  normalized.turnCount = Number(session.turnCount || 0) || 0;
  normalized.elapsedMs = Number(session.elapsedMs || 0) || 0;
  normalized.pid = String(
    session.pid || session.processId || session.metadata?.pid || session.metadata?.processId || "",
  ).trim();
  normalized.sdk = String(
    session.sdk || session.metadata?.sdk || session.metadata?.agent || session.agent || "",
  ).trim();
  normalized.model = String(session.model || session.metadata?.model || "").trim();
  normalized.workspaceId = String(
    session.workspaceId || session.metadata?.workspaceId || "",
  ).trim();
  normalized.workspaceDir = String(
    session.workspaceDir || session.metadata?.workspaceDir || "",
  ).trim();
  normalized.branch = String(session.branch || session.metadata?.branch || "").trim();
  normalized.recommendation = String(session.recommendation || "none").trim().toLowerCase();
  normalized.lastToolName = String(session.lastToolName || session.runtimeHealth?.lastToolName || "").trim();
  normalized.contextUsagePercent = Number(
    session.contextUsagePercent ?? session.contextWindow?.percent ?? NaN,
  );
  normalized.contextPressure = String(
    session.contextPressure || session.runtimeHealth?.contextPressure || "",
  ).trim().toLowerCase();
  normalized.runtimeHealth = session.runtimeHealth && typeof session.runtimeHealth === "object"
    ? { ...session.runtimeHealth }
    : {};
  normalized.topTools = Array.isArray(session.topTools) ? session.topTools : [];
  normalized.recentActions = Array.isArray(session.recentActions) ? session.recentActions : [];
  return normalized;
}

function isTerminalStatus(status) {
  return TERMINAL_SESSION_STATUSES.has(String(status || "").trim().toLowerCase());
}

function getOrderingTimestamp(session) {
  return toTimestamp(
    session.lastActiveAt || session.createdAt || session.endedAt,
    0,
  );
}

export function reconcileSessionEntries(previousEntries = [], incomingSessions = [], now = Date.now()) {
  const prevById = new Map(
    (Array.isArray(previousEntries) ? previousEntries : [])
      .filter((entry) => entry?.id)
      .map((entry) => [entry.id, entry]),
  );
  const nextById = new Map();

  for (const rawSession of Array.isArray(incomingSessions) ? incomingSessions : []) {
    const session = normalizeSession(rawSession);
    if (!session.id) continue;
    const retainedUntil = isTerminalStatus(session.status) ? now + SESSION_RETENTION_MS : null;
    nextById.set(session.id, {
      id: session.id,
      session,
      retainedUntil,
      isRetained: false,
      orderTs: getOrderingTimestamp(session),
    });
  }

  for (const previous of prevById.values()) {
    if (!previous?.id || nextById.has(previous.id)) continue;
    if (Number(previous.retainedUntil || 0) > now) {
      nextById.set(previous.id, {
        ...previous,
        isRetained: true,
      });
    }
  }

  return Array.from(nextById.values()).sort((left, right) => {
    if ((right.orderTs || 0) !== (left.orderTs || 0)) {
      return (right.orderTs || 0) - (left.orderTs || 0);
    }
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
}

export function getStatusColor(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return STATUS_COLOR_MAP.get(normalized) || "white";
}

export function getPressureColor(pressure) {
  const normalized = String(pressure || "").trim().toLowerCase();
  if (normalized === "critical") return "red";
  if (normalized === "high") return "yellow";
  if (normalized === "medium") return "cyan";
  return "gray";
}

function truncateText(text, maxWidth, { ellipsis = false } = {}) {
  const value = String(text || "");
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return "";
  if (value.length <= maxWidth) return value.padEnd(maxWidth, " ");
  if (!ellipsis || maxWidth < 2) return value.slice(0, maxWidth);
  return `${value.slice(0, Math.max(0, maxWidth - 1))}…`;
}

function formatCompactNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) {
    return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  }
  if (n >= 1_000) {
    return `${Math.round((n / 1_000) * 10) / 10}K`;
  }
  return String(Math.round(n));
}

function formatAge(elapsedMs) {
  const safe = Math.max(0, Number(elapsedMs || 0));
  const totalSeconds = Math.floor(safe / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays > 0) return `${totalDays}d`;
  if (totalHours > 0) return `${totalHours}h`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return `${Math.max(0, totalSeconds)}s`;
}

function resolveTokenSummary(session) {
  const contextWindow = session?.insights?.contextWindow;
  if (contextWindow?.usedTokens || contextWindow?.totalTokens) {
    const used = formatCompactNumber(contextWindow.usedTokens || 0);
    const total = formatCompactNumber(contextWindow.totalTokens || 0);
    return total !== "0" ? `${used}/${total}` : used;
  }
  const usage = session?.usage;
  if (usage?.total || usage?.totalTokens) {
    return formatCompactNumber(usage.total || usage.totalTokens);
  }
  if (session?.tokenCount) {
    return formatCompactNumber(session.tokenCount);
  }
  return "-";
}

function formatContextSummary(session) {
  const percent = Number(session?.contextUsagePercent);
  if (!Number.isFinite(percent) || percent <= 0) {
    return session?.contextPressure === "critical"
      ? "crit"
      : session?.contextPressure === "high"
        ? "high"
        : "-";
  }
  const rounded = Math.max(0, Math.min(999, Math.round(percent)));
  const suffix = session?.contextPressure === "critical"
    ? "!"
    : session?.contextPressure === "high"
      ? "*"
      : "";
  return `${rounded}%${suffix}`;
}

function formatRecommendation(recommendation) {
  const normalized = String(recommendation || "").trim().toLowerCase();
  if (!normalized || normalized === "none") return "-";
  return normalized.replaceAll("_", "-");
}

function formatProcessSummary(session) {
  const parts = [];
  if (session?.pid) parts.push(session.pid);
  if (session?.sdk) parts.push(session.sdk);
  else if (session?.model) parts.push(session.model);
  return parts.length ? parts.join("/") : "-";
}

function formatStateSummary(session) {
  const runtimeState = String(session?.runtimeHealth?.state || "").trim();
  return runtimeState || session?.stage || session?.status || "-";
}

function formatTopToolSummary(session) {
  const topTool = Array.isArray(session?.topTools) ? session.topTools[0] : null;
  if (topTool?.name) {
    const count = Number(topTool.count || 0);
    return count > 0 ? `${topTool.name}:${count}` : topTool.name;
  }
  return session?.lastToolName || "-";
}

export function projectSessionRow(session, now = Date.now(), eventWidth = 32) {
  const normalized = normalizeSession(session);
  const elapsedFromClock = Math.max(
    0,
    now - toTimestamp(normalized.createdAt || normalized.lastActiveAt, now),
  );
  const elapsedMs = Math.max(normalized.elapsedMs, elapsedFromClock);
  const sessionLabel = normalized.title || normalized.workspaceId || normalized.id;
  const stateText = truncateText(formatStateSummary(normalized), 12);
  const pidText = truncateText(normalized.pid || "-", 8);
  const processText = truncateText(formatProcessSummary(normalized), 12);
  return {
    id: normalized.id,
    isDimmed:
      normalized.status === "completed" ||
      normalized.status === "idle" ||
      normalized.status === "archived",
    statusColor: getStatusColor(normalized.status),
    pressureColor: getPressureColor(normalized.contextPressure),
    statusDot: "●",
    idText: truncateText(normalized.id.slice(0, 8), 8),
    stateText,
    stageText: stateText,
    pidText,
    processText,
    contextText: truncateText(formatContextSummary(normalized), 9),
    recommendationText: truncateText(formatRecommendation(normalized.recommendation), 10),
    ageTurnText: truncateText(`${formatAge(elapsedMs)}/${normalized.turnCount || 0}`, 10),
    tokensText: truncateText(resolveTokenSummary(normalized), 11),
    toolText: truncateText(formatTopToolSummary(normalized), 14),
    sessionText: truncateText(sessionLabel, 14),
    eventText: truncateText(normalized.lastMessage || normalized.title || "-", eventWidth, {
      ellipsis: true,
    }),
  };
}

export function formatRetryQueueCountdown(item = {}, now = Date.now()) {
  const attempt = Number(item.retryCount || item.attempt || item.retryAttempt || 0) || 0;
  const nextRetryAt = toTimestamp(item.nextRetryAt || item.cooldownUntil, 0);
  const remainingMs = Math.max(0, nextRetryAt - now);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const countdown = remainingSeconds > 60
    ? `${Math.ceil(remainingSeconds / 60)}m`
    : `${remainingSeconds}s`;
  return `attempt ${attempt} · ${countdown}`;
}

export function buildOsc52CopySequence(value) {
  const payload = Buffer.from(String(value || ""), "utf8").toString("base64");
  return `\u001b]52;c;${payload}\u0007`;
}
