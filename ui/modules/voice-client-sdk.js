/**
 * voice-client-sdk.js — Client-side voice using @openai/agents SDK as primary,
 * with automatic fallback to legacy voice-client.js on failure.
 *
 * Provider strategy:
 *   - OpenAI/Azure: @openai/agents RealtimeSession (WebRTC, auto mic/speaker)
 *   - Gemini: WebSocket streaming via server proxy (Live API)
 *   - Claude/fallback: Falls through to voice-fallback.js (Web Speech API)
 *
 * The module exposes the same signal-based API as voice-client.js so
 * voice-overlay.js can switch transparently.
 *
 * @module voice-client-sdk
 */

import { signal, computed } from "@preact/signals";

// ── State Signals (same shape as voice-client.js) ───────────────────────────

export const sdkVoiceState = signal("idle");
export const sdkVoiceTranscript = signal("");
export const sdkVoiceResponse = signal("");
export const sdkVoiceError = signal(null);
export const sdkVoiceToolCalls = signal([]);
export const sdkVoiceSessionId = signal(null);
export const sdkVoiceBoundSessionId = signal(null);
export const sdkVoiceDuration = signal(0);
export const sdkVoiceProvider = signal(null);
export const sdkVoiceSdkActive = signal(false);

export const isSdkVoiceActive = computed(() =>
  sdkVoiceState.value !== "idle" && sdkVoiceState.value !== "error"
);

// ── Module-scope state ──────────────────────────────────────────────────────

let _session = null;
let _durationTimer = null;
let _sessionStartTime = 0;
let _eventHandlers = new Map();
let _geminiMicStream = null;
let _geminiRecorder = null;
let _callContext = {
  sessionId: null,
  executor: null,
  mode: null,
  model: null,
};
let _sdkConfig = null;
let _usingLegacyFallback = false;
let _sdkModuleUnavailableLogged = false;
let _agentsRealtimeModulePromise = null;
let _agentsRealtimeModuleSource = null;
let _lastPersistedUserTranscript = "";
let _lastPersistedAssistantTranscript = "";
let _pendingUserTranscriptTimer = null;
let _pendingAssistantTranscriptTimer = null;
let _pendingUserTranscriptText = "";
let _pendingAssistantTranscriptText = "";

// ── Event System ────────────────────────────────────────────────────────────

export function onSdkVoiceEvent(event, handler) {
  if (!_eventHandlers.has(event)) _eventHandlers.set(event, new Set());
  _eventHandlers.get(event).add(handler);
  return () => _eventHandlers.get(event)?.delete(handler);
}

function emit(event, data) {
  const handlers = _eventHandlers.get(event);
  if (handlers) {
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[voice-client-sdk] event handler error (${event}):`, err);
      }
    }
  }
}

function _normalizeCallContext(options = {}) {
  return {
    sessionId: String(options?.sessionId || "").trim() || null,
    executor: String(options?.executor || "").trim() || null,
    mode: String(options?.mode || "").trim() || null,
    model: String(options?.model || "").trim() || null,
  };
}

function getSdkErrorMessage(err) {
  if (!err) return "Session error";
  if (typeof err?.message === "string" && err.message.trim()) return err.message.trim();
  if (typeof err?.error?.message === "string" && err.error.message.trim()) return err.error.message.trim();
  if (typeof err?.error === "string" && err.error.trim()) return err.error.trim();
  return "Session error";
}

function isNonFatalSdkSessionError(err) {
  const message = getSdkErrorMessage(err);
  if (!message) return false;
  // Seen during transient renegotiation on some browsers even when stream remains active.
  if (/setRemoteDescription/i.test(message) && /SessionDescription/i.test(message)) {
    return true;
  }
  return false;
}

function isUsableAgentsRealtimeModule(mod) {
  return Boolean(mod && mod.RealtimeAgent && mod.RealtimeSession);
}

async function loadAgentsRealtimeModule() {
  if (_agentsRealtimeModulePromise) return _agentsRealtimeModulePromise;
  _agentsRealtimeModulePromise = (async () => {
    // 1) Prefer locally bundled dependency when available.
    try {
      const mod = await import("@openai/agents/realtime");
      if (isUsableAgentsRealtimeModule(mod)) {
        _agentsRealtimeModuleSource = "local-bundle";
        return mod;
      }
    } catch {
      // continue to browser ESM fallbacks
    }

    // 2) Browser-safe ESM fallbacks for non-bundled deployments.
    const sources = [
      "https://esm.sh/@openai/agents/realtime?bundle",
      "https://cdn.jsdelivr.net/npm/@openai/agents/realtime/+esm",
      "https://unpkg.com/@openai/agents/realtime?module",
    ];
    let lastErr = null;
    for (const source of sources) {
      try {
        const mod = await import(source);
        if (isUsableAgentsRealtimeModule(mod)) {
          _agentsRealtimeModuleSource = source;
          return mod;
        }
        lastErr = new Error(`Loaded SDK module from ${source}, but exports were incomplete`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Failed to load @openai/agents/realtime in browser");
  })();
  return _agentsRealtimeModulePromise;
}

// ── SDK Configuration Fetch ────────────────────────────────────────────────

/**
 * Fetch SDK configuration from the server.
 * Determines if we should use Agents SDK or legacy voice.
 */
async function fetchSdkConfig() {
  try {
    const res = await fetch("/api/voice/sdk-config", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      return { useSdk: false, reason: `Server returned ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { useSdk: false, reason: err.message };
  }
}

// ── Transcript persistence ──────────────────────────────────────────────────

async function _recordTranscript(role, content, eventType = "") {
  const sessionId = String(_callContext?.sessionId || sdkVoiceSessionId.value || "").trim();
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
        provider: sdkVoiceProvider.value || undefined,
      }),
    });
  } catch (err) {
    console.warn("[voice-client-sdk] transcript persistence failed:", err?.message || err);
  }
}

function _resetTranscriptPersistenceState() {
  _lastPersistedUserTranscript = "";
  _lastPersistedAssistantTranscript = "";
  _pendingUserTranscriptText = "";
  _pendingAssistantTranscriptText = "";
  if (_pendingUserTranscriptTimer) {
    clearTimeout(_pendingUserTranscriptTimer);
    _pendingUserTranscriptTimer = null;
  }
  if (_pendingAssistantTranscriptTimer) {
    clearTimeout(_pendingAssistantTranscriptTimer);
    _pendingAssistantTranscriptTimer = null;
  }
}

function _persistTranscriptIfNew(role, text, eventType) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const value = String(text || "").trim();
  if (!value) return;
  if (normalizedRole === "user") {
    if (value === _lastPersistedUserTranscript) return;
    _lastPersistedUserTranscript = value;
  } else if (normalizedRole === "assistant") {
    if (value === _lastPersistedAssistantTranscript) return;
    _lastPersistedAssistantTranscript = value;
  }
  _recordTranscript(normalizedRole, value, eventType);
}

function _scheduleUserTranscriptFinalize(text) {
  const value = String(text || "").trim();
  if (!value) return;
  _pendingUserTranscriptText = value;
  if (_pendingUserTranscriptTimer) clearTimeout(_pendingUserTranscriptTimer);
  _pendingUserTranscriptTimer = setTimeout(() => {
    _pendingUserTranscriptTimer = null;
    const finalText = String(_pendingUserTranscriptText || "").trim();
    if (!finalText) return;
    sdkVoiceTranscript.value = finalText;
    emit("transcript", { text: finalText, final: true });
    _persistTranscriptIfNew("user", finalText, "sdk.history_updated.user.final");
  }, 350);
}

function _scheduleAssistantTranscriptFinalize(text) {
  const value = String(text || "").trim();
  if (!value) return;
  _pendingAssistantTranscriptText = value;
  if (_pendingAssistantTranscriptTimer) clearTimeout(_pendingAssistantTranscriptTimer);
  _pendingAssistantTranscriptTimer = setTimeout(() => {
    _pendingAssistantTranscriptTimer = null;
    const finalText = String(_pendingAssistantTranscriptText || "").trim();
    if (!finalText) return;
    sdkVoiceState.value = "thinking";
    sdkVoiceResponse.value = finalText;
    emit("response-complete", { text: finalText });
    _persistTranscriptIfNew("assistant", finalText, "sdk.history_updated.assistant.final");
    sdkVoiceState.value = "listening";
  }, 700);
}

// ── OpenAI/Azure Agents SDK Session ─────────────────────────────────────────

/**
 * Start a voice session using @openai/agents RealtimeSession.
 * This runs entirely client-side with WebRTC auto-mic handling.
 */
async function startAgentsSdkSession(config, options = {}) {
  const resolvedConfig = config && typeof config === "object" ? config : {};
  // Dynamically import @openai/agents/realtime using browser-safe sources.
  const agentsMod = await loadAgentsRealtimeModule();
  const { RealtimeAgent, RealtimeSession } = agentsMod;

  if (!RealtimeAgent || !RealtimeSession) {
    throw new Error("@openai/agents/realtime not available in browser");
  }

  // Fetch token and tools from server
  const tokenRes = await fetch("/api/voice/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: _callContext.sessionId || undefined,
      executor: _callContext.executor || undefined,
      mode: _callContext.mode || undefined,
      model: _callContext.model || undefined,
      delegateOnly: Boolean(_callContext.sessionId),
      sdkMode: true,
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({ error: "Token fetch failed" }));
    throw new Error(err.error || `Token fetch failed (${tokenRes.status})`);
  }
  const tokenData = await tokenRes.json();

  // Create RealtimeAgent with server-provided instructions
  const agent = new RealtimeAgent({
    name: "Bosun Voice Agent",
    instructions: tokenData.instructions || "You are Bosun, a helpful voice assistant.",
    tools: (tokenData.tools || []).map((t) => {
      const executeTool = async (args) => {
        // Execute tool via server
        const res = await fetch("/api/voice/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toolName: t.name,
            args,
            sessionId: sdkVoiceSessionId.value,
            executor: _callContext.executor || undefined,
            mode: _callContext.mode || undefined,
            model: _callContext.model || undefined,
          }),
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok || result?.error) {
          const message = String(result?.error || `Tool ${t.name} failed (${res.status})`).trim();
          throw new Error(message || `Tool ${t.name} failed`);
        }
        return result.result || "No output";
      };
      return {
        type: "function",
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
        needsApproval() {
          return false;
        },
        requiresApproval() {
          return false;
        },
        execute: executeTool,
        invoke: executeTool,
      };
    }),
  });

  // Determine model and voice
  const model = String(tokenData.model || resolvedConfig.model || "gpt-realtime-1.5").trim();
  const voiceId = String(tokenData.voiceId || resolvedConfig.voiceId || "alloy").trim();
  const turnDetection = String(resolvedConfig.turnDetection || "server_vad").trim();
  const turnDetectionConfig = {
    type: turnDetection,
    ...(turnDetection === "server_vad"
      ? {
          threshold: 0.35,
          prefix_padding_ms: 400,
          silence_duration_ms: 700,
          create_response: true,
          interrupt_response: true,
          createResponse: true,
          interruptResponse: true,
        }
      : {}),
    ...(turnDetection === "semantic_vad"
      ? {
          eagerness: "medium",
          create_response: true,
          interrupt_response: true,
          createResponse: true,
          interruptResponse: true,
        }
      : {}),
  };

  // Create session with config
  const session = new RealtimeSession(agent, {
    model,
    config: {
      outputModalities: ["text", "audio"],
      audio: {
        input: {
          format: "pcm16",
          transcription: { model: "gpt-4o-transcribe" },
          turnDetection: turnDetectionConfig,
        },
        output: {
          format: "pcm16",
          voice: voiceId,
        },
      },
    },
  });

  // ── Wire up SDK events to our signals ──

  session.on("history_updated", (history) => {
    const items = history || [];
    const lastUserMsg = [...items].reverse().find(
      (item) => item.role === "user" && item.type === "message"
    );
    const lastAssistantMsg = [...items].reverse().find(
      (item) => item.role === "assistant" && item.type === "message"
    );

    if (lastUserMsg) {
      const transcript = lastUserMsg.content?.map((c) => c.transcript || c.text || "").join("") || "";
      if (transcript) {
        _scheduleUserTranscriptFinalize(transcript);
      }
    }

    if (lastAssistantMsg) {
      const response = lastAssistantMsg.content?.map((c) => c.transcript || c.text || "").join("") || "";
      if (response) {
        _scheduleAssistantTranscriptFinalize(response);
      }
    }

    emit("history-updated", { history: items });
  });

  session.on("audio_interrupted", () => {
    sdkVoiceState.value = "listening";
    emit("interrupt", {});
  });

  session.on("tool_call_start", (event) => {
    const callId = event?.callId || event?.call_id || `tc-${Date.now()}`;
    const name = event?.name || event?.toolName || "unknown";
    sdkVoiceToolCalls.value = [
      ...sdkVoiceToolCalls.value,
      { callId, name, status: "running" },
    ];
    sdkVoiceState.value = "thinking";
    emit("tool-call-start", { callId, name });
  });

  session.on("tool_call_done", (event) => {
    const callId = event?.callId || event?.call_id;
    sdkVoiceToolCalls.value = sdkVoiceToolCalls.value.map((tc) =>
      tc.callId === callId ? { ...tc, status: "complete" } : tc
    );
    emit("tool-call-complete", { callId });
  });

  session.on("error", (err) => {
    const message = getSdkErrorMessage(err);
    if (isNonFatalSdkSessionError(err)) {
      console.warn("[voice-client-sdk] transient session warning:", message);
      return;
    }
    console.error("[voice-client-sdk] session error:", err);
    sdkVoiceError.value = message;
    emit("error", { message });
  });

  session.on("guardrail_tripped", (event) => {
    emit("guardrail-tripped", event);
  });

  // Connect with the token
  const connectOpts = { apiKey: tokenData.token };

  const explicitRealtimeUrl = String(tokenData.url || "").trim();
  if (explicitRealtimeUrl) {
    // Always prefer server-resolved realtime URL so endpoint/model/api-version stay
    // aligned with the selected voice endpoint and provider protocol.
    connectOpts.url = explicitRealtimeUrl;
  } else if (tokenData.provider === "azure" && tokenData.azureEndpoint) {
    const endpoint = String(tokenData.azureEndpoint).replace(/\/+$/, "");
    const deployment = tokenData.azureDeployment || "gpt-realtime-1.5";
    connectOpts.url = `${endpoint}/openai/realtime?api-version=2025-04-01-preview&deployment=${deployment}`;
  } else if (tokenData.provider === "openai") {
    const model = String(tokenData.model || resolvedConfig.model || "gpt-realtime-1.5").trim();
    connectOpts.url = `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  }

  try {
    const safeUrl = String(connectOpts.url || "").trim();
    const parsed = safeUrl ? new URL(safeUrl) : null;
    const safeOrigin = parsed ? parsed.origin : "default";
    const safePath = parsed ? parsed.pathname : "";
    console.info(
      `[voice-client-sdk] connecting realtime session via ${safeOrigin}${safePath} (provider=${tokenData.provider || "unknown"})`,
    );
  } catch {
    // ignore URL logging issues
  }

  await session.connect(connectOpts);

  if (_agentsRealtimeModuleSource) {
    console.info(`[voice-client-sdk] using OpenAI Realtime SDK from ${_agentsRealtimeModuleSource}`);
  }

  _session = session;
  sdkVoiceSdkActive.value = true;
  sdkVoiceState.value = "listening";
  sdkVoiceProvider.value = tokenData.provider || "openai";
  _sessionStartTime = Date.now();
  sdkVoiceSessionId.value = _callContext.sessionId || `voice-sdk-${Date.now()}`;
  startDurationTimer();

  emit("connected", {
    provider: tokenData.provider,
    sessionId: sdkVoiceSessionId.value,
    sdk: "openai-agents",
    callContext: { ..._callContext },
  });

  return session;
}

// ── Gemini Live Session (WebSocket via server proxy) ────────────────────────

/**
 * Start a Gemini Live voice session.
 * Since Gemini Live uses WebSocket and we can't directly use the @google/genai
 * SDK in the browser without exposing the API key, we use a server-proxied
 * approach: the server manages the Gemini Live WebSocket, and the client
 * sends/receives audio via a bosun WebSocket relay.
 */
async function startGeminiLiveSession(config, options = {}) {
  const resolvedConfig = config && typeof config === "object" ? config : {};
  // For Gemini, fall back to server-mediated approach
  // The client sends mic audio via WebSocket to our server,
  // which forwards to Gemini Live API and returns audio.
  const wsProtocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${globalThis.location?.host}/api/voice/gemini-live`;

  const ws = new WebSocket(wsUrl);
  let audioElement = null;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Gemini Live connection timeout"));
    }, 15000);

    ws.onopen = () => {
      clearTimeout(timeout);

      // Send session config
      ws.send(JSON.stringify({
        type: "session.config",
        sessionId: _callContext.sessionId,
        executor: _callContext.executor,
        mode: _callContext.mode,
        model: resolvedConfig.model,
      }));

      _session = ws;
      sdkVoiceSdkActive.value = true;
      sdkVoiceState.value = "connected";
      sdkVoiceProvider.value = "gemini";
      _sessionStartTime = Date.now();
      sdkVoiceSessionId.value = _callContext.sessionId || `voice-gemini-${Date.now()}`;
      startDurationTimer();

      // Start mic capture and stream to server
      startGeminiMicCapture(ws).catch((err) => {
        console.error("[voice-client-sdk] Gemini mic capture failed:", err);
        sdkVoiceError.value = err.message;
        sdkVoiceState.value = "error";
      });

      emit("connected", {
        provider: "gemini",
        sessionId: sdkVoiceSessionId.value,
        sdk: "google-genai-live",
        callContext: { ..._callContext },
      });

      resolve(ws);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleGeminiServerEvent(msg);
      } catch {
        // Binary audio data — play it
        if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
          playGeminiAudio(event.data);
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error("Gemini Live WebSocket error"));
    };

    ws.onclose = () => {
      if (sdkVoiceState.value !== "idle") {
        sdkVoiceState.value = "idle";
        emit("disconnected", { reason: "Gemini Live connection closed" });
      }
    };
  });
}

async function startGeminiMicCapture(ws) {
  const mediaDevices = navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    throw new Error("Microphone API unavailable");
  }

  _geminiMicStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 16000,
      channelCount: 1,
    },
  });

  // Use MediaRecorder to stream chunks to server
  const recorder = new MediaRecorder(_geminiMicStream, {
    mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm",
  });
  _geminiRecorder = recorder;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(event.data);
    }
  };

  recorder.start(250); // Send chunks every 250ms
  sdkVoiceState.value = "listening";
}

function stopMicLikeTracks(source) {
  if (!source) return;
  const streams = [
    source,
    source?.stream,
    source?.localStream,
    source?.mediaStream,
    source?._mediaStream,
    source?.audioInputStream,
    source?.transport?.stream,
    source?.transport?.localStream,
    source?.transport?.mediaStream,
    source?.transport?._mediaStream,
  ].filter(Boolean);

  for (const stream of streams) {
    if (typeof stream?.getTracks !== "function") continue;
    for (const track of stream.getTracks()) {
      if (String(track?.kind || "").toLowerCase() !== "audio") continue;
      try { track.stop(); } catch { /* ignore */ }
    }
  }

  const pcs = [
    source?.pc,
    source?._pc,
    source?.peerConnection,
    source?.transport?.pc,
    source?.transport?._pc,
    source?.transport?.peerConnection,
  ].filter(Boolean);
  for (const pc of pcs) {
    if (typeof pc?.getSenders !== "function") continue;
    for (const sender of pc.getSenders()) {
      const track = sender?.track;
      if (!track || String(track.kind || "").toLowerCase() !== "audio") continue;
      try { track.stop(); } catch { /* ignore */ }
    }
  }
}

function handleGeminiServerEvent(msg) {
  const type = msg.type;

  switch (type) {
    case "transcript.user":
      sdkVoiceTranscript.value = msg.text || "";
      emit("transcript", { text: msg.text, final: true });
      _recordTranscript("user", msg.text, "gemini.user_transcript");
      break;

    case "transcript.assistant":
      sdkVoiceResponse.value = msg.text || "";
      emit("response-complete", { text: msg.text });
      _recordTranscript("assistant", msg.text, "gemini.assistant_transcript");
      break;

    case "audio.delta":
      // Binary audio handled in ws.onmessage
      break;

    case "tool_call":
      handleGeminiToolCall(msg).catch((err) => {
        console.error("[voice-client-sdk] Gemini tool call failed:", err);
      });
      break;

    case "speech_started":
      sdkVoiceState.value = "listening";
      emit("speech-started", {});
      break;

    case "speech_stopped":
      sdkVoiceState.value = "thinking";
      emit("speech-stopped", {});
      break;

    case "error":
      sdkVoiceError.value = msg.message || "Gemini error";
      emit("error", { message: msg.message });
      break;

    default:
      break;
  }
}

async function handleGeminiToolCall(msg) {
  const callId = msg.callId || `gemini-tc-${Date.now()}`;
  const name = msg.name || "unknown";
  const args = msg.args || {};

  sdkVoiceToolCalls.value = [...sdkVoiceToolCalls.value, { callId, name, args, status: "running" }];
  sdkVoiceState.value = "thinking";
  emit("tool-call-start", { callId, name, args });

  try {
    const res = await fetch("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: name,
        args,
        sessionId: sdkVoiceSessionId.value,
        executor: _callContext.executor || undefined,
        mode: _callContext.mode || undefined,
        model: _callContext.model || undefined,
      }),
    });
    const result = await res.json();

    sdkVoiceToolCalls.value = sdkVoiceToolCalls.value.map((tc) =>
      tc.callId === callId ? { ...tc, status: "complete", result: result.result } : tc
    );

    // Send tool result back to Gemini via WebSocket
    if (_session && _session.readyState === WebSocket.OPEN) {
      _session.send(JSON.stringify({
        type: "tool_result",
        callId,
        name,
        result: result.result || result.error || "No output",
      }));
    }

    emit("tool-call-complete", { callId, name, result: result.result });
  } catch (err) {
    sdkVoiceToolCalls.value = sdkVoiceToolCalls.value.map((tc) =>
      tc.callId === callId ? { ...tc, status: "error", error: err.message } : tc
    );
    emit("tool-call-error", { callId, name, error: err.message });
  }
}

function playGeminiAudio(data) {
  // Use Web Audio API to play PCM audio from Gemini
  try {
    if (typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined") {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!playGeminiAudio._ctx) {
        playGeminiAudio._ctx = new AudioCtx({ sampleRate: 24000 });
      }
      const ctx = playGeminiAudio._ctx;

      if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => {
          ctx.decodeAudioData(buf, (audioBuffer) => {
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.start();
          }).catch(() => { /* ignore decode errors */ });
        });
      }
    }
  } catch {
    // Audio playback not available
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a voice session using the best available SDK.
 * Falls back to legacy voice-client.js if SDK initialization fails.
 *
 * @param {object} options — { sessionId, executor, mode, model }
 * @returns {Promise<{ sdk: boolean, provider: string }>}
 */
export async function startSdkVoiceSession(options = {}) {
  if (_session) {
    console.warn("[voice-client-sdk] Session already active");
    return { sdk: sdkVoiceSdkActive.value, provider: sdkVoiceProvider.value };
  }

  _callContext = _normalizeCallContext(options);
  sdkVoiceBoundSessionId.value = _callContext.sessionId;
  sdkVoiceState.value = "connecting";
  sdkVoiceError.value = null;
  sdkVoiceTranscript.value = "";
  sdkVoiceResponse.value = "";
  sdkVoiceToolCalls.value = [];
  _usingLegacyFallback = false;
  _resetTranscriptPersistenceState();

  try {
    // 1. Fetch SDK config from server
    _sdkConfig = await fetchSdkConfig();

    // 2. Try SDK-based session based on provider
    if (_sdkConfig.useSdk) {
      const provider = _sdkConfig.provider || "openai";

      if (provider === "openai" || provider === "azure") {
        await startAgentsSdkSession(_sdkConfig, options);
        return { sdk: true, provider };
      }

      if (provider === "gemini") {
        await startGeminiLiveSession(_sdkConfig, options);
        return { sdk: true, provider: "gemini" };
      }
    }

    // 3. SDK not available — signal fallback
    _usingLegacyFallback = true;
    sdkVoiceSdkActive.value = false;
    emit("sdk-unavailable", {
      reason: _sdkConfig.fallbackReason || "SDK not available for provider",
      provider: _sdkConfig.provider,
    });

    return { sdk: false, provider: _sdkConfig.provider, reason: _sdkConfig.fallbackReason };
  } catch (err) {
    const reason = String(err?.message || "");
    const expectedModuleMissing =
      /SDK module unavailable in browser/i.test(reason) ||
      /Failed to resolve module specifier '@openai\/agents\/realtime'/i.test(reason) ||
      /Cannot find module '@openai\/agents\/realtime'/i.test(reason);
    if (expectedModuleMissing) {
      if (!_sdkModuleUnavailableLogged) {
        console.warn(
          "[voice-client-sdk] Realtime SDK bundle unavailable; using legacy voice transport.",
        );
        _sdkModuleUnavailableLogged = true;
      }
    } else {
      console.error("[voice-client-sdk] SDK session failed, signaling fallback:", err);
    }
    _usingLegacyFallback = true;
    sdkVoiceSdkActive.value = false;
    sdkVoiceState.value = "idle";
    sdkVoiceError.value = null; // Don't show error — we'll fallback
    emit("sdk-unavailable", {
      reason: reason || "SDK unavailable",
      provider: _sdkConfig?.provider || "unknown",
    });

    return {
      sdk: false,
      provider: _sdkConfig?.provider || "unknown",
      reason: reason || "SDK unavailable",
    };
  }
}

/**
 * Stop the current SDK voice session.
 */
export function stopSdkVoiceSession() {
  emit("session-ending", { sessionId: sdkVoiceSessionId.value });
  if (_geminiRecorder) {
    try { _geminiRecorder.stop(); } catch { /* ignore */ }
    _geminiRecorder = null;
  }

  if (_session) {
    stopMicLikeTracks(_session);
    try {
      if (typeof _session.close === "function") {
        _session.close();
      } else if (typeof _session.disconnect === "function") {
        _session.disconnect();
      }
    } catch {
      // best effort
    }
    _session = null;
  }

  // Stop Gemini mic stream if active
  if (_geminiMicStream) {
    for (const track of _geminiMicStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    _geminiMicStream = null;
  }

  clearInterval(_durationTimer);
  _durationTimer = null;

  sdkVoiceState.value = "idle";
  sdkVoiceTranscript.value = "";
  sdkVoiceResponse.value = "";
  sdkVoiceToolCalls.value = [];
  sdkVoiceSessionId.value = null;
  sdkVoiceBoundSessionId.value = null;
  sdkVoiceDuration.value = 0;
  sdkVoiceProvider.value = null;
  sdkVoiceSdkActive.value = false;
  _callContext = { sessionId: null, executor: null, mode: null, model: null };
  _usingLegacyFallback = false;
  _resetTranscriptPersistenceState();

  emit("session-ended", {});
}

/**
 * Interrupt the current response (barge-in).
 */
export function interruptSdkResponse() {
  if (_session) {
    if (typeof _session.interrupt === "function") {
      // @openai/agents SDK
      _session.interrupt();
    } else if (_session.readyState === WebSocket.OPEN) {
      // Gemini WebSocket
      _session.send(JSON.stringify({ type: "response.cancel" }));
    }
    emit("interrupt", {});
  }
}

/**
 * Send a text message to the voice agent.
 */
export function sendSdkTextMessage(text) {
  if (!_session) {
    console.warn("[voice-client-sdk] Cannot send text — no active session");
    return;
  }

  if (typeof _session.sendMessage === "function") {
    // @openai/agents SDK
    _session.sendMessage(text);
  } else if (_session.readyState === WebSocket.OPEN) {
    // Gemini WebSocket
    _session.send(JSON.stringify({
      type: "text.input",
      text,
    }));
  }
}

/**
 * Check if falling back to legacy voice.
 */
export function isUsingLegacyFallback() {
  return _usingLegacyFallback;
}

/**
 * Get current SDK session info.
 */
export function getSdkSessionInfo() {
  return {
    active: sdkVoiceSdkActive.value,
    provider: sdkVoiceProvider.value,
    sessionId: sdkVoiceSessionId.value,
    state: sdkVoiceState.value,
    duration: sdkVoiceDuration.value,
    usingLegacy: _usingLegacyFallback,
    sdkConfig: _sdkConfig,
  };
}

// ── Duration Timer ──────────────────────────────────────────────────────────

function startDurationTimer() {
  clearInterval(_durationTimer);
  _durationTimer = setInterval(() => {
    sdkVoiceDuration.value = Math.floor((Date.now() - _sessionStartTime) / 1000);
  }, 1000);
}
