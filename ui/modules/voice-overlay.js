/**
 * voice-overlay.js — Full-screen ChatGPT-style voice mode overlay.
 *
 * States: idle, connecting, listening, thinking, speaking, error, reconnecting
 * Features: voice orb visualization, transcript display, tool call cards,
 *          close/minimize, barge-in support.
 *
 * @module voice-overlay
 */

import { h } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import htm from "htm";
import { haptic } from "./telegram.js";
import { apiFetch, onWsMessage } from "./api.js";
import {
  voiceState, voiceTranscript, voiceResponse, voiceError,
  voiceToolCalls, voiceDuration,
  startVoiceSession, stopVoiceSession, interruptResponse,
  sendTextMessage, onVoiceEvent, resumeVoiceAudio,
} from "./voice-client.js";
import {
  sdkVoiceState, sdkVoiceTranscript, sdkVoiceResponse, sdkVoiceError,
  sdkVoiceToolCalls, sdkVoiceDuration, sdkVoiceSdkActive,
  startSdkVoiceSession, stopSdkVoiceSession, interruptSdkResponse,
  sendSdkTextMessage, onSdkVoiceEvent,
} from "./voice-client-sdk.js";
import {
  fallbackState, fallbackTranscript, fallbackResponse,
  fallbackError,
  startFallbackSession, stopFallbackSession, interruptFallback,
} from "./voice-fallback.js";
import {
  visionShareState,
  visionShareSource,
  visionShareError,
  visionLastSummary,
  toggleVisionShare,
  stopVisionShare,
} from "./vision-stream.js";
import { AudioVisualizer } from "./audio-visualizer.js";
import { resolveIcon } from "./icon-utils.js";

const html = htm.bind(h);
const CHAT_UPDATE_PREFIX_RE = /^\[Chat Update [—-] [A-Z]+]:\s*/;

// ── Inject styles ───────────────────────────────────────────────────────────

let _stylesInjected = false;

function injectOverlayStyles() {
  if (_stylesInjected || typeof document === "undefined") return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.voice-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.95);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  color: #fff;
  font-family: var(--tg-theme-font, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  animation: voiceOverlayFadeIn 0.3s ease;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  overflow: hidden;
}
@keyframes voiceOverlayFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
.voice-overlay-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  z-index: 2;
}
.voice-overlay-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.voice-overlay-chat-toggle {
  height: 32px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.24);
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.95);
  font-size: 12px;
  cursor: pointer;
  padding: 0 12px;
}
.voice-overlay-chat-toggle:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.voice-overlay-call-pill {
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.2);
  padding: 3px 9px;
  color: rgba(255,255,255,0.86);
}
.voice-overlay-close {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.08);
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.voice-overlay-close:hover {
  background: rgba(255,255,255,0.15);
  border-color: rgba(255,255,255,0.3);
}
.voice-overlay-status {
  font-size: 13px;
  color: rgba(255,255,255,0.6);
  text-transform: capitalize;
}
.voice-overlay-bound {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  margin-top: 2px;
  max-width: 56vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.voice-overlay-duration {
  font-size: 12px;
  color: rgba(255,255,255,0.4);
  font-variant-numeric: tabular-nums;
}
.voice-overlay-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 32px;
  z-index: 1;
}
.voice-overlay-main {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 14px;
  padding: 76px 16px 18px;
}
.voice-overlay-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
}
.voice-overlay-chat {
  width: min(420px, 42vw);
  min-width: 300px;
  max-width: 460px;
  border-radius: 16px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(10, 10, 12, 0.78);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.voice-overlay-chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
}
.voice-overlay-chat-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.voice-overlay-chat-status {
  font-size: 11px;
  color: rgba(255,255,255,0.6);
}
.voice-overlay-chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.voice-overlay-chat-empty {
  color: rgba(255,255,255,0.6);
  text-align: center;
  font-size: 12px;
  padding: 16px 8px;
}
.voice-overlay-chat-msg {
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.08);
}
.voice-overlay-chat-msg.user {
  align-self: flex-end;
  background: rgba(59,130,246,0.24);
  border-color: rgba(59,130,246,0.38);
}
.voice-overlay-chat-msg.assistant {
  align-self: flex-start;
  background: rgba(34,197,94,0.2);
  border-color: rgba(34,197,94,0.34);
}
.voice-overlay-chat-msg.system {
  align-self: stretch;
}
.voice-overlay-chat-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: rgba(255,255,255,0.56);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.voice-overlay-chat-content {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.35;
}
.voice-overlay-chat-input-wrap {
  border-top: 1px solid rgba(255,255,255,0.1);
  padding: 10px;
  display: flex;
  gap: 8px;
}
.voice-overlay-chat-input {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 8px;
  background: rgba(255,255,255,0.06);
  color: #fff;
  padding: 8px 10px;
  font-size: 13px;
}
.voice-overlay-chat-send {
  border: none;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-size: 12px;
  padding: 0 12px;
  cursor: pointer;
}
.voice-overlay-chat-send:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}
.voice-orb-container {
  width: 200px;
  height: 200px;
  position: relative;
}
.voice-transcript-area {
  max-width: 500px;
  text-align: center;
  min-height: 60px;
}
.voice-transcript-user {
  font-size: 16px;
  color: rgba(255,255,255,0.8);
  margin-bottom: 8px;
  font-style: italic;
}
.voice-transcript-assistant {
  font-size: 18px;
  color: #fff;
  line-height: 1.5;
}
.voice-tool-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  max-width: 600px;
}
.voice-tool-card {
  padding: 6px 12px;
  border-radius: 8px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.12);
  font-size: 12px;
  color: rgba(255,255,255,0.7);
  display: flex;
  align-items: center;
  gap: 6px;
}
.voice-tool-card.running {
  border-color: rgba(59, 130, 246, 0.5);
  color: #60a5fa;
}
.voice-tool-card.complete {
  border-color: rgba(34, 197, 94, 0.5);
  color: #4ade80;
}
.voice-tool-card.error {
  border-color: rgba(239, 68, 68, 0.5);
  color: #f87171;
}
.voice-overlay-footer {
  display: flex;
  justify-content: center;
  padding: 0;
  z-index: 1;
}
.voice-end-btn {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: none;
  background: #ef4444;
  color: #fff;
  font-size: 24px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
}
.voice-end-btn:hover {
  transform: scale(1.05);
  box-shadow: 0 6px 28px rgba(239, 68, 68, 0.5);
}
.voice-overlay-vision-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}
.voice-vision-btn {
  min-width: 84px;
  height: 32px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.25);
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.9);
  font-size: 12px;
  cursor: pointer;
  padding: 0 12px;
}
.voice-vision-btn.active {
  border-color: rgba(74, 222, 128, 0.8);
  background: rgba(34, 197, 94, 0.2);
  color: #bbf7d0;
}
.voice-vision-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.voice-vision-status {
  margin-top: 8px;
  max-width: 560px;
  text-align: center;
  font-size: 12px;
  color: rgba(255,255,255,0.58);
}
.voice-error-msg {
  color: #f87171;
  font-size: 14px;
  text-align: center;
  max-width: 400px;
}
.voice-connecting-dots {
  display: flex;
  gap: 8px;
}
.voice-connecting-dots span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(255,255,255,0.4);
  animation: voiceDotPulse 1.4s ease infinite;
}
.voice-connecting-dots span:nth-child(2) { animation-delay: 0.2s; }
.voice-connecting-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes voiceDotPulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.2); }
}
@media (max-width: 980px) {
  .voice-overlay-main {
    padding: 74px 12px 14px;
    flex-direction: column;
    gap: 12px;
  }
  .voice-overlay-chat {
    width: 100%;
    min-width: 0;
    max-width: none;
    max-height: 44vh;
  }
  .voice-overlay-center {
    gap: 18px;
  }
  .voice-orb-container {
    width: 162px;
    height: 162px;
  }
}
.voice-overlay.compact {
  background: rgba(0, 0, 0, 0.93);
}
.voice-overlay.compact .voice-overlay-header {
  padding: 12px 14px;
}
.voice-overlay.compact .voice-overlay-main {
  padding: 62px 10px 10px;
  flex-direction: column;
  gap: 10px;
}
.voice-overlay.compact .voice-overlay-stage {
  gap: 12px;
}
.voice-overlay.compact .voice-overlay-center {
  gap: 12px;
}
.voice-overlay.compact .voice-orb-container {
  width: 138px;
  height: 138px;
}
.voice-overlay.compact .voice-transcript-area {
  max-width: none;
  width: 100%;
  min-height: 46px;
}
.voice-overlay.compact .voice-transcript-user {
  font-size: 14px;
}
.voice-overlay.compact .voice-transcript-assistant {
  font-size: 15px;
  line-height: 1.4;
}
.voice-overlay.compact .voice-tool-cards {
  max-width: none;
}
.voice-overlay.compact .voice-overlay-chat {
  width: 100%;
  min-width: 0;
  max-width: none;
  max-height: 44vh;
}
.voice-overlay.compact .voice-end-btn {
  width: 56px;
  height: 56px;
  font-size: 20px;
}
.voice-overlay.compact .voice-overlay-chat-toggle {
  display: none;
}
.voice-overlay.compact .voice-overlay-stage {
  display: none;
}
.voice-overlay.compact .voice-overlay-chat.follow-feed {
  width: 100%;
  max-width: none;
  min-width: 0;
  max-height: none;
  height: calc(100vh - 150px);
}
.voice-overlay.compact .voice-overlay-chat.follow-feed .voice-overlay-chat-head {
  padding: 10px 12px;
}
.voice-overlay.compact .voice-overlay-chat.follow-feed .voice-overlay-chat-title {
  font-size: 12px;
  letter-spacing: 0.01em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.72);
}
.voice-overlay.compact .voice-overlay-chat.follow-feed .voice-overlay-chat-status {
  font-size: 11px;
}
.voice-overlay.compact .voice-overlay-chat.follow-feed .voice-overlay-chat-body {
  padding: 8px 10px 10px;
  gap: 6px;
}
.voice-overlay.compact .voice-overlay-chat.follow-feed .voice-overlay-chat-msg {
  padding: 8px;
  border-radius: 10px;
}
.voice-overlay.compact .voice-overlay-chat.follow-feed .voice-overlay-chat-content {
  font-size: 12px;
  line-height: 1.35;
}
.voice-overlay.compact .voice-overlay-chat-live {
  margin: 6px 10px 0;
  border: 1px solid rgba(255,255,255,0.16);
  background: rgba(255,255,255,0.06);
  border-radius: 10px;
  padding: 8px;
  font-size: 12px;
  line-height: 1.35;
  color: rgba(255,255,255,0.9);
}
.voice-overlay.compact .voice-overlay-chat-live.user {
  border-color: rgba(96,165,250,0.45);
}
.voice-overlay.compact .voice-overlay-chat-live.assistant {
  border-color: rgba(74,222,128,0.45);
}
.voice-overlay.compact .voice-overlay-chat-input-wrap {
  display: none;
}
.voice-overlay.compact .voice-overlay-footer {
  padding: 8px 0 10px;
}
  `;
  document.head.appendChild(style);
}

// ── Format Duration ─────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function normalizeMeetingMessageRole(msg) {
  const roleRaw = String(
    msg?.role ||
      (msg?.type === "tool_call" || msg?.type === "tool_result"
        ? "system"
        : "assistant"),
  )
    .trim()
    .toLowerCase();
  if (roleRaw === "user" || roleRaw === "assistant") return roleRaw;
  return "system";
}

function stringifyMeetingMessageContent(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (msg?.content == null) return "";
  try {
    return JSON.stringify(msg.content);
  } catch {
    return String(msg.content);
  }
}

function shouldSuppressCompactMeetingMessage(role, text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (role === "system") return true;
  if (/^reconnecting\.\.\./i.test(value)) return true;
  if (/stream disconnected before completion/i.test(value)) return true;
  if (/^turn completed$/i.test(value)) return true;
  if (/^\*\*/.test(value)) return true;
  return false;
}

// ── Voice Overlay Component ─────────────────────────────────────────────────

/**
 * @param {{
 * visible: boolean,
 * onClose: () => void,
 * onDismiss?: () => void,
 * compact?: boolean,
 * tier: number,
 * sessionId?: string,
 * executor?: string,
 * mode?: string,
 * model?: string,
 * callType?: "voice" | "video",
 * initialVisionSource?: "camera" | "screen" | null
 * }} props
 */
export function VoiceOverlay({
  visible,
  onClose,
  onDismiss,
  compact = false,
  tier = 1,
  sessionId,
  executor,
  mode,
  model,
  callType = "voice",
  initialVisionSource = null,
}) {
  const isCompactFollowMode = compact === true;
  const [started, setStarted] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [meetingMessages, setMeetingMessages] = useState([]);
  const [meetingChatInput, setMeetingChatInput] = useState("");
  const [meetingChatSending, setMeetingChatSending] = useState(false);
  const [meetingChatLoading, setMeetingChatLoading] = useState(false);
  const [meetingChatError, setMeetingChatError] = useState(null);
  const autoVisionAppliedRef = useRef(false);
  const meetingScrollRef = useRef(null);
  const [usingSdk, setUsingSdk] = useState(false);
  const sdkFallbackCleanupRef = useRef(null);
  const legacyFallbackCleanupRef = useRef(null);
  const autoFallbackTriedRef = useRef(false);

  useEffect(() => { injectOverlayStyles(); }, []);

  // Determine effective tier: SDK takes over tier 1 when active
  const effectiveSdk = usingSdk && sdkVoiceSdkActive.value;

  // Use computed signals based on tier — SDK overrides tier 1 when active
  const state = effectiveSdk
    ? sdkVoiceState.value
    : tier === 1 ? voiceState.value : fallbackState.value;
  const transcript = effectiveSdk
    ? sdkVoiceTranscript.value
    : tier === 1 ? voiceTranscript.value : fallbackTranscript.value;
  const response = effectiveSdk
    ? sdkVoiceResponse.value
    : tier === 1 ? voiceResponse.value : fallbackResponse.value;
  const error = effectiveSdk
    ? sdkVoiceError.value
    : tier === 1 ? voiceError.value : fallbackError.value;
  const toolCalls = effectiveSdk
    ? sdkVoiceToolCalls.value
    : tier === 1 ? voiceToolCalls.value : [];
  const duration = effectiveSdk
    ? sdkVoiceDuration.value
    : tier === 1 ? voiceDuration.value : 0;
  const visionState = visionShareState.value;
  const visionSource = visionShareSource.value;
  const visionErr = visionShareError.value;
  const latestVisionSummary = visionLastSummary.value;
  const canShareVision = Boolean(sessionId);
  const normalizedCallType =
    String(callType || "").trim().toLowerCase() === "video"
      ? "video"
      : "voice";
  const normalizedInitialVisionSource = (() => {
    const source = String(initialVisionSource || "").trim().toLowerCase();
    if (source === "camera" || source === "screen") return source;
    return normalizedCallType === "video" ? "camera" : null;
  })();

  // Start session on mount — try Agents SDK first, fallback to legacy
  useEffect(() => {
    if (!visible || started) return;
    setStarted(true);
    autoFallbackTriedRef.current = false;
    let legacyFallbackStarted = false;

    const startLegacyFallbackOnce = () => {
      if (legacyFallbackStarted) return;
      legacyFallbackStarted = true;
      setUsingSdk(false);
      startVoiceSession({ sessionId, executor, mode, model });
    };

    if (tier === 1) {
      // Try SDK-first for tier 1
      startSdkVoiceSession({ sessionId, executor, mode, model })
        .then((result) => {
          if (result.sdk) {
            setUsingSdk(true);
          } else {
            // SDK not available — fallback to legacy WebRTC
            startLegacyFallbackOnce();
          }
        })
        .catch(() => {
          // SDK threw unexpectedly — fallback to legacy
          startLegacyFallbackOnce();
        });

      // Listen for SDK runtime failures to auto-fallback
      const cleanup = onSdkVoiceEvent("sdk-unavailable", () => {
        startLegacyFallbackOnce();
      });
      sdkFallbackCleanupRef.current = cleanup;
    } else if (sessionId) {
      startFallbackSession(sessionId, { executor, mode, model });
    }
  }, [visible, started, tier, sessionId, executor, mode, model]);

  useEffect(() => {
    if (!visible || !started || tier !== 1 || !sessionId) return;
    const cleanup = onVoiceEvent("error", () => {
      if (usingSdk) return;
      if (autoFallbackTriedRef.current) return;
      autoFallbackTriedRef.current = true;
      try { stopVoiceSession(); } catch { /* best effort */ }
      startFallbackSession(sessionId, { executor, mode, model });
    });
    legacyFallbackCleanupRef.current = cleanup;
    return cleanup;
  }, [visible, started, tier, sessionId, executor, mode, model, usingSdk]);

  useEffect(() => {
    if (visible) return;
    stopVisionShare().catch(() => {});
  }, [visible]);

  useEffect(() => {
    if (visible) return;
    autoVisionAppliedRef.current = false;
  }, [visible]);

  const loadMeetingMessages = useCallback(async () => {
    const activeSessionId = String(sessionId || "").trim();
    if (!activeSessionId) {
      setMeetingMessages([]);
      setMeetingChatError(null);
      return;
    }
    const safeSessionId = encodeURIComponent(activeSessionId);
    const response = await apiFetch(`/api/sessions/${safeSessionId}?limit=80`, {
      _silent: true,
      _trackLoading: false,
    });
    const nextMessages = Array.isArray(response?.session?.messages)
      ? response.session.messages
      : [];
    setMeetingMessages(nextMessages);
    setMeetingChatError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!visible || !chatOpen || !sessionId) return;
    let cancelled = false;

    const refresh = async (isInitial = false) => {
      if (isInitial) setMeetingChatLoading(true);
      try {
        await loadMeetingMessages();
      } catch (err) {
        if (!cancelled) {
          setMeetingChatError(
            String(err?.message || "Could not refresh meeting chat"),
          );
        }
      } finally {
        if (isInitial && !cancelled) setMeetingChatLoading(false);
      }
    };

    refresh(true).catch(() => {});
    const timer = setInterval(() => {
      refresh(false).catch(() => {});
    }, 1600);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, chatOpen, sessionId, loadMeetingMessages]);

  useEffect(() => {
    if (!chatOpen) return;
    const el = meetingScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatOpen, meetingMessages.length]);

  // ── Live chat → voice injection ───────────────────────────────────────
  // When new messages appear in the bound session (delegation results, user
  // chat messages, progress events), inject them into the active Realtime
  // voice session so the voice agent has real-time awareness.
  const lastInjectedTsRef = useRef(0);
  useEffect(() => {
    if (!visible || !started || !sessionId) return;
    // Listen for WebSocket session-message events for the bound session
    const unsub = onWsMessage((data) => {
      if (data?.type !== "session-message") return;
      const payload = data?.payload;
      if (!payload) return;
      const msgSessionId = payload.sessionId || payload.taskId;
      if (msgSessionId !== sessionId) return;
      const msg = payload.message;
      if (!msg || !msg.content) return;
      const content = String(msg.content || "").trim();
      if (!content) return;
      // Prevent recursive injection loops from synthetic chat updates.
      if (CHAT_UPDATE_PREFIX_RE.test(content)) return;
      // Skip transcripts captured from the active voice pipeline.
      const msgSource = String(msg?.meta?.source || "").trim().toLowerCase();
      const msgEventType = String(msg?.meta?.eventType || "").trim().toLowerCase();
      if (msgSource === "voice" || msgEventType.includes("transcript")) return;
      // Avoid re-injecting old messages
      const msgTs = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
      if (msgTs <= lastInjectedTsRef.current) return;
      lastInjectedTsRef.current = msgTs;

      // Build a short context injection for the voice model
      const role = String(msg.role || msg.type || "system").toUpperCase();
      const text = `[Chat Update — ${role}]: ${content.slice(0, 800)}`;

      // Inject into the active voice session (no response.create — just context)
      if (effectiveSdk) {
        sendSdkTextMessage(text);
      } else if (tier === 1) {
        sendTextMessage(text);
      }
    });
    return unsub;
  }, [visible, started, sessionId, tier, effectiveSdk]);

  useEffect(() => {
    if (!visible || !started || !sessionId) return;
    if (!normalizedInitialVisionSource) return;
    if (autoVisionAppliedRef.current) return;
    autoVisionAppliedRef.current = true;
    toggleVisionShare(normalizedInitialVisionSource, {
      sessionId,
      executor,
      mode,
      model,
      intervalMs: 1000,
      maxWidth: normalizedInitialVisionSource === "screen" ? 1280 : 960,
      jpegQuality: normalizedInitialVisionSource === "screen" ? 0.65 : 0.62,
    }).catch(() => {
      // Keep the session running even if camera/screen permissions fail.
    });
  }, [
    visible,
    started,
    sessionId,
    normalizedInitialVisionSource,
    executor,
    mode,
    model,
  ]);

  const handleClose = useCallback(() => {
    haptic("medium");
    stopVisionShare().catch(() => {});
    // Clean up SDK fallback listener
    if (typeof sdkFallbackCleanupRef.current === "function") {
      sdkFallbackCleanupRef.current();
      sdkFallbackCleanupRef.current = null;
    }
    if (typeof legacyFallbackCleanupRef.current === "function") {
      legacyFallbackCleanupRef.current();
      legacyFallbackCleanupRef.current = null;
    }
    if (usingSdk) {
      stopSdkVoiceSession();
    } else if (tier === 1) {
      stopVoiceSession();
    } else {
      stopFallbackSession();
    }
    autoFallbackTriedRef.current = false;
    setUsingSdk(false);
    setStarted(false);
    onClose();
  }, [tier, onClose, usingSdk]);

  const handleDismiss = useCallback(() => {
    haptic("light");
    const fn = typeof onDismiss === "function" ? onDismiss : onClose;
    fn();
  }, [onDismiss, onClose]);

  const handleInterrupt = useCallback(() => {
    haptic("light");
    if (usingSdk) {
      interruptSdkResponse();
    } else if (tier === 1) {
      interruptResponse();
    } else {
      interruptFallback();
    }
  }, [tier, usingSdk]);

  const handleToggleScreenShare = useCallback(() => {
    haptic("light");
    toggleVisionShare("screen", {
      sessionId,
      executor,
      mode,
      model,
      intervalMs: 1000,
      maxWidth: 1280,
      jpegQuality: 0.65,
    }).catch(() => {});
  }, [sessionId, executor, mode, model]);

  const handleToggleCameraShare = useCallback(() => {
    haptic("light");
    toggleVisionShare("camera", {
      sessionId,
      executor,
      mode,
      model,
      intervalMs: 1000,
      maxWidth: 960,
      jpegQuality: 0.62,
    }).catch(() => {});
  }, [sessionId, executor, mode, model]);

  const handleSendMeetingChat = useCallback(async () => {
    const activeSessionId = String(sessionId || "").trim();
    const content = String(meetingChatInput || "").trim();
    if (!activeSessionId || !content || meetingChatSending) return;
    setMeetingChatSending(true);
    const safeSessionId = encodeURIComponent(activeSessionId);
    try {
      await apiFetch(`/api/sessions/${safeSessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      setMeetingChatInput("");
      await loadMeetingMessages();
    } catch (err) {
      setMeetingChatError(String(err?.message || "Could not send chat message"));
    } finally {
      setMeetingChatSending(false);
    }
  }, [
    meetingChatInput,
    meetingChatSending,
    sessionId,
    loadMeetingMessages,
  ]);

  if (!visible) return null;

  const statusLabel = state === "connected" ? "ready" : state;
  const boundLabel = [
    sessionId ? `session ${sessionId}` : null,
    executor ? `agent ${executor}` : null,
    mode ? `mode ${mode}` : null,
    model ? `model ${model}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const chatStatusLabel = meetingChatLoading
    ? "syncing"
    : meetingChatSending
      ? "sending"
      : meetingChatError
        ? "error"
        : "live";
  const meetingFeedMessages = (() => {
    const items = [];
    for (const msg of meetingMessages) {
      const role = normalizeMeetingMessageRole(msg);
      const text = stringifyMeetingMessageContent(msg);
      if (isCompactFollowMode && shouldSuppressCompactMeetingMessage(role, text)) {
        continue;
      }
      const timeRaw = String(msg?.timestamp || "").trim();
      const date = timeRaw ? new Date(timeRaw) : null;
      const timeLabel =
        date && Number.isFinite(date.getTime())
          ? date.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
      const normalizedText = String(text || "").trim();
      const prev = items.length > 0 ? items[items.length - 1] : null;
      if (
        prev
        && prev.role === role
        && prev.content === normalizedText
      ) {
        continue;
      }
      items.push({
        id: msg?.id || `${role}-${items.length}`,
        role,
        content: normalizedText,
        timeLabel,
      });
    }
    if (!isCompactFollowMode) return items;
    return items.slice(-120);
  })();
  const showMeetingChat = Boolean(sessionId) && (chatOpen || isCompactFollowMode);
  const liveTranscriptText = String(transcript || "").trim();
  const liveResponseText = String(response || "").trim();

  return html`
    <div class=${`voice-overlay${compact ? " compact" : ""}`}>
      <!-- Header -->
      <div class="voice-overlay-header">
        <button class="voice-overlay-close" onClick=${handleDismiss} title="Hide voice window">
          ${resolveIcon("close")}
        </button>
        <div>
          <div class="voice-overlay-status">${statusLabel}</div>
          ${boundLabel && html`<div class="voice-overlay-bound">${boundLabel}</div>`}
          ${duration > 0 && html`
            <div class="voice-overlay-duration">${formatDuration(duration)}</div>
          `}
        </div>
        <div class="voice-overlay-header-actions">
          <span class="voice-overlay-call-pill">
            ${normalizedCallType === "video" ? "video call" : "voice call"}
          </span>
          ${!isCompactFollowMode && html`
            <button
              class="voice-overlay-chat-toggle"
              onClick=${() => setChatOpen((prev) => !prev)}
              disabled=${!sessionId}
              title=${sessionId ? "Toggle meeting chat" : "Open a session-bound call first"}
            >
              ${chatOpen ? "Hide Chat" : "Show Chat"}
            </button>
          `}
        </div>
      </div>

      <div class="voice-overlay-main">
        <div class="voice-overlay-stage">
          <!-- Center content -->
          <div class="voice-overlay-center">
            <!-- Orb visualization -->
            <div
              class="voice-orb-container"
              onClick=${state === "speaking" ? handleInterrupt : () => resumeVoiceAudio().catch(() => {})}
            >
              <${AudioVisualizer} state=${state} />
            </div>

            ${state === "connecting" || state === "reconnecting"
              ? html`
                  <div class="voice-connecting-dots">
                    <span /><span /><span />
                  </div>
                  <div class="voice-overlay-status" style="font-size: 16px">
                    ${state === "reconnecting" ? "Reconnecting..." : "Connecting..."}
                  </div>
                `
              : null}

            ${error && html`
              <div class="voice-error-msg">${error}</div>
            `}

            <!-- Transcript area -->
            <div class="voice-transcript-area">
              ${transcript && html`
                <div class="voice-transcript-user">"${transcript}"</div>
              `}
              ${response && html`
                <div class="voice-transcript-assistant">${response}</div>
              `}
            </div>

            <div class="voice-overlay-vision-controls">
              <button
                class="voice-vision-btn ${visionState === "streaming" && visionSource === "screen" ? "active" : ""}"
                onClick=${handleToggleScreenShare}
                disabled=${!canShareVision}
                title=${canShareVision ? "Share your screen with the active agent call" : "Open a session-bound call first"}
              >
                ${visionState === "streaming" && visionSource === "screen" ? "Stop Screen" : "Share Screen"}
              </button>
              <button
                class="voice-vision-btn ${visionState === "streaming" && visionSource === "camera" ? "active" : ""}"
                onClick=${handleToggleCameraShare}
                disabled=${!canShareVision}
                title=${canShareVision ? "Share your camera with the active agent call" : "Open a session-bound call first"}
              >
                ${visionState === "streaming" && visionSource === "camera" ? "Stop Camera" : "Share Camera"}
              </button>
            </div>

            ${(visionErr || latestVisionSummary) && html`
              <div class="voice-vision-status">
                ${visionErr || latestVisionSummary}
              </div>
            `}

            <!-- Tool call cards -->
            ${toolCalls.length > 0 && html`
              <div class="voice-tool-cards">
                ${toolCalls.slice(-5).map(tc => html`
                  <div class="voice-tool-card ${tc.status}" key=${tc.callId}>
                    <span>${tc.status === "running" ? resolveIcon("loading") : tc.status === "complete" ? resolveIcon("check") : resolveIcon("alert")}</span>
                    <span>${tc.name}</span>
                  </div>
                `)}
              </div>
            `}
          </div>

          <!-- Footer -->
          <div class="voice-overlay-footer">
            <button class="voice-end-btn" onClick=${handleClose} title="End call">
              ${resolveIcon("close")}
            </button>
          </div>
        </div>

        ${showMeetingChat && html`
          <aside class=${`voice-overlay-chat${isCompactFollowMode ? " follow-feed" : ""}`}>
            <div class="voice-overlay-chat-head">
              <div class="voice-overlay-chat-title">
                ${isCompactFollowMode ? "Live Meeting Transcript" : "Meeting Chat + Transcript"}
              </div>
              <div class="voice-overlay-chat-status">${chatStatusLabel}</div>
            </div>
            ${isCompactFollowMode && liveTranscriptText && html`
              <div class="voice-overlay-chat-live user">You: ${liveTranscriptText}</div>
            `}
            ${isCompactFollowMode && liveResponseText && html`
              <div class="voice-overlay-chat-live assistant">Assistant: ${liveResponseText}</div>
            `}
            <div class="voice-overlay-chat-body" ref=${meetingScrollRef}>
              ${meetingFeedMessages.length === 0 && !meetingChatLoading
                ? html`<div class="voice-overlay-chat-empty">Conversation will appear here once the call starts.</div>`
                : null}
              ${meetingFeedMessages.map((msg) => {
                return html`
                  <div class="voice-overlay-chat-msg ${msg.role}" key=${msg.id}>
                    <div class="voice-overlay-chat-meta">
                      <span>${msg.role}</span>
                      <span>${msg.timeLabel}</span>
                    </div>
                    <div class="voice-overlay-chat-content">${msg.content}</div>
                  </div>
                `;
              })}
            </div>
            ${!isCompactFollowMode && html`
              <div class="voice-overlay-chat-input-wrap">
                <input
                  class="voice-overlay-chat-input"
                  placeholder="Message the agent during the call…"
                  value=${meetingChatInput}
                  onInput=${(e) => setMeetingChatInput(e.target.value)}
                  onKeyDown=${(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMeetingChat().catch(() => {});
                    }
                  }}
                />
                <button
                  class="voice-overlay-chat-send"
                  onClick=${() => handleSendMeetingChat().catch(() => {})}
                  disabled=${!meetingChatInput.trim() || meetingChatSending}
                >
                  Send
                </button>
              </div>
            `}
          </aside>
        `}
      </div>
    </div>
  `;
}
