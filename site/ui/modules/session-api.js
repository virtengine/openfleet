/*
 * Session API path helpers.
 * Keeps workspace scoping explicit for /api/sessions/:id routes.
 */

export const SESSION_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 1500,
  maxDelayMs: 20000,
  backoffMultiplier: 2,
});

function normalizeRetryNumber(value, fallback, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function normalizeIsoTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return null;
  return date.toISOString();
}

function defaultFormatDate(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function defaultFormatRelative(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  const diffMs = Date.now() - timestamp;
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeStaleReason(reason) {
  if (reason && typeof reason === "object") {
    const code = String(reason.code || reason.type || "").trim() || null;
    const message = String(
      reason.message || reason.detail || reason.reason || reason.error || "",
    ).trim() || null;
    return { code, message };
  }
  const message = String(reason || "").trim() || null;
  return { code: null, message };
}

function titleCaseWords(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildStaleReasonLabel(code, message) {
  const normalizedCode = String(code || "").trim().toLowerCase();
  if (normalizedCode === "offline") return "Browser offline";
  if (normalizedCode === "request_failed") return "Refresh request failed";
  if (normalizedCode === "timeout") return "Refresh timed out";
  if (normalizedCode === "server_error") return "Server error";
  if (normalizedCode) return titleCaseWords(normalizedCode.replace(/[-_]+/g, " "));
  if (message) return "Refresh request failed";
  return "Unknown refresh issue";
}

function normalizeStaleReasonMeta(reason, overrides = {}) {
  const normalized = normalizeStaleReason(reason);
  const code = normalized.code || null;
  const message = normalized.message || null;
  const overrideLabel = String(overrides?.label || "").trim() || null;
  if (!code && !message && !overrideLabel) return null;
  const label = overrideLabel || buildStaleReasonLabel(code, message);
  return { code, message, label };
}

function resolveRetryConfig(meta = {}) {
  const maxAttempts = normalizeRetryNumber(
    meta.maxAttempts,
    SESSION_RETRY_DEFAULTS.maxAttempts,
    1,
  );
  const baseDelayMs = normalizeRetryNumber(
    meta.baseDelayMs,
    SESSION_RETRY_DEFAULTS.baseDelayMs,
    1,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    normalizeRetryNumber(meta.maxDelayMs, SESSION_RETRY_DEFAULTS.maxDelayMs, 1),
  );
  const backoffMultiplier = Math.max(
    1,
    Number(meta.backoffMultiplier || SESSION_RETRY_DEFAULTS.backoffMultiplier),
  );
  return { maxAttempts, baseDelayMs, maxDelayMs, backoffMultiplier };
}

export function createSessionLoadMeta(overrides = {}) {
  const config = resolveRetryConfig(overrides);
  const staleReasonMeta = normalizeStaleReasonMeta(
    overrides?.staleReasonMeta && typeof overrides.staleReasonMeta === "object"
      ? overrides.staleReasonMeta
      : overrides?.staleReason && typeof overrides.staleReason === "object"
        ? overrides.staleReason
        : {
            code: overrides?.staleReasonCode,
            message: overrides?.staleReason,
            label: overrides?.staleReasonLabel,
          },
  );
  const staleReason = normalizeStaleReason(
    overrides?.staleReason && typeof overrides.staleReason === "object"
      ? overrides.staleReason
      : {
          code: overrides?.staleReasonCode,
          message: overrides?.staleReason,
        },
  );
  return {
    ...config,
    stale: Boolean(overrides?.stale),
    lastSuccessAt: normalizeIsoTimestamp(overrides?.lastSuccessAt),
    lastFailureAt: normalizeIsoTimestamp(overrides?.lastFailureAt),
    staleReason: staleReasonMeta?.message || staleReason.message,
    staleReasonCode: staleReasonMeta?.code || staleReason.code,
    staleReasonLabel: staleReasonMeta?.label || null,
    staleReasonMeta,
    retryAttempt: normalizeRetryNumber(overrides?.retryAttempt, 0, 0),
    retryDelayMs: normalizeRetryNumber(overrides?.retryDelayMs, 0, 0),
    nextRetryAt: normalizeIsoTimestamp(overrides?.nextRetryAt),
    retriesExhausted: Boolean(overrides?.retriesExhausted),
  };
}

export function getSessionRetryDelayMs(attemptNumber, meta = {}) {
  const { baseDelayMs, maxDelayMs, backoffMultiplier } = resolveRetryConfig(meta);
  const attempt = Math.max(1, normalizeRetryNumber(attemptNumber, 1, 1));
  const delay = Math.round(baseDelayMs * Math.pow(backoffMultiplier, attempt - 1));
  return Math.min(maxDelayMs, Math.max(baseDelayMs, delay));
}

export function formatSessionFreshnessTimestamp(lastSuccessAt, formatters = {}) {
  if (!lastSuccessAt) return "unknown";
  const formatRelative =
    typeof formatters?.formatRelative === "function"
      ? formatters.formatRelative
      : defaultFormatRelative;
  const formatDate =
    typeof formatters?.formatDate === "function"
      ? formatters.formatDate
      : defaultFormatDate;
  const relative = String(formatRelative(lastSuccessAt) || "").trim();
  const absolute = String(formatDate(lastSuccessAt) || "").trim();
  if (relative && absolute && relative !== absolute) {
    return `${relative} (${absolute})`;
  }
  return relative || absolute || "unknown";
}

export function deriveSessionStaleReason(error) {
  if (typeof navigator !== "undefined" && navigator?.onLine === false) {
    return {
      code: "offline",
      message: "Browser appears to be offline.",
    };
  }
  const raw = String(error?.message || error || "").trim();
  if (!raw) {
    return {
      code: "request_failed",
      message: "Last refresh failed before new session data could be loaded.",
    };
  }
  try {
    const parsed = JSON.parse(raw);
    const message = String(parsed?.error || parsed?.message || "").trim();
    if (message) {
      return {
        code: String(parsed?.code || "request_failed").trim() || "request_failed",
        message,
      };
    }
  } catch {
    // Raw string error; preserve it as operator-facing context.
  }
  return {
    code: "request_failed",
    message: raw,
  };
}

export function getSessionManualRetryState(meta, options = {}) {
  const now = Number(options?.now || Date.now()) || Date.now();
  if (options?.isLoading) {
    return {
      disabled: true,
      label: "Refreshing…",
      reason: "Refresh already in progress.",
      retrySeconds: 0,
      backoffActive: false,
    };
  }
  const loadMeta = createSessionLoadMeta(meta || {});
  const nextRetryAt = Date.parse(String(loadMeta.nextRetryAt || ""));
  const backoffActive =
    !loadMeta.retriesExhausted && Number.isFinite(nextRetryAt) && nextRetryAt > now;
  if (backoffActive) {
    const retrySeconds = Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
    return {
      disabled: true,
      label: retrySeconds > 0 ? `Retry in ${retrySeconds}s` : "Retry locked",
      reason: "Manual retry is disabled while automatic backoff is active.",
      retrySeconds,
      backoffActive: true,
    };
  }
  return {
    disabled: false,
    label: "Retry now",
    reason: "",
    retrySeconds: 0,
    backoffActive: false,
  };
}

export function markSessionLoadSuccess(previousMeta, now = Date.now()) {
  const meta = createSessionLoadMeta(previousMeta || {});
  return {
    ...meta,
    stale: false,
    lastSuccessAt: normalizeIsoTimestamp(now) || new Date().toISOString(),
    retryAttempt: 0,
    retryDelayMs: 0,
    nextRetryAt: null,
    retriesExhausted: false,
    staleReason: null,
    staleReasonCode: null,
    staleReasonLabel: null,
    staleReasonMeta: null,
  };
}

export function markSessionLoadFailure(previousMeta, now = Date.now(), options = {}) {
  const meta = createSessionLoadMeta(previousMeta || {});
  const retryAttempt = normalizeRetryNumber(meta.retryAttempt, 0, 0) + 1;
  const retriesExhausted = retryAttempt > meta.maxAttempts;
  const retryDelayMs = retriesExhausted
    ? 0
    : getSessionRetryDelayMs(retryAttempt, meta);
  const staleReasonMeta = normalizeStaleReasonMeta(
    options?.staleReason ?? options?.reason ?? {
      code: options?.staleReasonCode,
      message: options?.message,
    },
  );
  return {
    ...meta,
    stale: true,
    lastFailureAt: meta.lastFailureAt || normalizeIsoTimestamp(now) || new Date().toISOString(),
    staleReason: staleReasonMeta?.message || meta.staleReason || null,
    staleReasonCode: staleReasonMeta?.code || meta.staleReasonCode || null,
    staleReasonLabel: staleReasonMeta?.label || meta.staleReasonLabel || null,
    staleReasonMeta: staleReasonMeta || meta.staleReasonMeta || null,
    retryAttempt,
    retryDelayMs,
    nextRetryAt: retriesExhausted ? null : new Date(new Date(now).getTime() + retryDelayMs).toISOString(),
    retriesExhausted,
  };
}

export function resetSessionRetryMeta(previousMeta) {
  const meta = createSessionLoadMeta(previousMeta || {});
  return {
    ...meta,
    retryAttempt: 0,
    retryDelayMs: 0,
    nextRetryAt: null,
    retriesExhausted: false,
  };
}

function normalizeWorkspaceHint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "all" || lower === "*") return "all";
  if (lower === "active") return "active";
  return raw;
}

export function resolveSessionWorkspaceHint(session, fallback = "active") {
  const direct = String(session?.workspaceId || session?.workspace || "").trim();
  if (direct) return normalizeWorkspaceHint(direct);
  const metadata =
    session?.metadata && typeof session.metadata === "object"
      ? session.metadata
      : null;
  const fromMetadata = String(metadata?.workspaceId || "").trim();
  if (fromMetadata) return normalizeWorkspaceHint(fromMetadata);
  return normalizeWorkspaceHint(fallback);
}

export function buildSessionApiPath(sessionId, action = "", opts = {}) {
  const safeId = encodeURIComponent(String(sessionId || "").trim());
  if (!safeId) return "";
  const suffix = action ? `/${String(action || "").trim()}` : "";
  const path = `/api/sessions/${safeId}${suffix}`;
  const params = new URLSearchParams();

  const workspace = normalizeWorkspaceHint(opts?.workspace);
  if (workspace) params.set("workspace", workspace);

  if (opts?.query && typeof opts.query === "object") {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value == null) continue;
      const stringValue = String(value).trim();
      if (!stringValue) continue;
      params.set(key, stringValue);
    }
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}




