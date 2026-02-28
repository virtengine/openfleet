/**
 * voice-relay.mjs — Multi-provider voice relay for real-time voice sessions.
 *
 * Supports:
 *   - OpenAI Realtime API (WebRTC) — direct API key
 *   - Azure OpenAI Realtime API (WebRTC) — API key + endpoint
 *   - Claude/Gemini provider mode (Tier 2 speech fallback + provider vision)
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
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_DEFAULT_VISION_MODEL = "gpt-4.1-mini";

const AZURE_API_VERSION = "2025-04-01-preview";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const CLAUDE_DEFAULT_MODEL = "claude-3-7-sonnet-latest";
const CLAUDE_DEFAULT_VISION_MODEL = "claude-3-7-sonnet-latest";
const GEMINI_GENERATE_CONTENT_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-pro";
const GEMINI_DEFAULT_VISION_MODEL = "gemini-2.5-flash";

const VALID_EXECUTORS = new Set([
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
]);

const VALID_AGENT_MODES = new Set([
  "ask",
  "agent",
  "plan",
  "code",
  "architect",
]);

function sanitizeVoiceCallContext(context = {}) {
  const rawSessionId = String(context?.sessionId || "").trim();
  const rawExecutor = String(context?.executor || "").trim().toLowerCase();
  const rawMode = String(context?.mode || "").trim().toLowerCase();
  const rawModel = String(context?.model || "").trim();

  return {
    sessionId: rawSessionId || null,
    executor: VALID_EXECUTORS.has(rawExecutor) ? rawExecutor : null,
    mode: VALID_AGENT_MODES.has(rawMode) ? rawMode : null,
    model: rawModel || null,
  };
}

function buildSessionScopedInstructions(baseInstructions, callContext = {}) {
  const context = sanitizeVoiceCallContext(callContext);
  if (!context.sessionId && !context.executor && !context.mode && !context.model) {
    return baseInstructions;
  }

  const suffix = [
    "",
    "## Bosun Voice Call Context",
    `Active chat session id: ${context.sessionId || "none"}.`,
    context.executor
      ? `Preferred executor for delegated work: ${context.executor}.`
      : "Preferred executor for delegated work: use configured default.",
    context.mode
      ? `Preferred delegation mode: ${context.mode}.`
      : "Preferred delegation mode: use configured default.",
    context.model
      ? `Preferred model override: ${context.model}.`
      : "Preferred model override: none.",
    "",
    "## Required Behavior",
    "- For every user turn in this call, invoke delegate_to_agent exactly once before any final spoken answer.",
    "- For coding, repo, task, debugging, automation, or workspace requests, call delegate_to_agent before finalizing your response.",
    "- Preserve user intent when delegating. Do not paraphrase away technical detail.",
    "- Keep responses concise after receiving delegate_to_agent output.",
  ].join("\n");

  return `${baseInstructions}${suffix}`;
}

function resolveToolChoice(toolDefinitions, callContext = {}) {
  const context = sanitizeVoiceCallContext(callContext);
  const hasDelegateTool = Array.isArray(toolDefinitions)
    && toolDefinitions.some((tool) => tool?.name === "delegate_to_agent");
  if (context.sessionId && hasDelegateTool) {
    return {
      type: "function",
      name: "delegate_to_agent",
    };
  }
  return "auto";
}

function extractModelResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const text = String(choice?.message?.content || "").trim();
    if (text) return text;
  }

  return "";
}

function parseImageDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const match = raw.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i,
  );
  if (!match) {
    throw new Error("Invalid frame format (expected data:image/*;base64,...)");
  }
  return {
    mimeType: String(match[1] || "").toLowerCase(),
    base64Data: String(match[2] || ""),
    dataUrl: raw,
  };
}

function extractClaudeResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .filter((part) => part?.type === "text")
    .map((part) => String(part?.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) return text;
  return "";
}

function extractGeminiResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
      : [];
    const text = parts
      .map((part) => String(part?.text || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

async function analyzeVisionWithOpenAI(dataUrl, model, prompt, contextText, cfg) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_output_tokens: 220,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${prompt}\n\n${contextText}`,
            },
            {
              type: "input_image",
              image_url: dataUrl,
              detail: "high",
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`Vision request failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const summary = extractModelResponseText(payload);
  if (!summary) {
    throw new Error("Vision model returned an empty summary");
  }
  return {
    summary,
    provider: "openai",
    model,
  };
}

async function analyzeVisionWithAzure(dataUrl, model, prompt, contextText, cfg) {
  const endpoint = cfg.azureEndpoint.replace(/\/+$/, "");
  const url = `${endpoint}/openai/responses?api-version=${AZURE_API_VERSION}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": cfg.azureKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_output_tokens: 220,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${prompt}\n\n${contextText}`,
            },
            {
              type: "input_image",
              image_url: dataUrl,
              detail: "high",
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`Azure vision request failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const summary = extractModelResponseText(payload);
  if (!summary) {
    throw new Error("Azure vision model returned an empty summary");
  }
  return {
    summary,
    provider: "azure",
    model,
  };
}

async function analyzeVisionWithClaude(frame, model, prompt, contextText, cfg) {
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": cfg.claudeKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 260,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${prompt}\n\n${contextText}` },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: frame.mimeType,
                data: frame.base64Data,
              },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`Claude vision request failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const summary = extractClaudeResponseText(payload);
  if (!summary) {
    throw new Error("Claude vision model returned an empty summary");
  }
  return {
    summary,
    provider: "claude",
    model,
  };
}

async function analyzeVisionWithGemini(frame, model, prompt, contextText, cfg) {
  const apiKey = String(cfg.geminiKey || "").trim();
  const endpoint =
    `${GEMINI_GENERATE_CONTENT_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: `${prompt}\n\n${contextText}` },
            {
              inlineData: {
                mimeType: frame.mimeType,
                data: frame.base64Data,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 220,
      },
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`Gemini vision request failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const summary = extractGeminiResponseText(payload);
  if (!summary) {
    throw new Error("Gemini vision model returned an empty summary");
  }
  return {
    summary,
    provider: "gemini",
    model,
  };
}

// ── Voice provider detection ────────────────────────────────────────────────

/**
 * Resolve voice configuration from bosun config + env.
 * Returns { provider, model, openaiKey, azureKey, azureEndpoint, azureDeployment,
 *           claudeKey, geminiKey, voiceId, turnDetection, instructions,
 *           fallbackMode, delegateExecutor, enabled, visionModel }
 */
export function getVoiceConfig(forceReload = false) {
  if (!forceReload && _voiceConfig && (Date.now() - _configLoadedAt < CONFIG_TTL_MS)) {
    return _voiceConfig;
  }

  const cfg = loadConfig();
  const voice = cfg.voice || {};

  // Provider priority: config > env > key autodetect.
  // "auto" resolves to azure/openai/fallback based on available credentials.
  const rawProvider = String(
    voice.provider || process.env.VOICE_PROVIDER || "auto",
  )
    .trim()
    .toLowerCase();

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

  const claudeKey = voice.claudeApiKey
    || process.env.ANTHROPIC_API_KEY
    || "";

  const geminiKey = voice.geminiApiKey
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || "";

  const provider =
    rawProvider === "auto"
      ? (azureKey && azureEndpoint
          ? "azure"
          : (openaiKey
              ? "openai"
              : (claudeKey
                  ? "claude"
                  : (geminiKey ? "gemini" : "fallback"))))
      : rawProvider;
  const defaultModel =
    provider === "claude"
      ? CLAUDE_DEFAULT_MODEL
      : provider === "gemini"
        ? GEMINI_DEFAULT_MODEL
        : OPENAI_REALTIME_MODEL;
  const model = voice.model || process.env.VOICE_MODEL || defaultModel;
  const voiceId = voice.voiceId || process.env.VOICE_ID || "alloy";
  const turnDetection =
    voice.turnDetection || process.env.VOICE_TURN_DETECTION || "server_vad";
  const defaultVisionModel =
    provider === "claude"
      ? CLAUDE_DEFAULT_VISION_MODEL
      : provider === "gemini"
        ? GEMINI_DEFAULT_VISION_MODEL
        : OPENAI_DEFAULT_VISION_MODEL;
  const visionModel =
    voice.visionModel || process.env.VOICE_VISION_MODEL || defaultVisionModel;
  const fallbackMode =
    voice.fallbackMode || process.env.VOICE_FALLBACK_MODE || "browser";
  const delegateExecutor =
    voice.delegateExecutor ||
    process.env.VOICE_DELEGATE_EXECUTOR ||
    cfg.primaryAgent ||
    "codex-sdk";
  const enabled =
    voice.enabled != null
      ? voice.enabled !== false
      : !["0", "false", "no", "off"].includes(
          String(process.env.VOICE_ENABLED || "")
            .trim()
            .toLowerCase(),
        );

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
    claudeKey,
    geminiKey,
    voiceId,
    turnDetection,
    visionModel,
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
  if (cfg.provider === "claude" && cfg.claudeKey) {
    return { available: true, tier: 2, provider: "claude" };
  }
  if (cfg.provider === "gemini" && cfg.geminiKey) {
    return { available: true, tier: 2, provider: "gemini" };
  }
  if (cfg.fallbackMode === "disabled") {
    return {
      available: false,
      tier: null,
      reason: `Voice provider "${cfg.provider}" is not configured and fallback is disabled`,
    };
  }
  // Tier 2 fallback available when enabled
  return { available: true, tier: 2, provider: "fallback" };
}

/**
 * Create an ephemeral token for OpenAI Realtime API (WebRTC).
 * Returns { token, expiresAt, model, voiceId, provider }
 */
export async function createEphemeralToken(toolDefinitions = [], callContext = {}) {
  const cfg = getVoiceConfig();
  if (cfg.provider === "azure") {
    return createAzureEphemeralToken(toolDefinitions, callContext);
  }
  if (cfg.provider !== "openai") {
    throw new Error(
      `Realtime WebRTC token is unavailable for provider "${cfg.provider}". ` +
      "Use VOICE_PROVIDER=openai|azure for Tier 1 realtime voice.",
    );
  }
  if (!cfg.openaiKey) {
    throw new Error("OPENAI_API_KEY not configured for voice");
  }

  const context = sanitizeVoiceCallContext(callContext);
  const instructions = buildSessionScopedInstructions(cfg.instructions, context);

  const sessionConfig = {
    model: cfg.model,
    voice: cfg.voiceId,
    instructions,
    tool_choice: resolveToolChoice(toolDefinitions, context),
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
    callContext: context,
  };
}

/**
 * Create an ephemeral token for Azure OpenAI Realtime API.
 */
async function createAzureEphemeralToken(toolDefinitions = [], callContext = {}) {
  const cfg = getVoiceConfig();
  if (!cfg.azureKey || !cfg.azureEndpoint) {
    throw new Error("Azure OpenAI Realtime not configured (need endpoint + key)");
  }

  const context = sanitizeVoiceCallContext(callContext);
  const instructions = buildSessionScopedInstructions(cfg.instructions, context);
  const endpoint = cfg.azureEndpoint.replace(/\/+$/, "");
  const url = `${endpoint}/openai/realtime/sessions?api-version=${AZURE_API_VERSION}&deployment=${cfg.azureDeployment}`;

  const sessionConfig = {
    model: cfg.azureDeployment,
    voice: cfg.voiceId,
    instructions,
    tool_choice: resolveToolChoice(toolDefinitions, context),
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
    callContext: context,
  };
}

/**
 * Analyze a camera/screen frame and return a concise summary.
 * @param {string} frameDataUrl - data URL (image/jpeg|png|webp)
 * @param {object} options - { source, context, prompt }
 * @returns {Promise<{ summary: string, provider: string, model: string }>}
 */
export async function analyzeVisionFrame(frameDataUrl, options = {}) {
  const frame = parseImageDataUrl(frameDataUrl);
  const dataUrl = frame.dataUrl;

  const cfg = getVoiceConfig();
  const source = String(options?.source || "screen").trim().toLowerCase() || "screen";
  const callContext = sanitizeVoiceCallContext(options?.context || {});
  const model =
    String(
      options?.model
      || options?.visionModel
      || cfg.visionModel
      || process.env.VOICE_VISION_MODEL
      || OPENAI_DEFAULT_VISION_MODEL,
    ).trim();
  const prompt = String(options?.prompt || "").trim()
    || "Summarize what is visible in this live frame for a coding assistant. Focus on code, terminal output, errors, UI labels, and actionable context.";

  const contextText = [
    `Frame source: ${source}.`,
    `Bound chat session: ${callContext.sessionId || "none"}.`,
    callContext.executor ? `Preferred executor: ${callContext.executor}.` : "",
    callContext.mode ? `Preferred mode: ${callContext.mode}.` : "",
    callContext.model ? `Preferred model override: ${callContext.model}.` : "",
    "Respond in 1-3 concise sentences. Include likely next action if obvious.",
  ]
    .filter(Boolean)
    .join("\n");

  const preferredProviders = [];
  const pushProvider = (value) => {
    const provider = String(value || "").trim().toLowerCase();
    if (!provider || preferredProviders.includes(provider)) return;
    preferredProviders.push(provider);
  };
  pushProvider(cfg.provider);
  if (cfg.openaiKey) pushProvider("openai");
  if (cfg.azureKey && cfg.azureEndpoint) pushProvider("azure");
  if (cfg.claudeKey) pushProvider("claude");
  if (cfg.geminiKey) pushProvider("gemini");

  let lastError = null;
  for (const provider of preferredProviders) {
    try {
      if (provider === "openai" && cfg.openaiKey) {
        return await analyzeVisionWithOpenAI(
          dataUrl,
          model,
          prompt,
          contextText,
          cfg,
        );
      }
      if (provider === "azure" && cfg.azureKey && cfg.azureEndpoint) {
        return await analyzeVisionWithAzure(
          dataUrl,
          model,
          prompt,
          contextText,
          cfg,
        );
      }
      if (provider === "claude" && cfg.claudeKey) {
        return await analyzeVisionWithClaude(
          frame,
          model,
          prompt,
          contextText,
          cfg,
        );
      }
      if (provider === "gemini" && cfg.geminiKey) {
        return await analyzeVisionWithGemini(
          frame,
          model,
          prompt,
          contextText,
          cfg,
        );
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    throw new Error(`Vision request failed: ${lastError.message}`);
  }

  throw new Error(
    "Vision unavailable: configure OPENAI, Azure, Anthropic, or Gemini voice credentials",
  );
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
export async function getVoiceToolDefinitions(options = {}) {
  try {
    const { getToolDefinitions } = await import("./voice-tools.mjs");
    const allTools = getToolDefinitions();
    const delegateOnly = options?.delegateOnly === true;
    if (!delegateOnly) return allTools;
    return allTools.filter((tool) => tool?.name === "delegate_to_agent");
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
  if (cfg.provider !== "openai") {
    return {
      provider: cfg.provider,
      url: null,
      model: cfg.model,
      tier: 2,
    };
  }
  return {
    provider: "openai",
    url: `${OPENAI_REALTIME_URL}?model=${cfg.model}`,
    model: cfg.model,
  };
}
