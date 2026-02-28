import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const VOICE_AUTH_STATE_PATH = join(homedir(), ".bosun", "voice-auth-state.json");
const STATE_TTL_MS = 15_000;

let _cachedState = null;
let _cachedStateAt = 0;

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

function readStateFile() {
  if (!existsSync(VOICE_AUTH_STATE_PATH)) return {};
  const raw = readFileSync(VOICE_AUTH_STATE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

function getCachedState(forceReload = false) {
  const isFresh = !forceReload && _cachedState && Date.now() - _cachedStateAt < STATE_TTL_MS;
  if (isFresh) return _cachedState;

  try {
    _cachedState = readStateFile();
  } catch {
    _cachedState = {};
  }
  _cachedStateAt = Date.now();
  return _cachedState;
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const ts = Number(new Date(expiresAt).getTime());
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now() + 30_000;
}

function getProviderEnvCandidates(provider) {
  switch (provider) {
    case "openai":
      return [
        process.env.BOSUN_VOICE_OPENAI_ACCESS_TOKEN,
        process.env.OPENAI_OAUTH_ACCESS_TOKEN,
        process.env.OPENAI_ACCESS_TOKEN,
      ];
    case "azure":
      return [
        process.env.BOSUN_VOICE_AZURE_ACCESS_TOKEN,
        process.env.AZURE_OPENAI_ACCESS_TOKEN,
      ];
    case "claude":
      return [
        process.env.BOSUN_VOICE_CLAUDE_ACCESS_TOKEN,
        process.env.ANTHROPIC_ACCESS_TOKEN,
      ];
    case "gemini":
      return [
        process.env.BOSUN_VOICE_GEMINI_ACCESS_TOKEN,
        process.env.GEMINI_ACCESS_TOKEN,
        process.env.GOOGLE_ACCESS_TOKEN,
      ];
    default:
      return [];
  }
}

function getStateTokenCandidates(provider, state) {
  const byProvider = state?.providers?.[provider] || state?.[provider] || {};
  return [
    {
      token: byProvider?.accessToken,
      expiresAt: byProvider?.expiresAt,
      source: "state",
    },
    {
      token: byProvider?.access_token,
      expiresAt: byProvider?.expires_at,
      source: "state",
    },
  ];
}

export function resolveVoiceOAuthToken(provider, forceReload = false) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return null;

  const envToken = getProviderEnvCandidates(normalizedProvider)
    .map((token) => String(token || "").trim())
    .find(Boolean);
  if (envToken) {
    return {
      token: envToken,
      source: "env",
      provider: normalizedProvider,
    };
  }

  const state = getCachedState(forceReload);
  const candidates = getStateTokenCandidates(normalizedProvider, state);
  for (const candidate of candidates) {
    const token = String(candidate?.token || "").trim();
    if (!token) continue;
    if (isExpired(candidate?.expiresAt)) continue;
    return {
      token,
      source: candidate.source,
      provider: normalizedProvider,
      expiresAt: candidate?.expiresAt || null,
    };
  }

  return null;
}

export function hasVoiceOAuthToken(provider, forceReload = false) {
  return Boolean(resolveVoiceOAuthToken(provider, forceReload));
}

export function saveVoiceOAuthToken(provider, payload = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    throw new Error("provider is required");
  }

  const token = String(payload?.accessToken || payload?.access_token || "").trim();
  if (!token) {
    throw new Error("access token is required");
  }

  const current = getCachedState(true);
  const next = {
    ...current,
    providers: {
      ...(current?.providers || {}),
      [normalizedProvider]: {
        accessToken: token,
        expiresAt: payload?.expiresAt || payload?.expires_at || null,
        refreshToken: payload?.refreshToken || payload?.refresh_token || null,
        tokenType: payload?.tokenType || payload?.token_type || "Bearer",
        updatedAt: new Date().toISOString(),
      },
    },
  };

  mkdirSync(dirname(VOICE_AUTH_STATE_PATH), { recursive: true });
  writeFileSync(VOICE_AUTH_STATE_PATH, JSON.stringify(next, null, 2));
  _cachedState = next;
  _cachedStateAt = Date.now();

  return {
    ok: true,
    path: VOICE_AUTH_STATE_PATH,
    provider: normalizedProvider,
  };
}

export function getVoiceAuthStatePath() {
  return VOICE_AUTH_STATE_PATH;
}
