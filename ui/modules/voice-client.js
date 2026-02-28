/**
 * voice-client.js — Tier 1 WebRTC voice client for OpenAI/Azure Realtime API.
 *
 * Manages WebRTC connection, audio I/O, data channel for events,
 * tool call dispatching, and auto-reconnect at 28 minutes.
 *
 * @module voice-client
 */

import { signal, computed } from "@preact/signals";

// ── State Signals ───────────────────────────────────────────────────────────

export const voiceState = signal("idle"); // idle | connecting | connected | speaking | listening | thinking | error | reconnecting
export const voiceTranscript = signal(""); // current utterance transcript
export const voiceResponse = signal(""); // current assistant response text
export const voiceError = signal(null);
export const voiceToolCalls = signal([]); // active tool calls
export const voiceSessionId = signal(null);
export const voiceDuration = signal(0); // seconds connected

export const isVoiceActive = computed(() =>
  voiceState.value !== "idle" && voiceState.value !== "error"
);

// ── Module-scope state ──────────────────────────────────────────────────────

let _pc = null;               // RTCPeerConnection
let _dc = null;               // DataChannel for events
let _mediaStream = null;      // User mic MediaStream
let _audioElement = null;      // <audio> for playback
let _reconnectTimer = null;    // 28-min reconnect timer
let _durationTimer = null;     // Duration counter
let _sessionStartTime = 0;
let _eventHandlers = new Map();

const RECONNECT_AT_MS = 28 * 60 * 1000; // 28 minutes
const MAX_RECONNECT_ATTEMPTS = 3;
let _reconnectAttempts = 0;

// ── Event System ────────────────────────────────────────────────────────────

export function onVoiceEvent(event, handler) {
  if (!_eventHandlers.has(event)) _eventHandlers.set(event, new Set());
  _eventHandlers.get(event).add(handler);
  return () => _eventHandlers.get(event)?.delete(handler);
}

function emit(event, data) {
  const handlers = _eventHandlers.get(event);
  if (handlers) {
    for (const handler of handlers) {
      try { handler(data); } catch (err) {
        console.error(`[voice-client] event handler error (${event}):`, err);
      }
    }
  }
}

// ── Core Connection ─────────────────────────────────────────────────────────

/**
 * Start a voice session.
 * 1. Fetch ephemeral token from server
 * 2. Get user mic
 * 3. Create RTCPeerConnection
 * 4. Set up data channel for events
 * 5. Create offer, set remote answer
 */
export async function startVoiceSession() {
  if (_pc) {
    console.warn("[voice-client] Session already active");
    return;
  }

  voiceState.value = "connecting";
  voiceError.value = null;
  voiceTranscript.value = "";
  voiceResponse.value = "";
  voiceToolCalls.value = [];
  _reconnectAttempts = 0;

  try {
    // 1. Fetch ephemeral token
    const tokenRes = await fetch("/api/voice/token", { method: "POST" });
    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({ error: "Token fetch failed" }));
      throw new Error(err.error || `Token fetch failed (${tokenRes.status})`);
    }
    const tokenData = await tokenRes.json();

    // 2. Get microphone
    _mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 24000,
      },
    });

    // 3. Create RTCPeerConnection
    _pc = new RTCPeerConnection();

    // Add mic track
    for (const track of _mediaStream.getTracks()) {
      _pc.addTrack(track, _mediaStream);
    }

    // Set up remote audio playback
    _audioElement = new Audio();
    _audioElement.autoplay = true;
    _pc.ontrack = (event) => {
      _audioElement.srcObject = event.streams[0];
    };

    // 4. Set up data channel for events
    _dc = _pc.createDataChannel("oai-events");
    _dc.onopen = () => {
      voiceState.value = "connected";
      _sessionStartTime = Date.now();
      voiceSessionId.value = `voice-${Date.now()}`;
      startDurationTimer();
      startReconnectTimer();
      emit("connected", { provider: tokenData.provider });
    };
    _dc.onclose = () => {
      if (voiceState.value !== "reconnecting") {
        handleDisconnect("data channel closed");
      }
    };
    _dc.onmessage = (event) => {
      try {
        handleServerEvent(JSON.parse(event.data));
      } catch (err) {
        console.error("[voice-client] Failed to parse server event:", err);
      }
    };

    // 5. Create and set local offer
    const offer = await _pc.createOffer();
    await _pc.setLocalDescription(offer);

    // 6. Send offer to OpenAI/Azure and get answer
    const baseUrl = tokenData.provider === "azure"
      ? `${tokenData.azureEndpoint}/openai/realtime?api-version=2025-04-01-preview&deployment=${tokenData.azureDeployment}`
      : `https://api.openai.com/v1/realtime?model=${tokenData.model}`;

    const sdpResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.token}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!sdpResponse.ok) {
      throw new Error(`WebRTC SDP exchange failed (${sdpResponse.status})`);
    }

    const answerSdp = await sdpResponse.text();
    await _pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    emit("session-started", { sessionId: voiceSessionId.value });
  } catch (err) {
    console.error("[voice-client] Failed to start voice session:", err);
    voiceState.value = "error";
    voiceError.value = err.message;
    emit("error", { message: err.message });
    cleanup();
  }
}

/**
 * Stop the current voice session.
 */
export function stopVoiceSession() {
  emit("session-ending", { sessionId: voiceSessionId.value });
  cleanup();
  voiceState.value = "idle";
  voiceTranscript.value = "";
  voiceResponse.value = "";
  voiceToolCalls.value = [];
  voiceSessionId.value = null;
  voiceDuration.value = 0;
  emit("session-ended", {});
}

// ── Server Event Handling ───────────────────────────────────────────────────

function handleServerEvent(event) {
  const type = event.type;

  switch (type) {
    case "session.created":
    case "session.updated":
      emit("session-updated", event.session);
      break;

    case "input_audio_buffer.speech_started":
      voiceState.value = "listening";
      emit("speech-started", {});
      break;

    case "input_audio_buffer.speech_stopped":
      voiceState.value = "thinking";
      emit("speech-stopped", {});
      break;

    case "conversation.item.input_audio_transcription.completed":
      voiceTranscript.value = event.transcript || "";
      emit("transcript", { text: event.transcript, final: true });
      break;

    case "response.audio_transcript.delta":
      voiceResponse.value += event.delta || "";
      emit("response-delta", { delta: event.delta });
      break;

    case "response.audio_transcript.done":
      emit("response-complete", { text: voiceResponse.value });
      voiceResponse.value = "";
      break;

    case "response.audio.delta":
      // Audio is handled via WebRTC tracks, not data channel
      break;

    case "response.created":
      voiceState.value = "thinking";
      break;

    case "response.output_item.added":
      if (event.item?.type === "function_call") {
        voiceState.value = "thinking";
      }
      break;

    case "response.function_call_arguments.done":
      handleToolCall(event);
      break;

    case "response.done":
      if (voiceState.value !== "listening") {
        voiceState.value = "connected";
      }
      break;

    case "error":
      console.error("[voice-client] Server error:", event.error);
      voiceError.value = event.error?.message || "Server error";
      emit("error", event.error);
      break;

    case "rate_limits.updated":
      emit("rate-limits", event.rate_limits);
      break;

    default:
      // Unknown event type — log but don't break
      break;
  }
}

// ── Tool Call Handling ───────────────────────────────────────────────────────

async function handleToolCall(event) {
  const callId = event.call_id;
  const name = event.name;
  let args = {};
  try {
    args = JSON.parse(event.arguments || "{}");
  } catch {
    args = {};
  }

  // Show tool call in UI
  voiceToolCalls.value = [...voiceToolCalls.value, { callId, name, args, status: "running" }];
  emit("tool-call-start", { callId, name, args });

  try {
    // Execute tool via server
    const res = await fetch("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: name, args, sessionId: voiceSessionId.value }),
    });
    const result = await res.json();

    // Update tool call status
    voiceToolCalls.value = voiceToolCalls.value.map(tc =>
      tc.callId === callId ? { ...tc, status: "complete", result: result.result } : tc
    );

    // Send result back to model via data channel
    if (_dc && _dc.readyState === "open") {
      _dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: result.result || result.error || "No output",
        },
      }));
      // Trigger response generation
      _dc.send(JSON.stringify({ type: "response.create" }));
    }

    emit("tool-call-complete", { callId, name, result: result.result });
  } catch (err) {
    voiceToolCalls.value = voiceToolCalls.value.map(tc =>
      tc.callId === callId ? { ...tc, status: "error", error: err.message } : tc
    );
    emit("tool-call-error", { callId, name, error: err.message });

    // Send error result back
    if (_dc && _dc.readyState === "open") {
      _dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: `Error: ${err.message}`,
        },
      }));
      _dc.send(JSON.stringify({ type: "response.create" }));
    }
  }
}

// ── Barge-in ────────────────────────────────────────────────────────────────

/**
 * Interrupt the current response (barge-in).
 */
export function interruptResponse() {
  if (_dc && _dc.readyState === "open") {
    _dc.send(JSON.stringify({ type: "response.cancel" }));
    emit("interrupt", {});
  }
}

// ── Send text message via data channel ──────────────────────────────────────

export function sendTextMessage(text) {
  if (!_dc || _dc.readyState !== "open") {
    console.warn("[voice-client] Cannot send text — data channel not open");
    return;
  }
  _dc.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  }));
  _dc.send(JSON.stringify({ type: "response.create" }));
}

// ── Reconnect Logic ─────────────────────────────────────────────────────────

function startReconnectTimer() {
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    reconnect();
  }, RECONNECT_AT_MS);
}

async function reconnect() {
  if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    handleDisconnect("max reconnect attempts reached");
    return;
  }

  voiceState.value = "reconnecting";
  _reconnectAttempts++;
  emit("reconnecting", { attempt: _reconnectAttempts });

  // Clean up old connection but keep mic stream
  const stream = _mediaStream;
  _mediaStream = null; // prevent cleanup from stopping it
  cleanupConnection();
  _mediaStream = stream;

  try {
    await startVoiceSession();
  } catch (err) {
    console.error("[voice-client] Reconnect failed:", err);
    if (_reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      setTimeout(() => { reconnect().catch(e => console.error("[voice-client] Reconnect error:", e)); }, 2000 * _reconnectAttempts);
    } else {
      handleDisconnect("reconnect failed");
    }
  }
}

// ── Duration Timer ──────────────────────────────────────────────────────────

function startDurationTimer() {
  clearInterval(_durationTimer);
  _durationTimer = setInterval(() => {
    voiceDuration.value = Math.floor((Date.now() - _sessionStartTime) / 1000);
  }, 1000);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function handleDisconnect(reason) {
  console.warn("[voice-client] Disconnected:", reason);
  cleanup();
  voiceState.value = "idle";
  voiceError.value = reason;
  emit("disconnected", { reason });
}

function cleanupConnection() {
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;

  if (_dc) {
    try { _dc.close(); } catch { /* ignore */ }
    _dc = null;
  }
  if (_pc) {
    try { _pc.close(); } catch { /* ignore */ }
    _pc = null;
  }
  if (_audioElement) {
    try {
      _audioElement.pause();
      _audioElement.srcObject = null;
    } catch { /* ignore */ }
    _audioElement = null;
  }
}

function cleanup() {
  cleanupConnection();

  clearInterval(_durationTimer);
  _durationTimer = null;

  if (_mediaStream) {
    for (const track of _mediaStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    _mediaStream = null;
  }
}
