/**
 * voice-client.js — Tier 1 WebRTC voice client for OpenAI/Azure Realtime API.
 *
 * Manages WebRTC connection, audio I/O, data channel for events,
 * tool call dispatching, and auto-reconnect at 28 minutes.
 *
 * @module voice-client
 */

import { signal, computed } from "@preact/signals";
import {
  ensureMicTrackingPatched,
  registerMicStream,
  stopTrackedMicStreams,
} from "./mic-track-registry.js";
import {
  shouldAutoBargeIn,
  shouldAutoBargeInFromMicLevel,
} from "./voice-barge-in.js";

// ── State Signals ───────────────────────────────────────────────────────────

export const voiceState = signal("idle"); // idle | connecting | connected | speaking | listening | thinking | error | reconnecting
export const voiceTranscript = signal(""); // current utterance transcript
export const voiceResponse = signal(""); // current assistant response text
export const voiceError = signal(null);
export const voiceToolCalls = signal([]); // active tool calls
export const voiceSessionId = signal(null);
export const voiceBoundSessionId = signal(null);
export const voiceDuration = signal(0); // seconds connected

export const isVoiceActive = computed(() =>
  voiceState.value !== "idle" && voiceState.value !== "error"
);
export const isVoiceMicMuted = signal(false);

// ── Audio Device Selection ──────────────────────────────────────────────────

/** @type {import("@preact/signals").Signal<MediaDeviceInfo[]>} */
export const audioInputDevices = signal([]);
/** @type {import("@preact/signals").Signal<MediaDeviceInfo[]>} */
export const audioOutputDevices = signal([]);
/** @type {import("@preact/signals").Signal<string>} selected input device ID ("" = default) */
export const selectedAudioInput = signal("");
/** @type {import("@preact/signals").Signal<string>} selected output device ID ("" = default) */
export const selectedAudioOutput = signal("");
/** @type {import("@preact/signals").Signal<number>} mic input level 0-1 */
export const micInputLevel = signal(0);

/** Audio processing preferences (persisted via voice overlay settings) */
export const audioSettings = signal({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  sampleRate: 24000,
});

let _micLevelAnalyser = null;
let _micLevelTimer = null;

/**
 * Enumerate available audio devices.
 * Must be called after getUserMedia to get device labels.
 */
export async function enumerateAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioInputDevices.value = devices.filter(d => d.kind === "audioinput");
    audioOutputDevices.value = devices.filter(d => d.kind === "audiooutput");
  } catch {
    audioInputDevices.value = [];
    audioOutputDevices.value = [];
  }
}

/**
 * Switch the microphone input device mid-session.
 * @param {string} deviceId
 */
export async function switchAudioInput(deviceId) {
  selectedAudioInput.value = deviceId;
  if (!_mediaStream) return;
  try {
    ensureMicTrackingPatched();
    // Stop existing mic tracks
    for (const track of _mediaStream.getAudioTracks()) {
      track.stop();
    }
    const settings = audioSettings.value;
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        sampleRate: settings.sampleRate,
      },
    });
    registerMicStream(newStream);
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) return;

    // Replace track in the peer connection
    if (_pc) {
      const sender = _pc.getSenders().find(s => s.track?.kind === "audio");
      if (sender) {
        await sender.replaceTrack(newTrack);
      }
    }

    // Replace in our saved reference
    _mediaStream = newStream;
    _startMicLevelMonitor(newStream);
    await enumerateAudioDevices();
  } catch (err) {
    console.warn("[voice-client] switchAudioInput failed:", err);
  }
}

/**
 * Switch the audio output device (speaker/headphone).
 * Uses HTMLMediaElement.setSinkId() — available in most modern browsers.
 * @param {string} deviceId
 */
export async function switchAudioOutput(deviceId) {
  selectedAudioOutput.value = deviceId;
  try {
    if (_audioElement && typeof _audioElement.setSinkId === "function") {
      await _audioElement.setSinkId(deviceId);
    }
    if (_responsesAudioElement && typeof _responsesAudioElement.setSinkId === "function") {
      await _responsesAudioElement.setSinkId(deviceId);
    }
  } catch (err) {
    console.warn("[voice-client] switchAudioOutput failed:", err);
  }
}

/**
 * Update audio processing settings and apply to active stream.
 * @param {Partial<typeof audioSettings.value>} updates
 */
export function updateAudioSettings(updates) {
  audioSettings.value = { ...audioSettings.value, ...updates };
  // Apply constraints to active tracks
  if (_mediaStream) {
    const settings = audioSettings.value;
    for (const track of _mediaStream.getAudioTracks()) {
      track.applyConstraints({
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
      }).catch(() => {});
    }
  }
}

function _startMicLevelMonitor(stream) {
  _stopMicLevelMonitor();
  try {
    const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    src.connect(analyser);
    _micLevelAnalyser = { ctx, analyser, buffer: new Uint8Array(analyser.frequencyBinCount) };
    _micLevelTimer = setInterval(() => {
      if (!_micLevelAnalyser) return;
      _micLevelAnalyser.analyser.getByteFrequencyData(_micLevelAnalyser.buffer);
      const sum = _micLevelAnalyser.buffer.reduce((a, v) => a + v, 0);
      const avg = sum / _micLevelAnalyser.buffer.length;
      const level = Math.min(1, avg / 128);
      micInputLevel.value = level;
      if (shouldAutoBargeInFromMicLevel({
        speaking: voiceState.value === "speaking",
        level,
        threshold: AUTO_BARGE_IN_MIC_LEVEL_THRESHOLD,
      })) {
        triggerAutoBargeIn("mic-level");
      }
    }, 100);
  } catch {
    // AudioContext might not be available
  }
}

function _stopMicLevelMonitor() {
  if (_micLevelTimer) {
    clearInterval(_micLevelTimer);
    _micLevelTimer = null;
  }
  if (_micLevelAnalyser) {
    try { _micLevelAnalyser.ctx.close(); } catch { /* ignore */ }
    _micLevelAnalyser = null;
  }
  micInputLevel.value = 0;
}

// ── Module-scope state ──────────────────────────────────────────────────────

let _pc = null;               // RTCPeerConnection
let _dc = null;               // DataChannel for events
let _mediaStream = null;      // User mic MediaStream
let _audioElement = null;      // <audio> for playback
let _transport = "webrtc";     // webrtc | websocket | responses-audio
let _responsesTokenData = null;
let _responsesRecognition = null;
let _responsesAudioElement = null;

// ── WebSocket transport state ───────────────────────────────────────────────
let _ws = null;                // WebSocket for Azure Realtime
let _wsAudioCtx = null;        // AudioContext for WebSocket PCM16 I/O
let _wsMicProcessor = null;    // ScriptProcessorNode for mic capture
let _wsMicSource = null;       // MediaStreamAudioSourceNode
let _wsPlaybackQueue = [];     // Queued PCM16 Float32 chunks for playback
let _wsPlaybackScheduled = 0;  // AudioContext time of next scheduled chunk
let _wsPlaybackPlaying = false; // Whether audio playback loop is running
let _responsesAbortController = null;
let _responsesRecognitionRestartTimer = null;
let _reconnectTimer = null;    // 28-min reconnect timer
let _durationTimer = null;     // Duration counter
let _sessionStartTime = 0;
let _eventHandlers = new Map();
let _explicitStop = false;     // user-initiated stop; suppresses reconnect/error noise
let _reconnectInFlight = false;
let _audioAutoplayWarned = false;
let _callContext = {
  sessionId: null,
  executor: null,
  mode: null,
  model: null,
  voiceAgentId: null,
};
let _lastPersistedUserTranscript = "";
let _lastPersistedAssistantTranscript = "";
let _lastPersistedUserAt = 0;
let _lastPersistedAssistantAt = 0;
let _awaitingToolCompletionAck = false;
let _assistantRespondedAfterTool = false;
let _toolCompletionAckTimer = null;
let _lastAutoBargeInAt = 0;
let _autoBargeInTimer = null;

const RECONNECT_AT_MS = 28 * 60 * 1000; // 28 minutes
const MAX_RECONNECT_ATTEMPTS = 3;
const AUTO_BARGE_IN_COOLDOWN_MS = 700;
const AUTO_BARGE_IN_MIC_LEVEL_THRESHOLD = 0.08;
const AUTO_BARGE_IN_FADE_MS = 220;
// Noise-control default: disable user-side live ASR transcript output/persistence.
// Assistant response text remains enabled.
const ENABLE_USER_TRANSCRIPT = false;
let _reconnectAttempts = 0;
let _pendingResponseCreateTimer = null;
let _awaitingAutoResponse = false;
const SpeechRecognition = typeof globalThis !== "undefined"
  ? (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)
  : null;

function _normalizeCallContext(options = {}) {
  const sessionId = String(options?.sessionId || "").trim() || null;
  const executor = String(options?.executor || "").trim() || null;
  const mode = String(options?.mode || "").trim() || null;
  const model = String(options?.model || "").trim() || null;
  const voiceAgentId = String(options?.voiceAgentId || "").trim() || null;
  return { sessionId, executor, mode, model, voiceAgentId };
}

function _isResponsesAudioTransport(tokenData) {
  return String(tokenData?.transport || "").trim().toLowerCase() === "responses-audio";
}

function _toDataUrl(base64, mimeType = "audio/mpeg") {
  const bytes = String(base64 || "").trim();
  if (!bytes) return "";
  return `data:${mimeType};base64,${bytes}`;
}

function _startResponsesRecognition() {
  if (_explicitStop) return;
  if (_transport !== "responses-audio") return;
  if (voiceState.value === "idle" || voiceState.value === "error") return;
  if (!_responsesRecognition) return;
  if (_responsesRecognitionRestartTimer) {
    clearTimeout(_responsesRecognitionRestartTimer);
    _responsesRecognitionRestartTimer = null;
  }
  try {
    _responsesRecognition.start();
  } catch {
    // best effort
  }
}

function _stopResponsesRecognition() {
  if (_responsesRecognitionRestartTimer) {
    clearTimeout(_responsesRecognitionRestartTimer);
    _responsesRecognitionRestartTimer = null;
  }
  if (_responsesRecognition) {
    try { _responsesRecognition.abort(); } catch { /* ignore */ }
    _responsesRecognition = null;
  }
}

async function _playResponsesAudio(base64, mimeType = "audio/mpeg") {
  const dataUrl = _toDataUrl(base64, mimeType);
  if (!dataUrl) return;
  if (!_responsesAudioElement) {
    _responsesAudioElement = new Audio();
  }
  const audio = _responsesAudioElement;
  audio.src = dataUrl;
  audio.autoplay = true;
  await new Promise((resolve, reject) => {
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Audio playback failed"));
    };
    const cleanup = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.play().catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

async function _processResponsesAudioTurn(text) {
  const inputText = String(text || "").trim();
  if (!inputText) return;
  if (!_responsesTokenData) {
    throw new Error("Audio responses transport not initialized");
  }

  voiceState.value = "thinking";
  if (ENABLE_USER_TRANSCRIPT) {
    voiceTranscript.value = inputText;
    emit("transcript", { text: inputText, final: true });
  } else {
    voiceTranscript.value = "";
  }
  _recordVoiceTranscriptIfNew("user", inputText, "responses-audio.user_input");

  if (_responsesAbortController) {
    try { _responsesAbortController.abort(); } catch { /* ignore */ }
  }
  _responsesAbortController = new AbortController();

  const res = await fetch("/api/voice/audio/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: _responsesAbortController.signal,
    body: JSON.stringify({
      inputText,
      sessionId: _callContext.sessionId || undefined,
      executor: _callContext.executor || undefined,
      mode: _callContext.mode || undefined,
      model: _callContext?.model || _responsesTokenData?.model || undefined,
      voiceId: _responsesTokenData?.voiceId || undefined,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `Audio response failed (${res.status})` }));
    throw new Error(err.error || `Audio response failed (${res.status})`);
  }

  const data = await res.json();
  const responseText = String(data?.text || "").trim();
  if (responseText) {
    voiceResponse.value = responseText;
    emit("response-complete", { text: responseText });
    _recordVoiceTranscriptIfNew("assistant", responseText, "responses-audio.assistant_output");
  }

  const audioBase64 = String(data?.audioBase64 || "").trim();
  if (audioBase64) {
    voiceState.value = "speaking";
    await _playResponsesAudio(audioBase64, data?.audioMimeType || "audio/mpeg");
  }

  voiceResponse.value = "";
  voiceState.value = "listening";
}

async function _startResponsesAudioSession(tokenData) {
  if (!SpeechRecognition) {
    throw new Error("Browser speech recognition is unavailable for gpt-audio mode");
  }
  _transport = "responses-audio";
  _responsesTokenData = tokenData || {};
  _responsesAbortController = null;

  _responsesRecognition = new SpeechRecognition();
  _responsesRecognition.continuous = false;
  _responsesRecognition.interimResults = true;
  _responsesRecognition.lang = navigator?.language || "en-US";
  _responsesRecognition.maxAlternatives = 1;

  _responsesRecognition.onstart = () => {
    if (voiceState.value !== "speaking" && voiceState.value !== "thinking") {
      voiceState.value = "listening";
    }
  };

  _responsesRecognition.onresult = (event) => {
    let transcript = "";
    let isFinal = false;
    for (const result of event.results) {
      transcript += result[0]?.transcript || "";
      if (result.isFinal) isFinal = true;
    }
    voiceTranscript.value = transcript;
    if (isFinal && transcript.trim()) {
      _processResponsesAudioTurn(transcript.trim())
        .catch((err) => {
          voiceState.value = "error";
          voiceError.value = err.message;
          emit("error", { message: err.message });
        })
        .finally(() => {
          if (voiceState.value !== "error") {
            _startResponsesRecognition();
          }
        });
    }
  };

  _responsesRecognition.onerror = (event) => {
    if (event?.error === "no-speech") {
      if (_explicitStop || _transport !== "responses-audio") return;
      _responsesRecognitionRestartTimer = setTimeout(() => {
        _responsesRecognitionRestartTimer = null;
        _startResponsesRecognition();
      }, 250);
      return;
    }
    if (event?.error === "aborted") return;
    const msg = `Speech recognition error: ${event?.error || "unknown"}`;
    voiceState.value = "error";
    voiceError.value = msg;
    emit("error", { message: msg });
  };

  _responsesRecognition.onend = () => {
    if (voiceState.value === "listening") {
      if (_explicitStop || _transport !== "responses-audio") return;
      _responsesRecognitionRestartTimer = setTimeout(() => {
        _responsesRecognitionRestartTimer = null;
        _startResponsesRecognition();
      }, 220);
    }
  };

  voiceSessionId.value = _callContext.sessionId || `voice-${Date.now()}`;
  _sessionStartTime = Date.now();
  startDurationTimer();
  voiceState.value = "connected";
  emit("connected", {
    provider: tokenData?.provider || "openai",
    sessionId: voiceSessionId.value,
    callContext: { ..._callContext },
    transport: "responses-audio",
  });
  _startResponsesRecognition();
}

async function _recordVoiceTranscript(role, content, eventType = "") {
  const sessionId = String(_callContext?.sessionId || voiceSessionId.value || "").trim();
  const text = String(content || "").trim();
  if (!sessionId || !text) return;
  try {
    const res = await fetch("/api/voice/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        role,
        content: text,
        eventType,
        executor: _callContext?.executor || undefined,
        mode: _callContext?.mode || undefined,
        model: _callContext?.model || undefined,
      }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const detail = String(payload?.error || res.statusText || "request failed").trim();
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
  } catch (err) {
    console.warn("[voice-client] transcript persistence failed:", err?.message || err);
  }
}

function _recordVoiceTranscriptIfNew(role, content, eventType = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const text = String(content || "").trim();
  if (!text) return;
  const now = Date.now();

  if (normalizedRole === "user") {
    if (text === _lastPersistedUserTranscript && now - _lastPersistedUserAt <= 2500) return;
    _lastPersistedUserTranscript = text;
    _lastPersistedUserAt = now;
  } else if (normalizedRole === "assistant") {
    if (text === _lastPersistedAssistantTranscript && now - _lastPersistedAssistantAt <= 2500) return;
    _lastPersistedAssistantTranscript = text;
    _lastPersistedAssistantAt = now;
  }

  _recordVoiceTranscript(normalizedRole, text, eventType);
}

function _clearToolCompletionAckTimer() {
  if (_toolCompletionAckTimer) {
    clearTimeout(_toolCompletionAckTimer);
    _toolCompletionAckTimer = null;
  }
}

function _markToolCompletionPending() {
  _awaitingToolCompletionAck = true;
  _assistantRespondedAfterTool = false;
  _clearToolCompletionAckTimer();
  _toolCompletionAckTimer = setTimeout(() => {
    _toolCompletionAckTimer = null;
    if (!_awaitingToolCompletionAck || _assistantRespondedAfterTool) return;
    emit("response-complete", { text: "Done." });
    _recordVoiceTranscriptIfNew(
      "assistant",
      "Done.",
      "tool_call.done.auto_ack.timeout",
    );
    _awaitingToolCompletionAck = false;
    _assistantRespondedAfterTool = false;
  }, 6000);
}

function _markAssistantToolResponseObserved() {
  if (!_awaitingToolCompletionAck) return;
  _assistantRespondedAfterTool = true;
  _awaitingToolCompletionAck = false;
  _clearToolCompletionAckTimer();
}

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

function sendRealtimeEvent(payload) {
  // WebSocket transport: send over WS
  if (_transport === "websocket") return _sendWsEvent(payload);
  // WebRTC transport: send over data channel
  if (!_dc || _dc.readyState !== "open") return false;
  try {
    _dc.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn("[voice-client] failed to send realtime event:", err?.message || err);
    return false;
  }
}

function clearPendingResponseCreate() {
  if (_pendingResponseCreateTimer) {
    clearTimeout(_pendingResponseCreateTimer);
    _pendingResponseCreateTimer = null;
  }
  _awaitingAutoResponse = false;
}

function scheduleManualResponseCreate(reason = "speech-stopped") {
  if (_transport !== "webrtc" && _transport !== "websocket") return;
  if (_awaitingAutoResponse) return;
  // Check appropriate channel is open
  if (_transport === "webrtc" && (!_dc || _dc.readyState !== "open")) return;
  if (_transport === "websocket" && (!_ws || _ws.readyState !== WebSocket.OPEN)) return;
  _awaitingAutoResponse = true;
  if (_pendingResponseCreateTimer) clearTimeout(_pendingResponseCreateTimer);
  _pendingResponseCreateTimer = setTimeout(() => {
    _pendingResponseCreateTimer = null;
    if (!_awaitingAutoResponse) return;
    const sent = sendRealtimeEvent({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
      },
    });
    if (sent) {
      console.info(`[voice-client] sent fallback response.create (${reason})`);
    }
    _awaitingAutoResponse = false;
  }, 650);
}

function sendSessionUpdate(tokenData = {}) {
  const sessionConfig = tokenData?.sessionConfig || {};
  const voiceId = String(
    tokenData?.voiceId || sessionConfig?.voice || "alloy",
  ).trim() || "alloy";
  const turnDetection =
    sessionConfig?.turn_detection?.type ||
    sessionConfig?.audio?.input?.turnDetection?.type ||
    sessionConfig?.audio?.input?.turn_detection?.type ||
    "semantic_vad";
  const turnDetectionConfig = {
    type: turnDetection,
    ...(turnDetection === "server_vad"
      ? {
          threshold: 0.7,
          prefix_padding_ms: 400,
          silence_duration_ms: 1200,
          create_response: true,
          interrupt_response: true,
        }
      : {}),
    ...(turnDetection === "semantic_vad"
      ? {
          eagerness: "medium",
          create_response: true,
          interrupt_response: true,
        }
      : {}),
  };

  // Use server-provided transcription model from sessionConfig, fall back to default
  const transcriptionModel =
    sessionConfig?.input_audio_transcription?.model || "gpt-4o-transcribe";
  const transcriptionEnabled =
    sessionConfig?.input_audio_transcription !== undefined;

  sendRealtimeEvent({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      voice: voiceId,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      ...(transcriptionEnabled
        ? { input_audio_transcription: { model: transcriptionModel } }
        : {}),
      turn_detection: turnDetectionConfig,
    },
  });
}

// ── WebSocket Realtime Transport ─────────────────────────────────────────────
//
// Azure OpenAI Realtime API only supports WebSocket in many deployments
// (WebRTC returns 404).  This transport captures mic audio as PCM16 chunks,
// sends them over WebSocket, receives response audio as PCM16 deltas, and
// plays them through AudioContext — giving the same real-time conversational
// voice experience as WebRTC.

/** Convert Float32 audio samples to Int16 PCM. */
function _float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

/** Convert Int16 PCM to Float32 audio samples. */
function _int16ToFloat32(int16Array) {
  const float32 = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32[i] = int16Array[i] / (int16Array[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return float32;
}

/** Encode Int16Array to base64 string (browser). */
function _int16ToBase64(int16Array) {
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode base64 string to Int16Array. */
function _base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

/** Send a JSON event over the WebSocket transport. */
function _sendWsEvent(payload) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return false;
  try {
    _ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn("[voice-client] WS send failed:", err?.message || err);
    return false;
  }
}

/** Play queued PCM16 audio chunks via AudioContext. */
function _scheduleWsPlayback() {
  if (_wsPlaybackPlaying) return;
  _wsPlaybackPlaying = true;

  const drain = () => {
    if (!_wsAudioCtx || _wsPlaybackQueue.length === 0 || _explicitStop) {
      _wsPlaybackPlaying = false;
      return;
    }

    const samples = _wsPlaybackQueue.shift();
    const buffer = _wsAudioCtx.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    const sourceNode = _wsAudioCtx.createBufferSource();
    sourceNode.buffer = buffer;

    // Route through selected output device if supported
    if (selectedAudioOutput.value && typeof _wsAudioCtx.setSinkId === "function") {
      try { _wsAudioCtx.setSinkId(selectedAudioOutput.value); } catch { /* ignore */ }
    }

    sourceNode.connect(_wsAudioCtx.destination);

    const now = _wsAudioCtx.currentTime;
    const startTime = Math.max(now, _wsPlaybackScheduled);
    sourceNode.start(startTime);
    _wsPlaybackScheduled = startTime + buffer.duration;

    sourceNode.onended = () => {
      if (_wsPlaybackQueue.length > 0) {
        drain();
      } else {
        _wsPlaybackPlaying = false;
        if (voiceState.value === "speaking") {
          voiceState.value = "connected";
        }
      }
    };
  };

  drain();
}

/** Clean up WebSocket transport resources. */
function _cleanupWsTransport() {
  if (_wsMicProcessor) {
    try { _wsMicProcessor.disconnect(); } catch { /* ignore */ }
    _wsMicProcessor = null;
  }
  if (_wsMicSource) {
    try { _wsMicSource.disconnect(); } catch { /* ignore */ }
    _wsMicSource = null;
  }
  if (_ws) {
    try { _ws.close(); } catch { /* ignore */ }
    _ws = null;
  }
  if (_wsAudioCtx) {
    try { _wsAudioCtx.close(); } catch { /* ignore */ }
    _wsAudioCtx = null;
  }
  _wsPlaybackQueue = [];
  _wsPlaybackScheduled = 0;
  _wsPlaybackPlaying = false;
}

/**
 * Start a WebSocket-based Realtime session.
 * Used as fallback when Azure WebRTC SDP exchange returns 404.
 */
async function _startWebSocketTransport(tokenData, mediaStream) {
  const wsUrl = String(tokenData?.wsUrl || "").trim();
  if (!wsUrl) {
    throw new Error("WebSocket URL not available for Azure Realtime fallback");
  }

  _transport = "websocket";

  // Set up AudioContext for PCM16 I/O at 24kHz (Realtime API native rate)
  _wsAudioCtx = new (globalThis.AudioContext || globalThis.webkitAudioContext)({
    sampleRate: 24000,
  });

  return new Promise((resolve, reject) => {
    _ws = new WebSocket(wsUrl);

    const connectTimeout = setTimeout(() => {
      reject(new Error("Azure Realtime WebSocket connection timed out"));
      if (_ws) { try { _ws.close(); } catch { /* ignore */ } }
    }, 15000);

    _ws.onopen = () => {
      clearTimeout(connectTimeout);

      // Send session configuration (same as WebRTC data channel session.update)
      sendSessionUpdate(tokenData);

      // Start mic capture → PCM16 → WebSocket
      _wsMicSource = _wsAudioCtx.createMediaStreamSource(mediaStream);
      // ScriptProcessorNode deprecated but widely supported; buffer = 4096 samples
      _wsMicProcessor = _wsAudioCtx.createScriptProcessor(4096, 1, 1);
      _wsMicProcessor.onaudioprocess = (e) => {
        if (_explicitStop || !_ws || _ws.readyState !== WebSocket.OPEN) return;
        if (isVoiceMicMuted.value) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = _float32ToInt16(float32);
        const base64 = _int16ToBase64(int16);
        _sendWsEvent({
          type: "input_audio_buffer.append",
          audio: base64,
        });
      };
      _wsMicSource.connect(_wsMicProcessor);
      _wsMicProcessor.connect(_wsAudioCtx.destination); // required for processing

      voiceState.value = "connected";
      voiceSessionId.value = _callContext.sessionId || `voice-ws-${Date.now()}`;
      _sessionStartTime = Date.now();
      startDurationTimer();

      emit("connected", {
        provider: tokenData.provider || "azure",
        sessionId: voiceSessionId.value,
        callContext: { ..._callContext },
        transport: "websocket",
      });

      resolve();
    };

    _ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Handle audio deltas — play PCM16 through AudioContext
        if (msg.type === "response.audio.delta" && msg.delta) {
          if (voiceState.value !== "speaking") {
            voiceState.value = "speaking";
          }
          const int16 = _base64ToInt16(msg.delta);
          const float32 = _int16ToFloat32(int16);
          _wsPlaybackQueue.push(float32);
          _scheduleWsPlayback();
          return;
        }

        if (msg.type === "response.audio.done") {
          // Audio stream complete — playback will finish via onended callback
          return;
        }

        // All other events go through the standard handler
        handleServerEvent(msg);
      } catch (err) {
        console.error("[voice-client] WS message parse error:", err);
      }
    };

    _ws.onerror = (event) => {
      clearTimeout(connectTimeout);
      const msg = "Azure Realtime WebSocket error";
      console.error("[voice-client] WebSocket error:", event);
      if (voiceState.value === "connecting") {
        reject(new Error(msg));
      } else {
        voiceState.value = "error";
        voiceError.value = msg;
        emit("error", { message: msg });
      }
    };

    _ws.onclose = (event) => {
      clearTimeout(connectTimeout);
      if (_explicitStop) return;
      const reason = `WebSocket closed (code=${event.code})`;
      if (voiceState.value === "connecting") {
        reject(new Error(reason));
      } else {
        handleDisconnect(reason);
      }
    };
  });
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
export async function startVoiceSession(options = {}) {
  ensureMicTrackingPatched();
  if (_pc) {
    console.warn("[voice-client] Session already active");
    return;
  }

  _callContext = _normalizeCallContext(options);
  _explicitStop = false;
  voiceBoundSessionId.value = _callContext.sessionId;
  voiceState.value = "connecting";
  voiceError.value = null;
  voiceTranscript.value = "";
  voiceResponse.value = "";
  voiceToolCalls.value = [];
  _lastPersistedUserTranscript = "";
  _lastPersistedAssistantTranscript = "";
  _lastPersistedUserAt = 0;
  _lastPersistedAssistantAt = 0;
  _awaitingToolCompletionAck = false;
  _assistantRespondedAfterTool = false;
  _clearToolCompletionAckTimer();
  _reconnectAttempts = 0;

  try {
    // 1. Fetch ephemeral token
    const tokenRes = await fetch("/api/voice/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: _callContext.sessionId || undefined,
        executor: _callContext.executor || undefined,
        mode: _callContext.mode || undefined,
        model: _callContext.model || undefined,
        voiceAgentId: _callContext.voiceAgentId || undefined,
        delegateOnly: false,
      }),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({ error: "Token fetch failed" }));
      throw new Error(err.error || `Token fetch failed (${tokenRes.status})`);
    }
    const tokenData = await tokenRes.json();
    if (_isResponsesAudioTransport(tokenData)) {
      await _startResponsesAudioSession(tokenData);
      emit("session-started", {
        sessionId: voiceSessionId.value,
        callContext: { ..._callContext },
        transport: "responses-audio",
      });
      return;
    }
    _transport = "webrtc";

    // 2. Get microphone
    const mediaDevices = navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      const host = String(globalThis.location?.hostname || "").toLowerCase();
      const localhostLike =
        host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!globalThis.isSecureContext && !localhostLike) {
        throw new Error(
          "Microphone access requires HTTPS (or localhost). Open the UI via the Cloudflare HTTPS URL or localhost.",
        );
      }
      throw new Error("Microphone API unavailable in this browser/runtime.");
    }

    _mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedAudioInput.value ? { exact: selectedAudioInput.value } : undefined,
        echoCancellation: audioSettings.value.echoCancellation,
        noiseSuppression: audioSettings.value.noiseSuppression,
        autoGainControl: audioSettings.value.autoGainControl,
        sampleRate: audioSettings.value.sampleRate,
      },
    });
    registerMicStream(_mediaStream);

    // Guard: stopVoiceSession() may have been called while getUserMedia() was
    // still awaiting (e.g. the user pressed hang-up during the permission
    // prompt or network delay).  cleanup() already ran without this stream
    // in the registry — release the mic immediately so the browser indicator
    // goes away instead of staying lit indefinitely.
    if (_explicitStop) {
      for (const track of _mediaStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      _mediaStream = null;
      throw new Error("voice session was stopped during microphone acquisition");
    }

    await enumerateAudioDevices();
    _startMicLevelMonitor(_mediaStream);

    // 3. Create RTCPeerConnection
    _pc = new RTCPeerConnection();

    // Add mic track
    for (const track of _mediaStream.getTracks()) {
      track.enabled = true;
      _pc.addTrack(track, _mediaStream);
    }

    // Set up remote audio playback.
    // Start muted so the browser's autoplay policy allows the element to begin
    // playing before a fresh user gesture is required; we unmute immediately
    // after attaching srcObject so audio arrives unmuted from the start.
    _audioElement = new Audio();
    _audioElement.autoplay = true;
    _audioElement.playsInline = true;
    _audioElement.muted = true;
    // Apply selected output device
    if (selectedAudioOutput.value && typeof _audioElement.setSinkId === "function") {
      try { await _audioElement.setSinkId(selectedAudioOutput.value); } catch { /* ignore */ }
    }
    _pc.ontrack = (event) => {
      _audioElement.srcObject = event.streams[0];
      // Unmute now that the element is already playing (avoids autoplay block)
      _audioElement.muted = false;
      const track = event.track;
      if (track && typeof track.addEventListener === "function") {
        track.addEventListener("unmute", () => {
          ensureRemoteAudioPlayback().catch(() => {});
        });
      }
      ensureRemoteAudioPlayback().catch(() => {});
    };

    // 4. Set up data channel for events
    _dc = _pc.createDataChannel("oai-events");
    _dc.onopen = () => {
      sendSessionUpdate(tokenData);
      voiceState.value = "connected";
      _sessionStartTime = Date.now();
      voiceSessionId.value = _callContext.sessionId || `voice-${Date.now()}`;
      startDurationTimer();
      startReconnectTimer();
      emit("connected", {
        provider: tokenData.provider,
        sessionId: voiceSessionId.value,
        callContext: { ..._callContext },
      });
    };
    _dc.onclose = () => {
      if (_explicitStop) return;
      if (voiceState.value === "reconnecting" || _reconnectInFlight) return;
      safeReconnect("data channel closed").catch(() => {
        handleDisconnect("data channel closed");
      });
    };
    _dc.onmessage = (event) => {
      try {
        handleServerEvent(JSON.parse(event.data));
      } catch (err) {
        console.error("[voice-client] Failed to parse server event:", err);
      }
    };

    _pc.onconnectionstatechange = () => {
      const state = String(_pc?.connectionState || "").toLowerCase();
      if (_explicitStop) return;
      if (state === "failed" || state === "disconnected") {
        if (voiceState.value === "reconnecting" || _reconnectInFlight) return;
        safeReconnect(`peer connection ${state}`).catch(() => {
          handleDisconnect(`peer connection ${state}`);
        });
      }
    };

    // 5. Create and set local offer
    const offer = await _pc.createOffer();
    await _pc.setLocalDescription(offer);

    // 6. Send offer to OpenAI/Azure and get answer
    // Prefer the server-provided WebRTC URL (handles custom endpoints, Azure deployments, api-versions).
    const baseUrl = tokenData.url
      || (tokenData.provider === "azure"
        ? `${tokenData.azureEndpoint}/openai/realtime?api-version=2025-04-01-preview&deployment=${tokenData.azureDeployment}`
        : `https://api.openai.com/v1/realtime?model=${tokenData.model}`);

    let webrtcFailed = false;
    let webrtcFailStatus = 0;
    try {
      const sdpResponse = await fetch(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.token}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });

      if (!sdpResponse.ok) {
        webrtcFailStatus = sdpResponse.status;
        const errBody = await sdpResponse.text().catch(() => "");
        const detail = errBody ? ` — ${errBody.slice(0, 300)}` : "";
        // For Azure, 404 means the resource doesn't support WebRTC — try WebSocket
        if (sdpResponse.status === 404 && tokenData.wsUrl) {
          console.warn("[voice-client] WebRTC SDP 404 — falling back to Azure WebSocket transport");
          webrtcFailed = true;
        } else {
          throw new Error(`WebRTC SDP exchange failed (${sdpResponse.status})${detail}`);
        }
      }

      if (!webrtcFailed) {
        const answerSdp = await sdpResponse.text();
        await _pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      }
    } catch (sdpErr) {
      if (!webrtcFailed) throw sdpErr;
    }

    // ── WebSocket fallback for Azure when WebRTC returns 404 ────────────
    if (webrtcFailed) {
      // Clean up the WebRTC objects — we won't need them
      if (_dc) { try { _dc.close(); } catch { /* ignore */ } _dc = null; }
      if (_pc) { try { _pc.close(); } catch { /* ignore */ } _pc = null; }
      if (_audioElement) {
        try { _audioElement.pause(); _audioElement.srcObject = null; } catch { /* ignore */ }
        _audioElement = null;
      }

      console.info("[voice-client] Starting Azure Realtime WebSocket transport");
      await _startWebSocketTransport(tokenData, _mediaStream);

      emit("session-started", {
        sessionId: voiceSessionId.value,
        callContext: { ..._callContext },
        transport: "websocket",
      });
      return;
    }

    emit("session-started", {
      sessionId: voiceSessionId.value,
      callContext: { ..._callContext },
    });
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
  _explicitStop = true;
  emit("session-ending", { sessionId: voiceSessionId.value });
  _stopMicLevelMonitor();
  cleanup();
  voiceState.value = "idle";
  voiceTranscript.value = "";
  voiceResponse.value = "";
  voiceToolCalls.value = [];
  voiceSessionId.value = null;
  voiceBoundSessionId.value = null;
  voiceDuration.value = 0;
  _callContext = {
    sessionId: null,
    executor: null,
    mode: null,
    model: null,
    voiceAgentId: null,
  };
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
      triggerAutoBargeIn("speech-started");
      voiceState.value = "listening";
      emit("speech-started", {});
      break;

    case "input_audio_buffer.speech_stopped":
      voiceState.value = "thinking";
      scheduleManualResponseCreate("speech-stopped");
      emit("speech-stopped", {});
      break;

    case "conversation.item.input_audio_transcription.completed":
      if (ENABLE_USER_TRANSCRIPT) {
        voiceTranscript.value = event.transcript || "";
        emit("transcript", { text: event.transcript, final: true });
      } else {
        voiceTranscript.value = "";
      }
      _recordVoiceTranscriptIfNew(
        "user",
        event.transcript || "",
        "conversation.item.input_audio_transcription.completed",
      );
      scheduleManualResponseCreate("transcription-completed");
      break;

    case "conversation.item.created": {
      const role = String(event?.item?.role || "").toLowerCase();
      const content = Array.isArray(event?.item?.content) ? event.item.content : [];
      if (role === "user") {
        const transcript = content
          .map((part) => String(part?.transcript || part?.text || ""))
          .join("")
          .trim();
        if (transcript && ENABLE_USER_TRANSCRIPT) {
          voiceTranscript.value = transcript;
          emit("transcript", { text: transcript, final: true });
        } else if (!ENABLE_USER_TRANSCRIPT) {
          voiceTranscript.value = "";
        }
        _recordVoiceTranscriptIfNew(
          "user",
          transcript,
          "conversation.item.created.user",
        );
      } else if (role === "assistant") {
        const response = content
          .map((part) => String(part?.transcript || part?.text || ""))
          .join("")
          .trim();
        if (response) _markAssistantToolResponseObserved();
        _recordVoiceTranscriptIfNew(
          "assistant",
          response,
          "conversation.item.created.assistant",
        );
      }
      break;
    }

    case "response.audio_transcript.delta":
      _markAssistantToolResponseObserved();
      voiceResponse.value += event.delta || "";
      emit("response-delta", { delta: event.delta });
      break;

    case "response.text.delta":
      _markAssistantToolResponseObserved();
      voiceResponse.value += event.delta || "";
      emit("response-delta", { delta: event.delta });
      break;

    case "response.output_text.delta":
      _markAssistantToolResponseObserved();
      voiceResponse.value += event.delta || "";
      emit("response-delta", { delta: event.delta });
      break;

    case "response.audio_transcript.done":
      if (voiceResponse.value) _markAssistantToolResponseObserved();
      emit("response-complete", { text: voiceResponse.value });
      _recordVoiceTranscriptIfNew(
        "assistant",
        voiceResponse.value,
        "response.audio_transcript.done",
      );
      voiceResponse.value = "";
      break;

    case "response.text.done":
      if (voiceResponse.value) _markAssistantToolResponseObserved();
      emit("response-complete", { text: voiceResponse.value });
      _recordVoiceTranscriptIfNew(
        "assistant",
        voiceResponse.value,
        "response.text.done",
      );
      voiceResponse.value = "";
      break;

    case "response.output_text.done":
      if (voiceResponse.value) _markAssistantToolResponseObserved();
      emit("response-complete", { text: voiceResponse.value });
      _recordVoiceTranscriptIfNew(
        "assistant",
        voiceResponse.value,
        "response.output_text.done",
      );
      voiceResponse.value = "";
      break;

    case "response.audio.delta":
      // WebRTC: audio is handled via media tracks, not data channel.
      // WebSocket: audio deltas are handled in the ws.onmessage handler
      // before reaching handleServerEvent, so this case is a no-op.
      break;

    case "conversation.item.input_audio_transcription.failed":
      clearPendingResponseCreate();
      voiceError.value = event.error?.message || "Input transcription failed";
      emit("error", event.error || { message: voiceError.value });
      break;

    case "response.created":
      clearPendingResponseCreate();
      voiceState.value = "thinking";
      break;

    case "response.output_item.added":
      if (event.item?.type === "function_call") {
        voiceState.value = "thinking";
      }
      break;

    case "response.function_call_arguments.done":
      handleToolCall(event).catch((err) => {
        console.error("[voice-client] Tool call handling failed:", err);
      });
      break;

    case "response.done":
      clearPendingResponseCreate();
      if (_awaitingToolCompletionAck && !_assistantRespondedAfterTool && !voiceResponse.value) {
        emit("response-complete", { text: "Done." });
        _recordVoiceTranscriptIfNew(
          "assistant",
          "Done.",
          "tool_call.done.auto_ack.response_done",
        );
        _awaitingToolCompletionAck = false;
        _assistantRespondedAfterTool = false;
        _clearToolCompletionAckTimer();
      }
      if (voiceResponse.value) {
        _recordVoiceTranscriptIfNew(
          "assistant",
          voiceResponse.value,
          "response.done.fallback",
        );
        voiceResponse.value = "";
      }
      if (voiceState.value !== "listening") {
        voiceState.value = "connected";
      }
      break;

    case "error":
      clearPendingResponseCreate();
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
    if (typeof event.arguments === "string") {
      args = JSON.parse(event.arguments || "{}");
    } else if (event.arguments && typeof event.arguments === "object") {
      args = event.arguments;
    } else {
      args = {};
    }
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
      body: JSON.stringify({
        toolName: name,
        args,
        sessionId: voiceSessionId.value,
        executor: _callContext.executor || undefined,
        mode: _callContext.mode || undefined,
        model: _callContext.model || undefined,
        voiceAgentId: _callContext.voiceAgentId || undefined,
      }),
    });
    const result = await res.json();

    // Update tool call status
    voiceToolCalls.value = voiceToolCalls.value.map(tc =>
      tc.callId === callId ? { ...tc, status: "complete", result: result.result } : tc
    );

    // Send result back to model via data channel or WebSocket
    sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: result.result || result.error || "No output",
      },
    });
    // Trigger response generation
    sendRealtimeEvent({ type: "response.create" });

    const stillRunning = voiceToolCalls.value.some((tc) => tc.status === "running");
    if (!stillRunning) {
      _markToolCompletionPending();
    }
    emit("tool-call-complete", { callId, name, result: result.result });
  } catch (err) {
    voiceToolCalls.value = voiceToolCalls.value.map(tc =>
      tc.callId === callId ? { ...tc, status: "error", error: err.message } : tc
    );
    emit("tool-call-error", { callId, name, error: err.message });

    // Send error result back
    sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: `Error: ${err.message}`,
      },
    });
    sendRealtimeEvent({ type: "response.create" });
  }
}

// ── Barge-in ────────────────────────────────────────────────────────────────

function isAssistantPlaybackActive() {
  if (_transport === "responses-audio") {
    return Boolean(_responsesAudioElement && !_responsesAudioElement.paused && !_responsesAudioElement.ended);
  }
  if (_transport === "websocket") {
    return Boolean(_wsPlaybackPlaying || _wsPlaybackQueue.length > 0);
  }
  return Boolean(_audioElement && !_audioElement.paused);
}

function fadeElementVolumeTo(el, targetVolume, durationMs) {
  if (!el) return;
  const target = Math.max(0, Math.min(1, Number(targetVolume)));
  const duration = Math.max(40, Number(durationMs) || 180);
  const start = Math.max(0, Math.min(1, Number(el.volume)));
  const steps = 5;
  const stepMs = Math.max(10, Math.floor(duration / steps));
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    const t = Math.min(1, step / steps);
    const next = start + (target - start) * t;
    try { el.volume = Math.max(0, Math.min(1, next)); } catch { /* ignore */ }
    if (t >= 1) clearInterval(timer);
  }, stepMs);
}

function triggerAutoBargeIn(reason = "speech-started") {
  const now = Date.now();
  const audioActive = isAssistantPlaybackActive();
  if (!shouldAutoBargeIn({
    muted: isVoiceMicMuted.value,
    audioActive,
    now,
    lastTriggeredAt: _lastAutoBargeInAt,
    minIntervalMs: AUTO_BARGE_IN_COOLDOWN_MS,
  })) {
    return false;
  }
  _lastAutoBargeInAt = now;
  if (_autoBargeInTimer) {
    clearTimeout(_autoBargeInTimer);
    _autoBargeInTimer = null;
  }
  if (_transport === "responses-audio" && _responsesAudioElement) {
    fadeElementVolumeTo(_responsesAudioElement, 0.1, AUTO_BARGE_IN_FADE_MS);
    _autoBargeInTimer = setTimeout(() => {
      _autoBargeInTimer = null;
      interruptResponse();
      emit("auto-barge-in", { reason });
    }, AUTO_BARGE_IN_FADE_MS);
    return true;
  }
  if (_transport === "webrtc" && _audioElement) {
    fadeElementVolumeTo(_audioElement, 0.12, AUTO_BARGE_IN_FADE_MS);
    _autoBargeInTimer = setTimeout(() => {
      _autoBargeInTimer = null;
      interruptResponse();
      emit("auto-barge-in", { reason });
    }, AUTO_BARGE_IN_FADE_MS);
    return true;
  }
  interruptResponse();
  emit("auto-barge-in", { reason });
  return true;
}

/**
 * Interrupt the current response (barge-in).
 */
export function interruptResponse() {
  if (_transport === "responses-audio") {
    if (_responsesAbortController) {
      try { _responsesAbortController.abort(); } catch { /* ignore */ }
      _responsesAbortController = null;
    }
    if (_responsesAudioElement) {
      try {
        _responsesAudioElement.pause();
        _responsesAudioElement.currentTime = 0;
        _responsesAudioElement.volume = 1;
      } catch { /* ignore */ }
    }
    voiceState.value = "listening";
    emit("interrupt", {});
    return;
  }
  // WebSocket transport: cancel response and clear playback queue
  if (_transport === "websocket") {
    _sendWsEvent({ type: "response.cancel" });
    _wsPlaybackQueue = [];
    _wsPlaybackPlaying = false;
    voiceState.value = "listening";
    emit("interrupt", {});
    return;
  }
  if (_dc && _dc.readyState === "open") {
    _dc.send(JSON.stringify({ type: "response.cancel" }));
    if (_audioElement) {
      try { _audioElement.volume = 1; } catch { /* ignore */ }
    }
    voiceState.value = "listening";
    emit("interrupt", {});
  }
}

// ── Send text message via data channel ──────────────────────────────────────

export function sendTextMessage(text) {
  const inputText = String(text || "").trim();
  if (!inputText) return;
  if (_transport === "responses-audio") {
    _recordVoiceTranscriptIfNew("user", inputText, "send_text_message.responses_audio");
    _processResponsesAudioTurn(inputText).catch((err) => {
      voiceState.value = "error";
      voiceError.value = err.message;
      emit("error", { message: err.message });
    });
    return;
  }
  // WebRTC or WebSocket: send via the shared sendRealtimeEvent helper
  if (_transport === "websocket" && (!_ws || _ws.readyState !== WebSocket.OPEN)) {
    console.warn("[voice-client] Cannot send text — WebSocket not open");
    return;
  }
  if (_transport === "webrtc" && (!_dc || _dc.readyState !== "open")) {
    console.warn("[voice-client] Cannot send text — data channel not open");
    return;
  }
  sendRealtimeEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: inputText }],
    },
  });
  _recordVoiceTranscriptIfNew("user", inputText, "send_text_message");
  sendRealtimeEvent({ type: "response.create" });
}

/**
 * Stream an image frame into the legacy realtime data channel without forcing
 * an immediate response turn. Returns true when sent to realtime transport.
 */
export function sendImageFrame(imageDataUrl, options = {}) {
  if (_transport === "responses-audio") return false;
  const imageUrl = String(imageDataUrl || "").trim();
  if (!imageUrl) return false;
  // WebSocket transport: use sendRealtimeEvent
  if (_transport === "websocket" && (!_ws || _ws.readyState !== WebSocket.OPEN)) return false;
  if (_transport === "webrtc" && (!_dc || _dc.readyState !== "open")) return false;
  const source = String(options?.source || "screen").trim() || "screen";
  const width = Number(options?.width) || undefined;
  const height = Number(options?.height) || undefined;
  try {
    sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "low",
          },
        ],
      },
      metadata: {
        source: "vision_stream",
        sourceType: source,
        width,
        height,
      },
    });
    return true;
  } catch (err) {
    console.warn("[voice-client] failed to send realtime image frame:", err?.message || err);
    return false;
  }
}

// ── Reconnect Logic ─────────────────────────────────────────────────────────

function startReconnectTimer() {
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    reconnect().catch((err) => {
      console.error("[voice-client] Reconnect timer error:", err);
    });
  }, RECONNECT_AT_MS);
}

async function reconnect() {
  if (_explicitStop) return;
  if (_reconnectInFlight) return;
  _reconnectInFlight = true;
  if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    _reconnectInFlight = false;
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
    await startVoiceSession(_callContext);
    _reconnectInFlight = false;
  } catch (err) {
    console.error("[voice-client] Reconnect failed:", err);
    if (_reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      _reconnectInFlight = false;
      setTimeout(() => { reconnect().catch(e => console.error("[voice-client] Reconnect error:", e)); }, 2000 * _reconnectAttempts);
    } else {
      _reconnectInFlight = false;
      handleDisconnect("reconnect failed");
    }
  }
}

async function ensureRemoteAudioPlayback() {
  if (!_audioElement) return false;
  if (!_audioElement.srcObject) return false;
  try {
    _audioElement.muted = false;
    _audioElement.volume = 1;
    await _audioElement.play();
    _audioAutoplayWarned = false;
    return true;
  } catch (err) {
    if (!_audioAutoplayWarned) {
      _audioAutoplayWarned = true;
      const msg =
        "Speaker playback was blocked by the browser. Tap the call overlay once to enable audio.";
      console.warn("[voice-client] remote audio autoplay blocked:", err?.message || err);
      voiceError.value = msg;
      emit("error", { message: msg });
    }
    return false;
  }
}

/**
 * Attempt to (re-)start the remote audio element — call this from any user
 * interaction (e.g. a tap on the call overlay) to unblock autoplay.
 * Safe to call even when there is no active session; returns false if there
 * is nothing to resume.
 */
export async function resumeVoiceAudio() {
  const ok = await ensureRemoteAudioPlayback();
  if (ok && _audioElement) {
    // Clear any lingering "playback blocked" error now that the user has
    // interacted and audio is confirmed playing.
    if (voiceError.value && String(voiceError.value).includes("Speaker playback")) {
      voiceError.value = null;
    }
    _audioAutoplayWarned = false;
  }
  return ok;
}

/**
 * Toggle microphone mute state for the active WebRTC session.
 * Immediately silences/restores the mic track without dropping the connection.
 * Returns the new muted state.
 */
export function toggleMicMute() {
  if (_mediaStream) {
    const tracks = _mediaStream.getAudioTracks();
    if (tracks.length > 0) {
      const willBeMuted = tracks[0].enabled; // enabled=true means currently unmuted
      for (const track of tracks) {
        track.enabled = !willBeMuted;
      }
      isVoiceMicMuted.value = willBeMuted;
      return willBeMuted;
    }
  }
  // responses-audio transport: can only mute the SpeechRecognition
  if (_transport === "responses-audio") {
    const willBeMuted = !isVoiceMicMuted.value;
    isVoiceMicMuted.value = willBeMuted;
    if (willBeMuted) {
      _stopResponsesRecognition();
    } else {
      _startResponsesRecognition();
    }
    return willBeMuted;
  }
  // websocket transport: mic muting is handled by the onaudioprocess guard
  if (_transport === "websocket") {
    const willBeMuted = !isVoiceMicMuted.value;
    isVoiceMicMuted.value = willBeMuted;
    return willBeMuted;
  }
  return isVoiceMicMuted.value;
}

async function safeReconnect(reason = "connection lost") {
  if (_explicitStop) return;
  try {
    await reconnect();
  } catch (err) {
    console.error("[voice-client] safeReconnect failed:", err);
    throw err;
  }
  if (voiceState.value === "idle" || voiceState.value === "error") {
    throw new Error(reason);
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
  clearPendingResponseCreate();

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
  // Always close the mic-level AudioContext first so no AudioContext
  // holds a live MediaStreamAudioSourceNode after teardown.  This path
  // is reached both by stopVoiceSession() and by handleDisconnect().
  _stopMicLevelMonitor();
  _reconnectInFlight = false;
  _audioAutoplayWarned = false;
  isVoiceMicMuted.value = false;
  cleanupConnection();
  _cleanupWsTransport();

  clearInterval(_durationTimer);
  _durationTimer = null;

  if (_mediaStream) {
    for (const track of _mediaStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    _mediaStream = null;
  }
  stopTrackedMicStreams();
  _stopResponsesRecognition();
  if (_responsesAbortController) {
    try { _responsesAbortController.abort(); } catch { /* ignore */ }
    _responsesAbortController = null;
  }
  if (_responsesAudioElement) {
    try {
      _responsesAudioElement.pause();
      _responsesAudioElement.src = "";
    } catch { /* ignore */ }
    _responsesAudioElement = null;
  }
  _responsesTokenData = null;
  _transport = "webrtc";
  _lastPersistedUserTranscript = "";
  _lastPersistedAssistantTranscript = "";
  _lastPersistedUserAt = 0;
  _lastPersistedAssistantAt = 0;
  _awaitingToolCompletionAck = false;
  _assistantRespondedAfterTool = false;
  _clearToolCompletionAckTimer();
  if (_autoBargeInTimer) {
    clearTimeout(_autoBargeInTimer);
    _autoBargeInTimer = null;
  }
  _lastAutoBargeInAt = 0;
}
