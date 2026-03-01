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
import { showToast } from "./state.js";
import {
  voiceState, voiceTranscript, voiceResponse, voiceError,
  voiceToolCalls, voiceDuration, isVoiceMicMuted,
  startVoiceSession, stopVoiceSession, interruptResponse,
  sendTextMessage, sendImageFrame, onVoiceEvent, resumeVoiceAudio, toggleMicMute,
} from "./voice-client.js";
import {
  sdkVoiceState, sdkVoiceTranscript, sdkVoiceResponse, sdkVoiceError,
  sdkVoiceToolCalls, sdkVoiceDuration, sdkVoiceSdkActive,
  startSdkVoiceSession, stopSdkVoiceSession, interruptSdkResponse,
  sendSdkTextMessage, sendSdkImageFrame, onSdkVoiceEvent,
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
  visionTransportMode,
  supportsVisionSource,
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
/* ── Base overlay ─────────────────────────────────────────────────── */
.voice-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: #202124;
  display: flex;
  flex-direction: column;
  color: #fff;
  font-family: var(--tg-theme-font, 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  animation: voiceOverlayFadeIn 0.25s ease;
  overflow: hidden;
}
@keyframes voiceOverlayFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ── Top bar (Meet-style: title + duration left, close right) ────── */
.vm-topbar {
  position: absolute;
  top: 0; left: 0; right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, transparent 100%);
  z-index: 3;
  pointer-events: none;
}
.vm-topbar > * { pointer-events: auto; }
.vm-topbar-left { display: flex; align-items: center; gap: 10px; }
.vm-topbar-title { font-size: 14px; font-weight: 500; color: #fff; }
.vm-topbar-duration {
  font-size: 13px; color: rgba(255,255,255,0.7);
  font-variant-numeric: tabular-nums;
}
.vm-topbar-bound {
  font-size: 11px; color: rgba(255,255,255,0.45);
  max-width: 44vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vm-topbar-right { display: flex; align-items: center; gap: 8px; }

/* ── Main stage area ─────────────────────────────────────────────── */
.voice-overlay-main {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 16px;
  padding: 72px 20px 100px;
}
.voice-overlay-stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
}
.voice-overlay-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  z-index: 1;
}

/* ── Orb ─────────────────────────────────────────────────────────── */
.voice-orb-container {
  width: 210px;
  height: 210px;
  position: relative;
  cursor: pointer;
}

/* ── Transcripts ─────────────────────────────────────────────────── */
.voice-transcript-area {
  max-width: 520px;
  text-align: center;
  min-height: 60px;
}
.voice-transcript-user {
  font-size: 16px; color: rgba(255,255,255,0.75);
  margin-bottom: 6px; font-style: italic;
}
.voice-transcript-assistant {
  font-size: 18px; color: #fff; line-height: 1.5;
}

/* ── Error / connecting dots ─────────────────────────────────────── */
.voice-error-msg {
  color: #f28b82; font-size: 14px; text-align: center; max-width: 420px;
  background: rgba(234,67,53,0.12); border: 1px solid rgba(234,67,53,0.28);
  border-radius: 10px; padding: 8px 14px;
}
.voice-connecting-dots { display: flex; gap: 8px; }
.voice-connecting-dots span {
  width: 10px; height: 10px; border-radius: 50%;
  background: rgba(255,255,255,0.4);
  animation: voiceDotPulse 1.4s ease infinite;
}
.voice-connecting-dots span:nth-child(2) { animation-delay: 0.2s; }
.voice-connecting-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes voiceDotPulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.2); }
}
.voice-overlay-status {
  font-size: 14px; color: rgba(255,255,255,0.65); text-transform: capitalize;
}

/* ── Tool call cards ─────────────────────────────────────────────── */
.voice-tool-cards { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 600px; }
.voice-tool-card {
  padding: 5px 11px; border-radius: 8px;
  background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12);
  font-size: 12px; color: rgba(255,255,255,0.7);
  display: flex; align-items: center; gap: 6px;
}
.voice-tool-card.running { border-color: rgba(138,180,248,0.5); color: #8ab4f8; }
.voice-tool-card.complete { border-color: rgba(129,201,149,0.5); color: #81c995; }
.voice-tool-card.error { border-color: rgba(242,139,130,0.5); color: #f28b82; }

/* ── Vision status ───────────────────────────────────────────────── */
.voice-vision-status {
  margin-top: 4px; max-width: 560px; text-align: center;
  font-size: 12px; color: rgba(255,255,255,0.55);
}

/* ── Bottom Meet-style controls bar ─────────────────────────────── */
.vm-bar {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  display: flex;
  align-items: center;
  padding: 0 20px 20px;
  min-height: 88px;
  background: linear-gradient(to top, rgba(0,0,0,0.65) 0%, transparent 100%);
  z-index: 3;
}
.vm-bar-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}
.vm-bar-group.center { justify-content: center; gap: 8px; }
.vm-bar-group.right { justify-content: flex-end; }

/* Round control button — like Meet */
.vm-btn-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}
.vm-btn {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: #3c4043;
  color: #e8eaed;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  transition: background 0.15s, transform 0.1s;
  position: relative;
  flex-shrink: 0;
}
.vm-btn:hover:not(:disabled) { background: #5f6368; }
.vm-btn:disabled { opacity: 0.38; cursor: not-allowed; }
.vm-btn.active { background: #e8eaed; color: #202124; }
.vm-btn.muted { background: #ea4335; color: #fff; }
.vm-btn.screen-on { background: #188038; color: #fff; }
.vm-btn-label {
  font-size: 10px; color: rgba(255,255,255,0.65);
  user-select: none; white-space: nowrap;
}

/* End-call pill — the red rounded rect like Meet */
.vm-end-pill {
  height: 48px;
  padding: 0 24px;
  border-radius: 999px;
  border: none;
  background: #ea4335;
  color: #fff;
  font-size: 22px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background 0.15s, transform 0.1s;
  box-shadow: 0 2px 12px rgba(234,67,53,0.45);
  flex-shrink: 0;
}
.vm-end-pill:hover { background: #c5281c; transform: scale(1.04); }
.vm-end-pill-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}
.vm-end-pill-label {
  font-size: 10px; color: rgba(255,255,255,0.65); user-select: none;
}

/* ── Chat panel (side panel) ─────────────────────────────────────── */
.voice-overlay-chat {
  width: min(380px, 40vw);
  min-width: 280px;
  max-width: 440px;
  border-radius: 12px;
  background: #2d2e30;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.voice-overlay-chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
}
.voice-overlay-chat-title { font-size: 13px; font-weight: 600; color: #e8eaed; }
.voice-overlay-chat-status { font-size: 11px; color: rgba(255,255,255,0.55); }
.voice-overlay-chat-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 10px;
  display: flex; flex-direction: column; gap: 8px;
}
.voice-overlay-chat-empty {
  color: rgba(255,255,255,0.5); text-align: center; font-size: 12px; padding: 20px 8px;
}
.voice-overlay-chat-msg {
  padding: 8px 10px; border-radius: 10px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
}
.voice-overlay-chat-msg.user {
  align-self: flex-end;
  background: rgba(138,180,248,0.16); border-color: rgba(138,180,248,0.3);
}
.voice-overlay-chat-msg.assistant {
  align-self: flex-start;
  background: rgba(129,201,149,0.14); border-color: rgba(129,201,149,0.28);
}
.voice-overlay-chat-msg.tool {
  align-self: flex-start;
  background: rgba(249,171,0,0.12);
  border-color: rgba(249,171,0,0.35);
}
.voice-overlay-chat-meta {
  display: flex; justify-content: space-between; align-items: center;
  gap: 8px; font-size: 10px; color: rgba(255,255,255,0.5);
  margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.03em;
}
.voice-overlay-chat-content {
  white-space: pre-wrap; word-break: break-word;
  font-size: 13px; line-height: 1.4; color: #e8eaed;
}
.voice-overlay-chat-input-wrap {
  border-top: 1px solid rgba(255,255,255,0.1);
  padding: 10px; display: flex; gap: 8px;
}
.voice-overlay-chat-input {
  flex: 1; min-width: 0;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 24px;
  background: #3c4043;
  color: #e8eaed;
  padding: 8px 14px;
  font-size: 13px;
}
.voice-overlay-chat-input:focus { outline: none; border-color: #8ab4f8; }
.voice-overlay-chat-send {
  border: none; border-radius: 50%; width: 36px; height: 36px;
  background: #8ab4f8; color: #202124;
  font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.voice-overlay-chat-send:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── Floating minimized widget (PiP-style) ───────────────────────── */
.vm-floating {
  position: fixed;
  bottom: 24px; right: 24px;
  width: 288px;
  background: #2d2e30;
  border-radius: 16px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.1);
  z-index: 10001;
  overflow: hidden;
  animation: vmFloatIn 0.22s cubic-bezier(0.34,1.56,0.64,1);
  /* dragging will be applied via inline styles */
}
@keyframes vmFloatIn {
  from { opacity: 0; transform: scale(0.88) translateY(12px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
.vm-floating-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px 8px;
  cursor: grab;
  user-select: none;
}
.vm-floating-header:active { cursor: grabbing; }
.vm-floating-header-info { flex: 1; min-width: 0; }
.vm-floating-title { font-size: 13px; font-weight: 600; color: #e8eaed; }
.vm-floating-sub {
  font-size: 11px; color: rgba(255,255,255,0.5);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 1px;
}
.vm-floating-orb {
  width: 38px; height: 38px;
  border-radius: 50%;
  background: #3c4043;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
}
.vm-floating-orb.speaking { background: #188038; animation: vmOrbPulse 1.2s ease infinite; }
.vm-floating-orb.listening { background: #1a73e8; }
.vm-floating-orb.thinking { background: #f29900; }
.vm-floating-orb.connecting { background: #5f6368; }
.vm-floating-orb.error { background: #ea4335; }
@keyframes vmOrbPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(24,128,56,0.6); }
  50% { box-shadow: 0 0 0 8px rgba(24,128,56,0); }
}
.vm-floating-transcript {
  font-size: 12px; color: rgba(255,255,255,0.75);
  padding: 0 14px 8px;
  max-height: 48px; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.vm-floating-actions {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px 12px;
}
.vm-floating-mic {
  width: 36px; height: 36px; border-radius: 50%; border: none;
  background: #3c4043; color: #e8eaed;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: 16px; flex-shrink: 0;
}
.vm-floating-mic.muted { background: #ea4335; }
.vm-floating-expand {
  flex: 1; height: 34px; border-radius: 999px; border: none;
  background: #3c4043; color: #e8eaed;
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background 0.15s;
}
.vm-floating-expand:hover { background: #5f6368; }
.vm-floating-end {
  width: 36px; height: 36px; border-radius: 50%; border: none;
  background: #ea4335; color: #fff;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: 16px; flex-shrink: 0;
}
.vm-floating-end:hover { background: #c5281c; }

/* ── Responsive ───────────────────────────────────────────────────── */
@media (max-width: 900px) {
  .voice-overlay-main {
    flex-direction: column;
    padding: 72px 14px 96px;
    gap: 10px;
  }
  .voice-overlay-chat {
    width: 100%; min-width: 0; max-width: none;
    max-height: 40vh;
  }
  .voice-orb-container { width: 170px; height: 170px; }
  .vm-btn { width: 44px; height: 44px; font-size: 17px; }
  .vm-end-pill { height: 44px; padding: 0 18px; font-size: 20px; }
  .vm-bar { padding: 0 12px 16px; }
}
@media (max-width: 580px) {
  .vm-btn-label { display: none; }
  .vm-end-pill-label { display: none; }
  .vm-bar { padding: 0 8px 14px; }
  .vm-btn { width: 40px; height: 40px; font-size: 16px; }
  .vm-end-pill { height: 40px; padding: 0 14px; font-size: 18px; }
}

/* ── Compact / follow-feed mode ───────────────────────────────────── */
.voice-overlay.compact { background: rgba(0,0,0,0.96); }
.voice-overlay.compact .vm-topbar { padding: 10px 12px; }
.voice-overlay.compact .voice-overlay-main { padding: 58px 10px 88px; gap: 8px; flex-direction: column; }
.voice-overlay.compact .voice-overlay-stage { gap: 10px; }
.voice-overlay.compact .voice-overlay-center { gap: 10px; }
.voice-overlay.compact .voice-orb-container { width: 140px; height: 140px; }
.voice-overlay.compact .voice-overlay-chat { width: 100%; min-width: 0; max-width: none; max-height: none; }
.voice-overlay.compact .voice-overlay-stage { display: none; }
.voice-overlay.compact .voice-overlay-chat.follow-feed {
  height: calc(100vh - 140px); max-height: none;
}
.voice-overlay.compact .voice-overlay-chat-input-wrap { display: none; }
.voice-overlay.compact .vm-bar { padding: 0 10px 12px; }

/* ── Live in-line transcript bubbles (compact) ────────────────────── */
.voice-overlay-chat-live {
  margin: 4px 10px 0;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(255,255,255,0.06);
  border-radius: 10px;
  padding: 7px 10px;
  font-size: 12px; line-height: 1.35; color: rgba(255,255,255,0.9);
}
.voice-overlay-chat-live.user { border-color: rgba(138,180,248,0.4); }
.voice-overlay-chat-live.assistant { border-color: rgba(129,201,149,0.4); }
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
  const msgType = String(msg?.type || "").trim().toLowerCase();
  if (msgType === "tool_call" || msgType === "tool_result") return "tool";
  const roleRaw = String(
    msg?.role ||
      (msgType === "tool_call" || msgType === "tool_result"
        ? "tool"
        : "assistant"),
  )
    .trim()
    .toLowerCase();
  if (roleRaw === "user" || roleRaw === "assistant" || roleRaw === "tool") return roleRaw;
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

function normalizeMeetingMessageAttachments(msg) {
  const raw = Array.isArray(msg?.attachments) ? msg.attachments : [];
  return raw
    .filter(Boolean)
    .map((att, index) => {
      const name = String(
        att?.name || att?.filename || att?.title || `attachment-${index + 1}`,
      )
        .trim() || `attachment-${index + 1}`;
      const url = String(att?.url || "").trim();
      const contentType = String(att?.contentType || "").trim();
      const kind = String(att?.kind || "").trim().toLowerCase();
      const sizeRaw = Number(att?.size);
      const size = Number.isFinite(sizeRaw) ? sizeRaw : null;
      return {
        id: String(att?.id || `${name}-${index}`),
        name,
        url,
        contentType,
        kind,
        size,
      };
    });
}

function formatAttachmentSize(size) {
  const raw = Number(size);
  if (!Number.isFinite(raw) || raw <= 0) return "";
  if (raw >= 1024 * 1024) return `${(raw / (1024 * 1024)).toFixed(1)} MB`;
  if (raw >= 1024) return `${Math.round(raw / 1024)} KB`;
  return `${raw} B`;
}

function isVoiceAttachmentAllowed(file) {
  const name = String(file?.name || "").trim().toLowerCase();
  const mime = String(file?.type || "").trim().toLowerCase();
  if (mime.startsWith("image/")) return true;
  if (mime === "application/pdf") return true;
  if (/\.(png|jpe?g|gif|webp|bmp|svg|pdf)$/i.test(name)) return true;
  return false;
}

function isToolEventMessage(msg) {
  const msgType = String(msg?.type || "").trim().toLowerCase();
  if (msgType === "tool_call" || msgType === "tool_result") return true;
  const eventType = String(msg?.meta?.eventType || "").trim().toLowerCase();
  return eventType.includes("tool");
}

function stringifyToolData(value, maxLength = 1200) {
  if (value == null) return "";
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  const clean = String(text || "").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength)}\n…`;
}

function formatMeetingMessageContent(msg, baseText) {
  if (!isToolEventMessage(msg)) return String(baseText || "").trim();
  const msgType = String(msg?.type || "").trim().toLowerCase();
  const toolName = String(
    msg?.name ||
    msg?.toolName ||
    msg?.meta?.toolName ||
    msg?.data?.name ||
    msg?.data?.toolName ||
    "",
  ).trim();
  const argsRaw =
    msg?.args ??
    msg?.arguments ??
    msg?.meta?.args ??
    msg?.meta?.arguments ??
    msg?.data?.args ??
    msg?.data?.arguments;
  const resultRaw =
    msg?.result ??
    msg?.output ??
    msg?.meta?.result ??
    msg?.meta?.output ??
    msg?.data?.result ??
    msg?.data?.output;
  const errorRaw =
    msg?.error ??
    msg?.meta?.error ??
    msg?.data?.error;

  const lines = [];
  if (msgType === "tool_call") {
    lines.push(`[Tool Call] ${toolName || "unknown_tool"}`);
    const argsText = stringifyToolData(argsRaw);
    if (argsText) lines.push(`Args:\n${argsText}`);
  } else {
    lines.push(`[Tool Result] ${toolName || "unknown_tool"}`);
    const resultText = stringifyToolData(resultRaw);
    if (resultText) lines.push(`Result:\n${resultText}`);
  }
  const errorText = stringifyToolData(errorRaw);
  if (errorText) lines.push(`Error:\n${errorText}`);

  const fallbackText = String(baseText || "").trim();
  if (fallbackText && !lines.join("\n").includes(fallbackText)) {
    lines.push(`Message:\n${fallbackText}`);
  }
  return lines.join("\n").trim();
}

function shouldSuppressCompactMeetingMessage(role, text, hasAttachments = false, isToolEvent = false) {
  const value = String(text || "").trim();
  if (!value && !hasAttachments) return true;
  if (role === "system" && !isToolEvent) return true;
  if (/^reconnecting\.\.\./i.test(value)) return true;
  if (/stream disconnected before completion/i.test(value)) return true;
  if (/^turn completed$/i.test(value)) return true;
  if (/^\*\*/.test(value)) return true;
  return false;
}

function shouldSuppressMeetingMessage(msg, role, text, hasAttachments = false, isToolEvent = false) {
  const eventType = String(msg?.meta?.eventType || "").trim().toLowerCase();
  if (eventType.includes("tool") && !isToolEvent) return true;
  if (eventType.includes("transcript")) return true;
  if (eventType.startsWith("voice_background_")) return true;
  const source = String(msg?.meta?.source || "").trim().toLowerCase();
  if (source === "vision") return true;
  const value = String(text || "").trim();
  if (!value && !hasAttachments) return true;
  if (!isToolEvent && String(role || "").toLowerCase() === "system" && /^\[Vision\s/i.test(value)) {
    return true;
  }
  if (/^\[Voice Action (Started|Complete|Error)\]/i.test(value)) return true;
  if (/^\[Voice Delegation/i.test(value)) return true;
  if (/^\[Background Task Started\]/i.test(value)) return true;
  return false;
}

function parseMeetingTimestampMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const millis = new Date(raw).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function isLikelyFragmentMessage(message) {
  if (!message || message.role !== "assistant") return false;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    return false;
  }
  const content = String(message.content || "").trim();
  if (!content) return false;
  if (content.length > 32) return false;
  if (/^[\[{(]/.test(content)) return false;
  const words = content.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  if (/[.!?…:]$/.test(content)) return false;
  return true;
}

function mergeFragmentContent(baseContent, nextContent) {
  const left = String(baseContent || "").trimEnd();
  const right = String(nextContent || "").trimStart();
  if (!left) return right;
  if (!right) return left;

  if (/^[,.;:!?)}\]]/.test(right)) {
    return `${left}${right}`;
  }
  if (/^[-–—]/.test(right) || /[-–—]$/.test(left)) {
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

function mergeFragmentedMeetingFeedMessages(items) {
  const merged = [];
  for (const item of items) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (!prev) {
      merged.push(item);
      continue;
    }

    const timeDelta =
      Number.isFinite(prev.timestampMs) && Number.isFinite(item.timestampMs)
        ? Math.abs(item.timestampMs - prev.timestampMs)
        : null;
    const shouldMerge =
      prev.role === "assistant"
      && item.role === "assistant"
      && isLikelyFragmentMessage(prev)
      && isLikelyFragmentMessage(item)
      && (timeDelta == null || timeDelta <= 120000);

    if (!shouldMerge) {
      merged.push(item);
      continue;
    }

    const nextContent = mergeFragmentContent(prev.content, item.content);
    merged[merged.length - 1] = {
      ...prev,
      id: `${prev.id}:${item.id}`,
      content: nextContent,
      timeLabel: item.timeLabel || prev.timeLabel,
      timestampMs: item.timestampMs ?? prev.timestampMs,
    };
  }
  return merged;
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
  const [minimized, setMinimized] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [meetingMessages, setMeetingMessages] = useState([]);
  const [meetingChatInput, setMeetingChatInput] = useState("");
  const [floatingChatInput, setFloatingChatInput] = useState("");
  const [meetingChatSending, setMeetingChatSending] = useState(false);
  const [meetingChatLoading, setMeetingChatLoading] = useState(false);
  const [meetingUploadingAttachments, setMeetingUploadingAttachments] =
    useState(false);
  const [meetingPendingAttachments, setMeetingPendingAttachments] = useState([]);
  const [meetingChatError, setMeetingChatError] = useState(null);
  const meetingFileInputRef = useRef(null);
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
  const micMuted = isVoiceMicMuted.value;
  const visionState = visionShareState.value;
  const visionSource = visionShareSource.value;
  const visionErr = visionShareError.value;
  const latestVisionSummary = visionLastSummary.value;
  const visionMode = visionTransportMode.value;
  const canShareVision = Boolean(sessionId);
  const canShareCamera = canShareVision && supportsVisionSource("camera");
  const canShareScreen = canShareVision && supportsVisionSource("screen");
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
  // Reliability mode: do NOT inject every incoming chat message (it creates
  // noisy feedback loops). Only inject explicit voice background summaries.
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
      const msgSource = String(msg?.meta?.source || "").trim().toLowerCase();
      const msgEventType = String(msg?.meta?.eventType || "").trim().toLowerCase();
      if (msgEventType.includes("transcript")) return;
      const shouldInject =
        msgSource === "voice" && msgEventType === "voice_background_summary";
      if (!shouldInject) return;
      // Avoid re-injecting old messages
      const msgTs = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
      if (msgTs <= lastInjectedTsRef.current) return;
      lastInjectedTsRef.current = msgTs;

      // Build a short context injection for background completion summary only
      const bgSessionId = String(msg?.meta?.backgroundSessionId || "").trim();
      const text = `[Background Delegation Summary${bgSessionId ? ` ${bgSessionId}` : ""}]: ${content.slice(0, 800)}`;

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
      preferRealtimeVision: true,
      onFrame: (frameDataUrl, frameMeta) => {
        if (effectiveSdk) {
          return sendSdkImageFrame(frameDataUrl, frameMeta);
        }
        if (tier === 1) {
          return sendImageFrame(frameDataUrl, frameMeta);
        }
        return false;
      },
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
    tier,
    effectiveSdk,
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
      preferRealtimeVision: true,
      onFrame: (frameDataUrl, frameMeta) => {
        if (effectiveSdk) {
          return sendSdkImageFrame(frameDataUrl, frameMeta);
        }
        if (tier === 1) {
          return sendImageFrame(frameDataUrl, frameMeta);
        }
        return false;
      },
    }).catch(() => {});
  }, [sessionId, executor, mode, model, tier, effectiveSdk]);

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
      preferRealtimeVision: true,
      onFrame: (frameDataUrl, frameMeta) => {
        if (effectiveSdk) {
          return sendSdkImageFrame(frameDataUrl, frameMeta);
        }
        if (tier === 1) {
          return sendImageFrame(frameDataUrl, frameMeta);
        }
        return false;
      },
    }).catch(() => {});
  }, [sessionId, executor, mode, model, tier, effectiveSdk]);

  const handleToggleMic = useCallback(() => {
    haptic("light");
    toggleMicMute();
  }, []);

  const handleMinimize = useCallback(() => {
    haptic("light");
    if (
      typeof globalThis?.veDesktop?.follow?.open === "function"
      && !(globalThis.location?.search || "").includes("follow=1")
    ) {
      globalThis.veDesktop.follow
        .open({
          call: normalizedCallType,
          sessionId: sessionId || undefined,
          initialVisionSource: normalizedInitialVisionSource || undefined,
          executor: executor || undefined,
          mode: mode || undefined,
          model: model || undefined,
        })
        .then((result) => {
          if (result?.ok) {
            handleDismiss();
          } else {
            setMinimized(true);
          }
        })
        .catch(() => {
          setMinimized(true);
        });
      return;
    }
    setMinimized(true);
  }, [
    handleDismiss,
    normalizedCallType,
    normalizedInitialVisionSource,
    sessionId,
    executor,
    mode,
    model,
  ]);

  const handleExpand = useCallback(() => {
    haptic("light");
    setMinimized(false);
  }, []);

  const uploadMeetingAttachments = useCallback(async (files) => {
    const activeSessionId = String(sessionId || "").trim();
    if (!activeSessionId || meetingUploadingAttachments) return;
    const inputList = Array.from(files || []).filter(Boolean);
    if (!inputList.length) return;
    const accepted = inputList.filter(isVoiceAttachmentAllowed);
    const rejectedCount = inputList.length - accepted.length;
    if (rejectedCount > 0) {
      showToast(
        `Voice chat only supports images/PDF (${rejectedCount} rejected).`,
        "info",
      );
    }
    if (!accepted.length) return;
    setMeetingUploadingAttachments(true);
    const safeSessionId = encodeURIComponent(activeSessionId);
    try {
      const form = new FormData();
      for (const file of accepted) {
        form.append("file", file, file.name || "attachment");
      }
      const result = await apiFetch(`/api/sessions/${safeSessionId}/attachments`, {
        method: "POST",
        body: form,
      });
      if (Array.isArray(result?.attachments) && result.attachments.length > 0) {
        setMeetingPendingAttachments((prev) => [...prev, ...result.attachments]);
        return;
      }
      showToast("Attachment upload failed", "error");
    } catch {
      showToast("Attachment upload failed", "error");
    } finally {
      setMeetingUploadingAttachments(false);
    }
  }, [sessionId, meetingUploadingAttachments]);

  const captureScreenAttachment = useCallback(async () => {
    if (
      !globalThis.navigator?.mediaDevices
      || typeof globalThis.navigator.mediaDevices.getDisplayMedia !== "function"
    ) {
      showToast("Screen capture is not supported in this runtime.", "error");
      return;
    }
    let stream = null;
    try {
      stream = await globalThis.navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: "always",
          frameRate: { ideal: 1, max: 5 },
        },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track available");
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      await new Promise((resolve) => {
        if (video.readyState >= 2) {
          resolve();
          return;
        }
        video.addEventListener("loadeddata", resolve, { once: true });
      });
      const width = Math.max(1, Number(video.videoWidth) || 1280);
      const height = Math.max(1, Number(video.videoHeight) || 720);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Canvas is not available");
      ctx.drawImage(video, 0, 0, width, height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (nextBlob) => {
            if (nextBlob) resolve(nextBlob);
            else reject(new Error("Could not encode screenshot"));
          },
          "image/png",
          0.92,
        );
      });
      const file = new File(
        [blob],
        `meeting-screenshot-${Date.now()}.png`,
        { type: "image/png" },
      );
      await uploadMeetingAttachments([file]);
    } catch (err) {
      const message = String(err?.message || "Screenshot capture failed");
      if (!/denied|cancel/i.test(message)) {
        showToast(message, "error");
      }
    } finally {
      try {
        stream?.getTracks?.().forEach((track) => track.stop());
      } catch {
        // best effort
      }
    }
  }, [uploadMeetingAttachments]);

  const removeMeetingAttachment = useCallback((index) => {
    setMeetingPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSendMeetingChat = useCallback(async (rawContent = null) => {
    const activeSessionId = String(sessionId || "").trim();
    const content = String(rawContent != null ? rawContent : meetingChatInput || "").trim();
    const attachments = Array.isArray(meetingPendingAttachments)
      ? meetingPendingAttachments.filter(Boolean)
      : [];
    if (!activeSessionId || meetingChatSending) return;
    if (!content && attachments.length === 0) return;
    setMeetingChatSending(true);
    const safeSessionId = encodeURIComponent(activeSessionId);
    try {
      await apiFetch(`/api/sessions/${safeSessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ content, attachments }),
      });
      setMeetingChatInput("");
      setFloatingChatInput("");
      setMeetingPendingAttachments([]);
      await loadMeetingMessages();
    } catch (err) {
      setMeetingChatError(String(err?.message || "Could not send chat message"));
    } finally {
      setMeetingChatSending(false);
    }
  }, [
    meetingChatInput,
    meetingChatSending,
    meetingPendingAttachments,
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
      const rawText = stringifyMeetingMessageContent(msg);
      const isToolEvent = isToolEventMessage(msg);
      const text = formatMeetingMessageContent(msg, rawText);
      const attachments = normalizeMeetingMessageAttachments(msg);
      if (
        shouldSuppressMeetingMessage(
          msg,
          role,
          text,
          attachments.length > 0,
          isToolEvent,
        )
      ) {
        continue;
      }
      if (
        isCompactFollowMode
        && shouldSuppressCompactMeetingMessage(
          role,
          text,
          attachments.length > 0,
          isToolEvent,
        )
      ) {
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
        && (!prev.attachments?.length && attachments.length === 0)
        && !isToolEvent
      ) {
        continue;
      }
      items.push({
        id: msg?.id || `${role}-${items.length}`,
        role,
        content: normalizedText,
        isToolEvent,
        attachments,
        timeLabel,
        timestampMs: parseMeetingTimestampMs(msg?.timestamp),
      });
    }
    const merged = mergeFragmentedMeetingFeedMessages(items);
    if (!isCompactFollowMode) return merged;
    return merged.slice(-120);
  })();
  const showMeetingChat = Boolean(sessionId) && (chatOpen || isCompactFollowMode);
  const liveTranscriptText = String(transcript || "").trim();
  const liveResponseText = String(response || "").trim();

  return html`
    ${!minimized && html`
      <div class=${`voice-overlay${compact ? " compact" : ""}`}>
        <!-- Top bar -->
        <div class="vm-topbar">
          <div class="vm-topbar-left">
            <span class="vm-topbar-title">
              ${normalizedCallType === "video" ? "Video Call" : "AI Agent Call"}
            </span>
            ${duration > 0 && html`
              <span class="vm-topbar-duration">${formatDuration(duration)}</span>
            `}
            ${boundLabel && html`
              <span class="vm-topbar-bound">${boundLabel}</span>
            `}
          </div>
          <div class="vm-topbar-right">
            <button class="vm-minimize-btn" onClick=${handleMinimize} title="Minimise to floating widget">
              ${resolveIcon("chevronDown") || "⌵"}
            </button>
          </div>
        </div>

        <!-- Main area: stage + optional chat panel -->
        <div class="voice-overlay-main">
          <div class="voice-overlay-stage">
            <div class="voice-overlay-center">
              <!-- Orb -->
              <div
                class="voice-orb-container"
                onClick=${state === "speaking" ? handleInterrupt : () => resumeVoiceAudio().catch(() => {})}
                title=${state === "speaking" ? "Interrupt" : "Tap to resume audio"}
              >
                <${AudioVisualizer} state=${state} />
              </div>

              ${(state === "connecting" || state === "reconnecting") && html`
                <div class="voice-connecting-dots">
                  <span /><span /><span />
                </div>
                <div class="voice-overlay-status" style="font-size: 16px">
                  ${state === "reconnecting" ? "Reconnecting..." : "Connecting..."}
                </div>
              `}

              ${error && html`<div class="voice-error-msg">${error}</div>`}

              <!-- Live transcripts -->
              <div class="voice-transcript-area">
                ${transcript && html`
                  <div class="voice-transcript-user">"${transcript}"</div>
                `}
                ${response && html`
                  <div class="voice-transcript-assistant">${response}</div>
                `}
                ${!transcript && !response && state === "connected" && html`
                  <div class="voice-overlay-status">${statusLabel}</div>
                `}
              </div>

              ${(visionErr || latestVisionSummary) && html`
                <div class="voice-vision-status">
                  ${visionState === "streaming" && html`
                    <div>
                      Vision mode: ${visionMode === "realtime"
                        ? "realtime stream"
                        : visionMode === "fallback"
                          ? "analysis fallback"
                          : "negotiating"}
                    </div>
                  `}
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
          </div>

          <!-- Chat side panel -->
          ${showMeetingChat && html`
            <aside class=${`voice-overlay-chat${isCompactFollowMode ? " follow-feed" : ""}`}>
              <div class="voice-overlay-chat-head">
                <div class="voice-overlay-chat-title">
                  ${isCompactFollowMode ? "Live Transcript" : "Meeting Chat"}
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
                ${meetingFeedMessages.map((msg) => html`
                  <div class="voice-overlay-chat-msg ${msg.role}" key=${msg.id}>
                    <div class="voice-overlay-chat-meta">
                      <span>${msg.isToolEvent ? "tool" : msg.role}</span>
                      <span>${msg.timeLabel}</span>
                    </div>
                    ${msg.content && html`
                      <div class="voice-overlay-chat-content">${msg.content}</div>
                    `}
                    ${Array.isArray(msg.attachments) && msg.attachments.length > 0 && html`
                      <div style="margin-top:${msg.content ? "6px" : "0"};display:flex;flex-direction:column;gap:5px">
                        ${msg.attachments.map((att) => {
                          const attLabel = [
                            att.name || "attachment",
                            formatAttachmentSize(att.size),
                          ].filter(Boolean).join(" · ");
                          const icon = att.kind === "image" || String(att.contentType || "").startsWith("image/")
                            ? "🖼"
                            : String(att.contentType || "").toLowerCase() === "application/pdf"
                              ? "📄"
                              : "📎";
                          return html`
                            <a
                              key=${att.id || att.name}
                              href=${att.url || "#"}
                              target="_blank"
                              rel="noopener"
                              style="text-decoration:none;color:#8ab4f8;font-size:12px;border:1px solid rgba(138,180,248,0.35);background:rgba(138,180,248,0.08);padding:5px 8px;border-radius:8px"
                            >
                              ${icon} ${attLabel}
                            </a>
                          `;
                        })}
                      </div>
                    `}
                  </div>
                `)}
              </div>
              ${!isCompactFollowMode && html`
                <div class="voice-overlay-chat-input-wrap">
                  <input
                    ref=${meetingFileInputRef}
                    type="file"
                    accept="image/*,application/pdf,.pdf"
                    multiple
                    style="display:none"
                    onChange=${(e) => {
                      const files = e?.target?.files;
                      if (files?.length) uploadMeetingAttachments(files);
                      if (e?.target) e.target.value = "";
                    }}
                  />
                  <button
                    class="voice-overlay-chat-send"
                    onClick=${() => meetingFileInputRef.current?.click?.()}
                    disabled=${meetingUploadingAttachments || meetingChatSending}
                    title="Attach image/PDF"
                  >📎</button>
                  <button
                    class="voice-overlay-chat-send"
                    onClick=${() => captureScreenAttachment().catch(() => {})}
                    disabled=${meetingUploadingAttachments || meetingChatSending}
                    title="Capture screenshot"
                  >📸</button>
                  <input
                    class="voice-overlay-chat-input"
                    placeholder="Message the agent…"
                    value=${meetingChatInput}
                    onInput=${(e) => setMeetingChatInput(e.target.value)}
                    onPaste=${(e) => {
                      const files = e.clipboardData?.files;
                      if (files && files.length > 0) {
                        e.preventDefault();
                        uploadMeetingAttachments(files);
                      }
                    }}
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
                    title="Send"
                  >↑</button>
                </div>
              `}
              ${!isCompactFollowMode && meetingPendingAttachments.length > 0 && html`
                <div style="padding:0 10px 10px;display:flex;gap:6px;flex-wrap:wrap">
                  ${meetingPendingAttachments.map((att, index) => html`
                    <button
                      class="vm-floating-expand"
                      style="flex:0 1 auto;padding:0 10px"
                      onClick=${() => removeMeetingAttachment(index)}
                      title="Remove attachment"
                    >
                      ${(att?.name || "attachment")} ✕
                    </button>
                  `)}
                </div>
              `}
            </aside>
          `}
        </div>

        <!-- Google Meet-style bottom controls bar -->
        <div class="vm-bar">
          <!-- Left: duration -->
          <div class="vm-bar-group left">
            ${duration > 0 && html`
              <span style="font-size:13px;color:rgba(255,255,255,0.7);font-variant-numeric:tabular-nums">
                ${formatDuration(duration)}
              </span>
            `}
          </div>

          <!-- Center: mic, camera, screen, end-call pill -->
          <div class="vm-bar-group center">
            <!-- Mic toggle -->
            <div class="vm-btn-wrap">
              <button
                class=${`vm-btn${micMuted ? " muted" : ""}`}
                onClick=${handleToggleMic}
                title=${micMuted ? "Unmute mic" : "Mute mic"}
              >
                ${micMuted ? "🔇" : "🎙"}
              </button>
              <span class="vm-btn-label">${micMuted ? "Unmute" : "Mute"}</span>
            </div>

            <!-- Camera toggle -->
            <div class="vm-btn-wrap">
              <button
                class=${`vm-btn${visionState === "streaming" && visionSource === "camera" ? " screen-on" : ""}`}
                onClick=${handleToggleCameraShare}
                disabled=${!canShareCamera}
                title=${canShareCamera ? (visionState === "streaming" && visionSource === "camera" ? "Stop camera" : "Share camera") : (!canShareVision ? "Session required" : "Camera not supported in this browser")}
              >
                ${visionState === "streaming" && visionSource === "camera" ? "📷" : "📷"}
              </button>
              <span class="vm-btn-label">${visionState === "streaming" && visionSource === "camera" ? "Stop cam" : "Camera"}</span>
            </div>

            <!-- Screen share toggle -->
            <div class="vm-btn-wrap">
              <button
                class=${`vm-btn${visionState === "streaming" && visionSource === "screen" ? " screen-on" : ""}`}
                onClick=${handleToggleScreenShare}
                disabled=${!canShareScreen}
                title=${canShareScreen ? (visionState === "streaming" && visionSource === "screen" ? "Stop screen share" : "Share screen") : (!canShareVision ? "Session required" : "Screen share not supported in this browser/runtime")}
              >
                🖥
              </button>
              <span class="vm-btn-label">${visionState === "streaming" && visionSource === "screen" ? "Stop share" : "Share screen"}</span>
            </div>

            <!-- End call pill -->
            <div class="vm-end-pill-wrap">
              <button class="vm-end-pill" onClick=${handleClose} title="End call">
                📵
              </button>
              <span class="vm-end-pill-label">End call</span>
            </div>
          </div>

          <!-- Right: chat toggle, people -->
          <div class="vm-bar-group right">
            ${!isCompactFollowMode && html`
              <div class="vm-btn-wrap">
                <button
                  class=${`vm-btn${chatOpen && sessionId ? " active" : ""}`}
                  onClick=${() => setChatOpen((p) => !p)}
                  disabled=${!sessionId}
                  title=${sessionId ? "Toggle chat panel" : "Session required"}
                >
                  💬
                </button>
                <span class="vm-btn-label">Chat</span>
              </div>
            `}
            <div class="vm-btn-wrap">
              <button class="vm-btn" title="Participants (coming soon)" disabled>
                👥
              </button>
              <span class="vm-btn-label">People</span>
            </div>
          </div>
        </div>
      </div>
    `}

    <!-- Floating minimized PiP widget -->
    ${minimized && html`
      <div class="vm-floating">
        <input
          ref=${meetingFileInputRef}
          type="file"
          accept="image/*,application/pdf,.pdf"
          multiple
          style="display:none"
          onChange=${(e) => {
            const files = e?.target?.files;
            if (files?.length) uploadMeetingAttachments(files);
            if (e?.target) e.target.value = "";
          }}
        />
        <div class="vm-floating-header" onClick=${handleExpand} title="Expand call">
          <div class=${`vm-floating-orb ${state}`}>
            ${state === "speaking" ? "🔊" : state === "listening" ? "👂" : state === "thinking" ? "💭" : state === "connecting" ? "⟳" : "📵"}
          </div>
          <div class="vm-floating-header-info">
            <div class="vm-floating-title">
              ${normalizedCallType === "video" ? "Video Call" : "AI Agent Call"}
            </div>
            <div class="vm-floating-sub">
              ${statusLabel}${duration > 0 ? ` · ${formatDuration(duration)}` : ""}
            </div>
          </div>
        </div>
        ${(liveTranscriptText || liveResponseText) && html`
          <div class="vm-floating-transcript">
            ${liveResponseText || liveTranscriptText}
          </div>
        `}
        <div class="vm-floating-actions">
          <button
            class=${`vm-floating-mic${micMuted ? " muted" : ""}`}
            onClick=${handleToggleMic}
            title=${micMuted ? "Unmute" : "Mute"}
          >${micMuted ? "🔇" : "🎙"}</button>
          <button
            class="vm-floating-expand"
            onClick=${() => meetingFileInputRef.current?.click?.()}
            title="Attach image/PDF"
          >📎</button>
          <button
            class="vm-floating-expand"
            onClick=${() => captureScreenAttachment().catch(() => {})}
            title="Capture screenshot"
          >📸</button>
          <button class="vm-floating-expand" onClick=${handleExpand}>Expand</button>
          <button class="vm-floating-end" onClick=${handleClose} title="End call">📵</button>
        </div>
        <div style="padding:0 12px 10px;display:flex;gap:6px;align-items:center">
          <input
            class="voice-overlay-chat-input"
            style="padding:6px 12px;font-size:12px"
            placeholder="Quick message…"
            value=${floatingChatInput}
            onInput=${(e) => setFloatingChatInput(e.target.value)}
            onPaste=${(e) => {
              const files = e.clipboardData?.files;
              if (files && files.length > 0) {
                e.preventDefault();
                uploadMeetingAttachments(files);
              }
            }}
            onKeyDown=${(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendMeetingChat(floatingChatInput).catch(() => {});
              }
            }}
          />
          <button
            class="vm-floating-mic"
            onClick=${() => handleSendMeetingChat(floatingChatInput).catch(() => {})}
            disabled=${meetingChatSending || (!floatingChatInput.trim() && meetingPendingAttachments.length === 0)}
            title="Send"
          >↑</button>
        </div>
        ${meetingPendingAttachments.length > 0 && html`
          <div style="padding:0 12px 12px;display:flex;gap:6px;flex-wrap:wrap">
            ${meetingPendingAttachments.map((att, index) => html`
              <button
                class="vm-floating-expand"
                style="flex:0 1 auto;padding:0 8px;height:30px"
                onClick=${() => removeMeetingAttachment(index)}
                title="Remove attachment"
              >
                ${(att?.name || "attachment")} ✕
              </button>
            `)}
          </div>
        `}
      </div>
    `}
  `;
}
