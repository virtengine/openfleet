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
  return {
    ...config,
    stale: Boolean(overrides?.stale),
    lastSuccessAt: overrides?.lastSuccessAt ? String(overrides.lastSuccessAt) : null,
    retryAttempt: normalizeRetryNumber(overrides?.retryAttempt, 0, 0),
    retryDelayMs: normalizeRetryNumber(overrides?.retryDelayMs, 0, 0),
    nextRetryAt: overrides?.nextRetryAt ? String(overrides.nextRetryAt) : null,
    retriesExhausted: Boolean(overrides?.retriesExhausted),
  };
}

export function getSessionRetryDelayMs(attemptNumber, meta = {}) {
  const { baseDelayMs, maxDelayMs, backoffMultiplier } = resolveRetryConfig(meta);
  const attempt = Math.max(1, normalizeRetryNumber(attemptNumber, 1, 1));
  const delay = Math.round(baseDelayMs * Math.pow(backoffMultiplier, attempt - 1));
  return Math.min(maxDelayMs, Math.max(baseDelayMs, delay));
}

export function markSessionLoadSuccess(previousMeta, now = Date.now()) {
  const meta = createSessionLoadMeta(previousMeta || {});
  return {
    ...meta,
    stale: false,
    lastSuccessAt: new Date(now).toISOString(),
    retryAttempt: 0,
    retryDelayMs: 0,
    nextRetryAt: null,
    retriesExhausted: false,
  };
}

export function markSessionLoadFailure(previousMeta, now = Date.now()) {
  const meta = createSessionLoadMeta(previousMeta || {});
  const retryAttempt = normalizeRetryNumber(meta.retryAttempt, 0, 0) + 1;
  const retriesExhausted = retryAttempt > meta.maxAttempts;
  const retryDelayMs = retriesExhausted
    ? 0
    : getSessionRetryDelayMs(retryAttempt, meta);
  return {
    ...meta,
    stale: true,
    retryAttempt,
    retryDelayMs,
    nextRetryAt: retriesExhausted ? null : new Date(now + retryDelayMs).toISOString(),
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
