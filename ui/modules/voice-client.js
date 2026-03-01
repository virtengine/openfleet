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
export const voiceBoundSessionId = signal(null);
export const voiceDuration = signal(0); // seconds connected

export const isVoiceActive = computed(() =>
  voiceState.value !== "idle" && voiceState.value !== "error"
);

// ── Module-scope state ──────────────────────────────────────────────────────

let _pc = null;               // RTCPeerConnection
let _dc = null;               // DataChannel for events
let _mediaStream = null;      // User mic MediaStream
let _audioElement = null;      // <audio> for playback
let _transport = "webrtc";     // webrtc | responses-audio
let _responsesTokenData = null;
let _responsesRecognition = null;
let _responsesAudioElement = null;
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
};

const RECONNECT_AT_MS = 28 * 60 * 1000; // 28 minutes
const MAX_RECONNECT_ATTEMPTS = 3;
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
  return { sessionId, executor, mode, model };
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
  voiceTranscript.value = inputText;
  emit("transcript", { text: inputText, final: true });
  await _recordVoiceTranscript("user", inputText, "responses-audio.user_input");

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
    await _recordVoiceTranscript("assistant", responseText, "responses-audio.assistant_output");
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
    await fetch("/api/voice/transcript", {
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
  } catch (err) {
    console.warn("[voice-client] transcript persistence failed:", err?.message || err);
  }
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
  if (_transport !== "webrtc") return;
  if (_awaitingAutoResponse) return;
  if (!_dc || _dc.readyState !== "open") return;
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
    "server_vad";
  const turnDetectionConfig = {
    type: turnDetection,
    ...(turnDetection === "server_vad"
      ? {
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
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

  sendRealtimeEvent({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      voice: voiceId,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: turnDetectionConfig,
      audio: {
        input: {
          format: "pcm16",
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: turnDetectionConfig,
        },
        output: {
          format: "pcm16",
          voice: voiceId,
        },
      },
    },
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
        delegateOnly: Boolean(_callContext.sessionId),
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

    const sdpResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.token}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!sdpResponse.ok) {
      const errBody = await sdpResponse.text().catch(() => "");
      const detail = errBody ? ` — ${errBody.slice(0, 300)}` : "";
      throw new Error(`WebRTC SDP exchange failed (${sdpResponse.status})${detail}`);
    }

    const answerSdp = await sdpResponse.text();
    await _pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

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
  cleanup();
  voiceState.value = "idle";
  voiceTranscript.value = "";
  voiceResponse.value = "";
  voiceToolCalls.value = [];
  voiceSessionId.value = null;
  voiceBoundSessionId.value = null;
  voiceDuration.value = 0;
  _callContext = { sessionId: null, executor: null, mode: null, model: null };
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
      scheduleManualResponseCreate("speech-stopped");
      emit("speech-stopped", {});
      break;

    case "conversation.item.input_audio_transcription.completed":
      voiceTranscript.value = event.transcript || "";
      emit("transcript", { text: event.transcript, final: true });
      _recordVoiceTranscript(
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
        if (transcript) {
          voiceTranscript.value = transcript;
          emit("transcript", { text: transcript, final: true });
        }
      }
      break;
    }

    case "response.audio_transcript.delta":
      voiceResponse.value += event.delta || "";
      emit("response-delta", { delta: event.delta });
      break;

    case "response.text.delta":
      voiceResponse.value += event.delta || "";
      emit("response-delta", { delta: event.delta });
      break;

    case "response.output_text.delta":
      voiceResponse.value += event.delta || "";
      emit("response-delta", { delta: event.delta });
      break;

    case "response.audio_transcript.done":
      emit("response-complete", { text: voiceResponse.value });
      _recordVoiceTranscript(
        "assistant",
        voiceResponse.value,
        "response.audio_transcript.done",
      );
      voiceResponse.value = "";
      break;

    case "response.text.done":
      emit("response-complete", { text: voiceResponse.value });
      _recordVoiceTranscript(
        "assistant",
        voiceResponse.value,
        "response.text.done",
      );
      voiceResponse.value = "";
      break;

    case "response.output_text.done":
      emit("response-complete", { text: voiceResponse.value });
      _recordVoiceTranscript(
        "assistant",
        voiceResponse.value,
        "response.output_text.done",
      );
      voiceResponse.value = "";
      break;

    case "response.audio.delta":
      // Audio is handled via WebRTC tracks, not data channel
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
      body: JSON.stringify({
        toolName: name,
        args,
        sessionId: voiceSessionId.value,
        executor: _callContext.executor || undefined,
        mode: _callContext.mode || undefined,
        model: _callContext.model || undefined,
      }),
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
  if (_transport === "responses-audio") {
    if (_responsesAbortController) {
      try { _responsesAbortController.abort(); } catch { /* ignore */ }
      _responsesAbortController = null;
    }
    if (_responsesAudioElement) {
      try {
        _responsesAudioElement.pause();
        _responsesAudioElement.currentTime = 0;
      } catch { /* ignore */ }
    }
    voiceState.value = "listening";
    emit("interrupt", {});
    return;
  }
  if (_dc && _dc.readyState === "open") {
    _dc.send(JSON.stringify({ type: "response.cancel" }));
    emit("interrupt", {});
  }
}

// ── Send text message via data channel ──────────────────────────────────────

export function sendTextMessage(text) {
  if (_transport === "responses-audio") {
    _processResponsesAudioTurn(text).catch((err) => {
      voiceState.value = "error";
      voiceError.value = err.message;
      emit("error", { message: err.message });
    });
    return;
  }
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
  _reconnectInFlight = false;
  _audioAutoplayWarned = false;
  cleanupConnection();

  clearInterval(_durationTimer);
  _durationTimer = null;

  if (_mediaStream) {
    for (const track of _mediaStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    _mediaStream = null;
  }
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
}
