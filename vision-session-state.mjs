/**
 * vision-session-state.mjs — Shared in-memory state for live vision frames.
 *
 * Keeps the latest frame per session so voice tools can query the current
 * visual context without relying on chat-posted summaries.
 */

const _visionSessionState = new Map();

export function getVisionSessionState(sessionId) {
  const key = String(sessionId || "").trim();
  if (!key) return null;
  if (!_visionSessionState.has(key)) {
    _visionSessionState.set(key, {
      lastFrameHash: null,
      lastReceiptAt: 0,
      lastAnalyzedHash: null,
      lastAnalyzedAt: 0,
      lastSummary: "",
      inFlight: null,
      lastFrameDataUrl: "",
      lastFrameSource: "screen",
      lastFrameWidth: null,
      lastFrameHeight: null,
    });
  }
  return _visionSessionState.get(key);
}

export function clearVisionSessionState(sessionId) {
  const key = String(sessionId || "").trim();
  if (!key) return false;
  return _visionSessionState.delete(key);
}

