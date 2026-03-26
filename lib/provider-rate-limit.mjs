export function detectRateLimitInfo(error, fallbackText = "") {
  const statusCandidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.cause?.status,
  ];
  const statusCode = statusCandidates
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0) || null;

  const text = [
    String(error?.message || ""),
    String(error?.stderr || ""),
    String(error?.response?.data || ""),
    String(fallbackText || ""),
  ].filter(Boolean).join("\n");

  const isRateLimited =
    statusCode === 429 ||
    /\b429\b|rate.?limit|too many requests|quota exceeded|retry-after/i.test(text);
  if (!isRateLimited) return null;

  const retryAfterMs = parseRetryAfterMs(error, text);
  return {
    statusCode: statusCode || 429,
    retryAfterMs,
    message: text || String(error?.message || "rate limited"),
  };
}

function parseRetryAfterMs(error, text) {
  const direct =
    Number(error?.retryAfterMs) ||
    Number(error?.retryAfter) * 1000 ||
    Number(error?.response?.headers?.["retry-after"]) * 1000 ||
    Number(error?.headers?.["retry-after"]) * 1000;
  if (Number.isFinite(direct) && direct > 0) return direct;

  const match = String(text || "").match(/retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

export function emitRateLimitHit(options = {}) {
  const {
    provider,
    sessionId = null,
    taskId = "system",
    error,
    text = "",
    onProviderEvent = null,
    eventBus = null,
    extra = {},
  } = options;
  const info = detectRateLimitInfo(error, text);
  if (!info) return null;
  const payload = {
    type: "rateLimitHit",
    provider: String(provider || "unknown"),
    sessionId: sessionId || null,
    statusCode: info.statusCode || 429,
    retryAfterMs: info.retryAfterMs ?? null,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  try {
    if (typeof onProviderEvent === "function") onProviderEvent(payload);
  } catch {
  }
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit("rateLimitHit", taskId || "system", payload);
    }
  } catch {
  }
  return payload;
}
