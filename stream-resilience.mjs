/**
 * stream-resilience.mjs — Shared stream-retry helpers for all agent SDKs.
 *
 * Azure gpt-5.x (and intermittently other providers) drops live SSE streams
 * with "response.failed event received" / "stream closed before completion".
 * Neither the Codex SDK nor the Copilot SDK auto-retry these — they surface
 * the failure to the caller.
 *
 * This module provides:
 *   • isTransientStreamError(err)  — true for retriable network/stream faults
 *   • streamRetryDelay(attempt)    — exponential backoff with jitter (2–32 s)
 *   • MAX_STREAM_RETRIES           — shared retry ceiling
 */

import { loadConfig } from "./config.mjs";

function readInternalExecutorStreamConfig() {
  try {
    const cfg = loadConfig();
    const streamCfg = cfg?.internalExecutor?.stream;
    return streamCfg && typeof streamCfg === "object" ? streamCfg : {};
  } catch {
    return {};
  }
}

function parseNumericSetting({
  envKey,
  configValue,
  fallback,
  min,
  max,
  integer = true,
}) {
  const raw = process.env[envKey];
  const candidate =
    raw !== undefined && String(raw).trim() !== "" ? Number(raw) : Number(configValue);
  const normalized = Number.isFinite(candidate) ? candidate : fallback;
  const bounded = Math.min(Math.max(normalized, min), max);
  return integer ? Math.trunc(bounded) : bounded;
}

const streamConfig = readInternalExecutorStreamConfig();

/** Maximum number of stream-level retry attempts (not counting the first attempt). */
export const MAX_STREAM_RETRIES = parseNumericSetting({
  envKey: "INTERNAL_EXECUTOR_STREAM_MAX_RETRIES",
  configValue: streamConfig.maxRetries,
  fallback: 5,
  min: 1,
  max: 12,
});

/** Base backoff in ms.  Doubles per attempt: 2 s → 4 s → 8 s → 16 s → 32 s. */
const STREAM_RETRY_BASE_MS = parseNumericSetting({
  envKey: "INTERNAL_EXECUTOR_STREAM_RETRY_BASE_MS",
  configValue: streamConfig.retryBaseMs,
  fallback: 2_000,
  min: 250,
  max: 120_000,
});
const STREAM_RETRY_MAX_MS = parseNumericSetting({
  envKey: "INTERNAL_EXECUTOR_STREAM_RETRY_MAX_MS",
  configValue: streamConfig.retryMaxMs,
  fallback: 32_000,
  min: STREAM_RETRY_BASE_MS,
  max: 300_000,
});

/**
 * Returns true for transient stream / network errors that are safe to retry
 * on the same model endpoint without resetting conversation state.
 *
 * These are infrastructure-level blips — not API errors caused by bad input.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientStreamError(err) {
  const rawMessage =
    typeof err?.message === "string"
      ? err.message
      : typeof err === "string"
        ? err
        : "";
  const msg = rawMessage.toLowerCase();
  return (
    // ── Codex / Realtime API ────────────────────────────────────────────────
    msg.includes("stream disconnected") ||
    msg.includes("response.failed") ||
    msg.includes("stream closed before") ||
    msg.includes("stream ended before") ||
    msg.includes("turn.failed") ||
    // ── Network transport ───────────────────────────────────────────────────
    msg.includes("connection reset") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("network socket disconnected") ||
    msg.includes("etimedout") ||
    msg.includes("epipe") ||
    msg.includes("socket timeout") ||
    msg.includes("read econnreset") ||
    msg.includes("write econnreset") ||
    // ── HTTP-level transient failures ───────────────────────────────────────
    // Note: 502/503/504/429 are transient; 400/401/403/404 are not.
    (msg.includes("502") && !msg.includes("invalid_request")) ||
    (msg.includes("503") && !msg.includes("invalid_request")) ||
    (msg.includes("504") && !msg.includes("invalid_request")) ||
    msg.includes("bad gateway") ||
    msg.includes("service temporarily unavailable") ||
    msg.includes("service_unavailable") ||
    msg.includes("529") || // Azure overloaded
    msg.includes("rate_limit_exceeded") ||
    msg.includes("overloaded_error") // Anthropic overloaded
  );
}

/**
 * Exponential backoff delay for stream retries, with ±1 s jitter.
 *
 * attempt 0 → ~2 s
 * attempt 1 → ~4 s
 * attempt 2 → ~8 s
 * attempt 3 → ~16 s
 * attempt 4 → ~32 s (capped)
 *
 * @param {number} attempt  zero-based retry index
 * @returns {number}  delay in milliseconds
 */
export function streamRetryDelay(attempt) {
  const base = Math.min(STREAM_RETRY_BASE_MS * 2 ** attempt, STREAM_RETRY_MAX_MS);
  return base + Math.random() * 1_000;
}
