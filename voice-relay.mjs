/**
 * voice-relay.mjs — Multi-provider voice relay for real-time voice sessions.
 *
 * Supports:
 *   - OpenAI Realtime API (WebRTC) — direct API key
 *   - Azure OpenAI Realtime API (WebRTC) — API key + endpoint
 *   - Tier 2 fallback (browser STT → executor → browser TTS)
 *
 * @module voice-relay
 */

import { loadConfig } from "./config.mjs";
import { execPrimaryPrompt, getPrimaryAgentName } from "./primary-agent.mjs";

// ── Module-scope state ──────────────────────────────────────────────────────
let _voiceConfig = null;   // cached resolved config
let _configLoadedAt = 0;   // timestamp of last config load

const CONFIG_TTL_MS = 30_000; // re-read config every 30s

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime";
const OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";

const AZURE_API_VERSION = "2025-04-01-preview";

// ── Voice provider detection ────────────────────────────────────────────────

/**
 * Resolve voice configuration from bosun config + env.
 * Returns { provider, model, apiKey, azureEndpoint, azureDeployment, voiceId,
 *           turnDetection, instructions, fallbackMode, delegateExecutor, enabled }
 */
export function getVoiceConfig(forceReload = false) {
  if (!forceReload && _voiceConfig && (Date.now() - _configLoadedAt < CONFIG_TTL_MS)) {
    return _voiceConfig;
  }

  const cfg = loadConfig();
  const voice = cfg.voice || {};

  // Provider priority: config > env
  const provider = voice.provider
    || process.env.VOICE_PROVIDER
    || (process.env.AZURE_OPENAI_REALTIME_ENDPOINT ? "azure" : null)
    || (process.env.OPENAI_API_KEY ? "openai" : null)
    || "fallback";

  // API keys
  const openaiKey = voice.openaiApiKey
    || process.env.OPENAI_API_KEY
    || process.env.OPENAI_REALTIME_API_KEY
    || "";

  const azureKey = voice.azureApiKey
    || process.env.AZURE_OPENAI_API_KEY
    || process.env.AZURE_OPENAI_REALTIME_API_KEY
    || "";

  const azureEndpoint = voice.azureEndpoint
    || process.env.AZURE_OPENAI_REALTIME_ENDPOINT
    || process.env.AZURE_OPENAI_ENDPOINT
    || "";

  const azureDeployment = voice.azureDeployment
    || process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT
    || "gpt-4o-realtime-preview";

  const model = voice.model || process.env.VOICE_MODEL || OPENAI_REALTIME_MODEL;
  const voiceId = voice.voiceId || process.env.VOICE_ID || "alloy";
  const turnDetection = voice.turnDetection || "server_vad";
  const fallbackMode = voice.fallbackMode || "browser";
  const delegateExecutor = voice.delegateExecutor || cfg.primaryAgent || "codex-sdk";
  const enabled = voice.enabled !== false;

  const instructions = voice.instructions || `You are Bosun, a helpful voice assistant for the VirtEngine development platform.
You help developers manage tasks, steer coding agents, monitor builds, and navigate the workspace.
Be concise and conversational. When users ask about code or tasks, use the available tools.
For complex operations like writing code or creating PRs, delegate to the appropriate agent.`;

  _voiceConfig = Object.freeze({
    provider,
    model,
    openaiKey,
    azureKey,
    azureEndpoint,
    azureDeployment,
    voiceId,
    turnDetection,
    instructions,
    fallbackMode,
    delegateExecutor,
    enabled,
  });
  _configLoadedAt = Date.now();
  return _voiceConfig;
}

/**
 * Check if any voice tier is available.
 */
export function isVoiceAvailable() {
  const cfg = getVoiceConfig();
  if (!cfg.enabled) return { available: false, tier: null, reason: "Voice disabled in config" };

  if (cfg.provider === "openai" && cfg.openaiKey) {
    return { available: true, tier: 1, provider: "openai" };
  }
  if (cfg.provider === "azure" && cfg.azureKey && cfg.azureEndpoint) {
    return { available: true, tier: 1, provider: "azure" };
  }
  // Tier 2 is always available if voice is enabled
  return { available: true, tier: 2, provider: "fallback" };
}

/**
 * Create an ephemeral token for OpenAI Realtime API (WebRTC).
 * Returns { token, expiresAt, model, voiceId, provider }
 */
export async function createEphemeralToken(toolDefinitions = []) {
  const cfg = getVoiceConfig();
  if (cfg.provider === "azure") {
    return createAzureEphemeralToken(toolDefinitions);
  }
  if (!cfg.openaiKey) {
    throw new Error("OPENAI_API_KEY not configured for voice");
  }

  const sessionConfig = {
    model: cfg.model,
    voice: cfg.voiceId,
    instructions: cfg.instructions,
    turn_detection: {
      type: cfg.turnDetection,
      ...(cfg.turnDetection === "server_vad" ? {
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      } : {}),
      ...(cfg.turnDetection === "semantic_vad" ? {
        eagerness: "medium",
      } : {}),
    },
    input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
    tools: toolDefinitions,
  };

  const response = await fetch(`${OPENAI_REALTIME_URL}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sessionConfig),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`OpenAI Realtime session failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    token: data.client_secret?.value || data.token,
    expiresAt: data.client_secret?.expires_at || (Date.now() / 1000 + 60),
    model: cfg.model,
    voiceId: cfg.voiceId,
    provider: "openai",
    sessionConfig,
  };
}

/**
 * Create an ephemeral token for Azure OpenAI Realtime API.
 */
async function createAzureEphemeralToken(toolDefinitions = []) {
  const cfg = getVoiceConfig();
  if (!cfg.azureKey || !cfg.azureEndpoint) {
    throw new Error("Azure OpenAI Realtime not configured (need endpoint + key)");
  }

  const endpoint = cfg.azureEndpoint.replace(/\/+$/, "");
  const url = `${endpoint}/openai/realtime/sessions?api-version=${AZURE_API_VERSION}&deployment=${cfg.azureDeployment}`;

  const sessionConfig = {
    model: cfg.azureDeployment,
    voice: cfg.voiceId,
    instructions: cfg.instructions,
    turn_detection: {
      type: cfg.turnDetection,
      ...(cfg.turnDetection === "server_vad" ? {
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      } : {}),
    },
    input_audio_transcription: { model: "whisper-1" },
    tools: toolDefinitions,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": cfg.azureKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sessionConfig),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`Azure Realtime session failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    token: data.client_secret?.value || data.token,
    expiresAt: data.client_secret?.expires_at || (Date.now() / 1000 + 60),
    model: cfg.azureDeployment,
    voiceId: cfg.voiceId,
    provider: "azure",
    sessionConfig,
    azureEndpoint: endpoint,
    azureDeployment: cfg.azureDeployment,
  };
}

/**
 * Execute a voice tool call server-side.
 * Returns { result: string, error?: string }
 */
export async function executeVoiceTool(toolName, toolArgs, context = {}) {
  try {
    // Import voice-tools lazily to avoid circular deps
    const { executeToolCall } = await import("./voice-tools.mjs");
    return await executeToolCall(toolName, toolArgs, context);
  } catch (err) {
    console.error(`[voice-relay] tool execution error (${toolName}):`, err.message);
    return { result: null, error: err.message };
  }
}

/**
 * Get the full tool definitions array for voice sessions.
 */
export async function getVoiceToolDefinitions() {
  try {
    const { getToolDefinitions } = await import("./voice-tools.mjs");
    return getToolDefinitions();
  } catch (err) {
    console.error("[voice-relay] failed to load voice tool definitions:", err.message);
    return [];
  }
}

/**
 * Get the WebRTC connection URL for the client.
 */
export function getRealtimeConnectionInfo() {
  const cfg = getVoiceConfig();
  if (cfg.provider === "azure") {
    const endpoint = cfg.azureEndpoint.replace(/\/+$/, "");
    return {
      provider: "azure",
      url: `${endpoint}/openai/realtime?api-version=${AZURE_API_VERSION}&deployment=${cfg.azureDeployment}`,
      model: cfg.azureDeployment,
    };
  }
  return {
    provider: "openai",
    url: `${OPENAI_REALTIME_URL}?model=${cfg.model}`,
    model: cfg.model,
  };
}
