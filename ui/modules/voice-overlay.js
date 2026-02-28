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
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { haptic } from "./telegram.js";
import {
  voiceState, voiceTranscript, voiceResponse, voiceError,
  voiceToolCalls, voiceDuration,
  startVoiceSession, stopVoiceSession, interruptResponse,
} from "./voice-client.js";
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
  align-items: center;
  justify-content: center;
  color: #fff;
  font-family: var(--tg-theme-font, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  animation: voiceOverlayFadeIn 0.3s ease;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
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
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  padding: 24px;
  z-index: 2;
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
  `;
  document.head.appendChild(style);
}

// ── Format Duration ─────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Voice Overlay Component ─────────────────────────────────────────────────

/**
 * @param {{ visible: boolean, onClose: () => void, tier: number, sessionId?: string, executor?: string, mode?: string, model?: string }} props
 */
export function VoiceOverlay({
  visible,
  onClose,
  tier = 1,
  sessionId,
  executor,
  mode,
  model,
}) {
  const [started, setStarted] = useState(false);

  useEffect(() => { injectOverlayStyles(); }, []);

  // Use computed signals based on tier
  const state = tier === 1 ? voiceState.value : fallbackState.value;
  const transcript = tier === 1 ? voiceTranscript.value : fallbackTranscript.value;
  const response = tier === 1 ? voiceResponse.value : fallbackResponse.value;
  const error = tier === 1 ? voiceError.value : fallbackError.value;
  const toolCalls = tier === 1 ? voiceToolCalls.value : [];
  const duration = tier === 1 ? voiceDuration.value : 0;
  const visionState = visionShareState.value;
  const visionSource = visionShareSource.value;
  const visionErr = visionShareError.value;
  const latestVisionSummary = visionLastSummary.value;
  const canShareVision = Boolean(sessionId);

  // Start session on mount
  useEffect(() => {
    if (!visible || started) return;
    setStarted(true);
    if (tier === 1) {
      startVoiceSession({ sessionId, executor, mode, model });
    } else if (sessionId) {
      startFallbackSession(sessionId, { executor, mode, model });
    }
  }, [visible, started, tier, sessionId, executor, mode, model]);

  useEffect(() => {
    if (visible) return;
    stopVisionShare().catch(() => {});
  }, [visible]);

  const handleClose = useCallback(() => {
    haptic("medium");
    stopVisionShare().catch(() => {});
    if (tier === 1) {
      stopVoiceSession();
    } else {
      stopFallbackSession();
    }
    setStarted(false);
    onClose();
  }, [tier, onClose]);

  const handleInterrupt = useCallback(() => {
    haptic("light");
    if (tier === 1) {
      interruptResponse();
    } else {
      interruptFallback();
    }
  }, [tier]);

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

  return html`
    <div class="voice-overlay" onClick=${state === "speaking" ? handleInterrupt : undefined}>
      <!-- Header -->
      <div class="voice-overlay-header">
        <button class="voice-overlay-close" onClick=${handleClose} title="End voice session">
          ${resolveIcon("close")}
        </button>
        <div>
          <div class="voice-overlay-status">${statusLabel}</div>
          ${boundLabel && html`<div class="voice-overlay-bound">${boundLabel}</div>`}
          ${duration > 0 && html`
            <div class="voice-overlay-duration">${formatDuration(duration)}</div>
          `}
        </div>
        <div style="width: 40px" />
      </div>

      <!-- Center content -->
      <div class="voice-overlay-center">
        <!-- Orb visualization -->
        <div class="voice-orb-container">
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
  `;
}
