const DEFAULT_ACTIVE_PROFILE = "xl";
const DEFAULT_SUBAGENT_PROFILE = "m";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeProfileName(value, fallback = DEFAULT_ACTIVE_PROFILE) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  return raw.replace(/[^a-z0-9_-]/g, "") || fallback;
}

function profilePrefix(name) {
  return `CODEX_MODEL_PROFILE_${name.toUpperCase()}_`;
}

function inferGlobalProvider(env) {
  const baseUrl = clean(env.OPENAI_BASE_URL).toLowerCase();
  if (baseUrl.includes(".openai.azure.com")) return "azure";
  return "openai";
}

function normalizeProvider(value, fallback) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  if (["azure", "azure-openai", "azure_openai"].includes(raw)) {
    return "azure";
  }
  if (["openai", "default"].includes(raw)) {
    return "openai";
  }
  if (["compatible", "openai-compatible", "openai_compatible"].includes(raw)) {
    return "compatible";
  }
  return fallback;
}

function readProfileField(env, profileName, field) {
  return clean(env[`${profilePrefix(profileName)}${field}`]);
}

function profileRecord(env, profileName, globalProvider) {
  const provider = normalizeProvider(
    readProfileField(env, profileName, "PROVIDER"),
    globalProvider,
  );
  const model =
    readProfileField(env, profileName, "MODEL") ||
    (profileName === "xl" ? "gpt-5.3-codex" : profileName === "m" ? "gpt-5.1-codex-mini" : "");
  const baseUrl = readProfileField(env, profileName, "BASE_URL");
  const apiKey = readProfileField(env, profileName, "API_KEY");
  const apiKeyEnv = readProfileField(env, profileName, "API_KEY_ENV");
  const subagentModel = readProfileField(env, profileName, "SUBAGENT_MODEL");
  return {
    name: profileName,
    provider,
    model,
    baseUrl,
    apiKey,
    apiKeyEnv,
    subagentModel,
  };
}

/**
 * Resolve codex model/provider profile configuration from env vars.
 * Applies active profile values onto runtime env keys (`CODEX_MODEL`,
 * `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`) while keeping
 * sensible fallbacks to global env vars.
 */
export function resolveCodexProfileRuntime(envInput = process.env) {
  const sourceEnv = { ...envInput };
  const activeProfile = normalizeProfileName(
    sourceEnv.CODEX_MODEL_PROFILE,
    DEFAULT_ACTIVE_PROFILE,
  );
  const subagentProfile = normalizeProfileName(
    sourceEnv.CODEX_MODEL_PROFILE_SUBAGENT || sourceEnv.CODEX_SUBAGENT_PROFILE,
    DEFAULT_SUBAGENT_PROFILE,
  );

  const globalProvider = inferGlobalProvider(sourceEnv);
  const active = profileRecord(sourceEnv, activeProfile, globalProvider);
  const sub = profileRecord(sourceEnv, subagentProfile, globalProvider);

  const env = { ...sourceEnv };

  if (active.model) {
    env.CODEX_MODEL = active.model;
  }
  if (active.baseUrl) {
    env.OPENAI_BASE_URL = active.baseUrl;
  }

  const profileApiKey = active.apiKey;
  const resolvedProvider = active.provider || globalProvider;

  if (profileApiKey) {
    if (resolvedProvider === "azure") {
      env.AZURE_OPENAI_API_KEY = profileApiKey;
      if (!env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = profileApiKey;
      }
    } else {
      env.OPENAI_API_KEY = profileApiKey;
      if (!env.AZURE_OPENAI_API_KEY && resolvedProvider === "compatible") {
        env.AZURE_OPENAI_API_KEY = "";
      }
    }
  }

  if (resolvedProvider === "azure") {
    if (!clean(env.AZURE_OPENAI_API_KEY) && clean(env.OPENAI_API_KEY)) {
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
  }

  if (!clean(env.CODEX_SUBAGENT_MODEL)) {
    env.CODEX_SUBAGENT_MODEL =
      sub.subagentModel || sub.model || active.subagentModel || "gpt-5.1-codex-mini";
  }

  env.CODEX_MODEL_PROFILE = activeProfile;
  env.CODEX_MODEL_PROFILE_SUBAGENT = subagentProfile;

  return {
    env,
    activeProfile,
    subagentProfile,
    active,
    subagent: sub,
    provider: resolvedProvider,
  };
}
