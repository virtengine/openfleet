import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_ACTIVE_PROFILE = "xl";
const DEFAULT_SUBAGENT_PROFILE = "m";

function clean(value) {
  return String(value ?? "").trim();
}

function isAzureOpenAIBaseUrl(value) {
  try {
    const parsed = value instanceof URL ? value : new URL(String(value || ""));
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "openai.azure.com" || host.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function normalizeAzureOpenAIBaseUrl(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!isAzureOpenAIBaseUrl(parsed)) {
      return raw;
    }
    parsed.pathname = "/openai/v1";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

function normalizeProfileName(value, fallback = DEFAULT_ACTIVE_PROFILE) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  return raw.replace(/[^a-z0-9_-]/g, "") || fallback;
}

function profilePrefix(name) {
  return `CODEX_MODEL_PROFILE_${name.toUpperCase()}_`;
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

function hasEnvValue(env, key) {
  return Boolean(key && clean(env?.[key]));
}

function inferProviderKindFromSection(name, section, fallback = "openai") {
  if (isAzureOpenAIBaseUrl(section?.baseUrl)) return "azure";
  const normalized = normalizeProvider(name, "");
  if (normalized) return normalized;
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

function readCodexConfigRuntimeDefaults() {
  try {
    const configPath = resolve(homedir(), ".codex", "config.toml");
    if (!existsSync(configPath)) {
      return { model: "", modelProvider: "", providers: {} };
    }
    const content = readFileSync(configPath, "utf8");
    const head = content.split(/\n\[/)[0] || "";
    const modelMatch = head.match(/^\s*model\s*=\s*"([^"]+)"/m);
    const modelProviderMatch = head.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
    const providers = {};
    const providerSectionRegex = /^\[model_providers\.([^\]]+)\]\s*([\s\S]*?)(?=^\[[^\]]+\]|\Z)/gm;
    for (const match of content.matchAll(providerSectionRegex)) {
      const [, rawName = "", body = ""] = match;
      const name = clean(rawName);
      if (!name) continue;
      const baseUrlMatch = body.match(/^\s*base_url\s*=\s*"([^"]+)"/m);
      const envKeyMatch = body.match(/^\s*env_key\s*=\s*"([^"]+)"/m);
      providers[name] = {
        name,
        baseUrl: clean(baseUrlMatch?.[1]),
        envKey: clean(envKeyMatch?.[1]),
      };
    }
    return {
      model: clean(modelMatch?.[1]),
      modelProvider: clean(modelProviderMatch?.[1]),
      providers,
    };
  } catch {
    return { model: "", modelProvider: "", providers: {} };
  }
}

function readCodexConfigTopLevelModel() {
  return readCodexConfigRuntimeDefaults().model;
}

function selectConfigProviderForRuntime(configDefaults, env, preferredProvider = "") {
  const providers = configDefaults?.providers || {};
  const preferred = clean(preferredProvider).toLowerCase();
  const entries = Object.values(providers).map((section) => ({
    ...section,
    provider: inferProviderKindFromSection(section.name, section, preferred || "openai"),
  }));
  const matchingEntries = preferred
    ? entries.filter((section) => section.provider === preferred)
    : entries;
  const envBackedEntries = matchingEntries.filter(
    (section) => !section.envKey || hasEnvValue(env, section.envKey),
  );
  const preferredNames = preferred === "azure"
    ? ["azure"]
    : preferred === "openai"
      ? ["openai"]
      : [];
  const findNamed = (sections) => preferredNames
    .map((name) => sections.find((section) => section.name === name))
    .find(Boolean);

  const configuredName = clean(configDefaults?.modelProvider);
  if (configuredName) {
    const configuredSection = providers[configuredName];
    if (configuredSection) {
      const configured = {
        ...configuredSection,
        provider: inferProviderKindFromSection(
          configuredSection.name,
          configuredSection,
          preferred || "openai",
        ),
      };
      const preferredMatches = !preferred || configured.provider === preferred;
      if (preferredMatches && (!configured.envKey || hasEnvValue(env, configured.envKey))) {
        return configured;
      }
    }
  }

  return (
    findNamed(envBackedEntries) ||
    envBackedEntries[0] ||
    findNamed(matchingEntries) ||
    matchingEntries[0] ||
    null
  );
}

function inferGlobalProvider(env, configDefaults = null) {
  const baseUrl = clean(env.OPENAI_BASE_URL).toLowerCase();
  if (isAzureOpenAIBaseUrl(baseUrl)) return "azure";
  const configured = selectConfigProviderForRuntime(configDefaults, env);
  return configured?.provider || "openai";
}

/**
 * Resolve codex model/provider profile configuration from env vars.
 * Applies active profile values onto runtime env keys (`CODEX_MODEL`,
 * `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`) while keeping
 * sensible fallbacks to global env vars.
 */
export function resolveCodexProfileRuntime(envInput = process.env) {
  const sourceEnv = { ...envInput };
  const configDefaults = readCodexConfigRuntimeDefaults();
  const activeProfile = normalizeProfileName(
    sourceEnv.CODEX_MODEL_PROFILE,
    DEFAULT_ACTIVE_PROFILE,
  );
  const subagentProfile = normalizeProfileName(
    sourceEnv.CODEX_MODEL_PROFILE_SUBAGENT || sourceEnv.CODEX_SUBAGENT_PROFILE,
    DEFAULT_SUBAGENT_PROFILE,
  );

  const globalProvider = inferGlobalProvider(sourceEnv, configDefaults);
  const active = profileRecord(sourceEnv, activeProfile, globalProvider);
  const sub = profileRecord(sourceEnv, subagentProfile, globalProvider);

  const env = { ...sourceEnv };

  const configModel = readCodexConfigTopLevelModel();

  if (active.model) {
    env.CODEX_MODEL = active.model;
  }

  const profileApiKey = active.apiKey;
  const resolvedProvider = active.provider || globalProvider;
  const configProvider = selectConfigProviderForRuntime(
    configDefaults,
    sourceEnv,
    resolvedProvider,
  );
  const runtimeBaseUrl =
    clean(active.baseUrl) ||
    clean(env.OPENAI_BASE_URL) ||
    clean(configProvider?.baseUrl);
  if (runtimeBaseUrl) {
    const normalizedBaseUrl =
      resolvedProvider === "azure"
        ? normalizeAzureOpenAIBaseUrl(runtimeBaseUrl)
        : runtimeBaseUrl;
    env.OPENAI_BASE_URL = normalizedBaseUrl;
    active.baseUrl = normalizedBaseUrl;
  }

  if (!profileApiKey && configProvider?.envKey && hasEnvValue(sourceEnv, configProvider.envKey)) {
    const configuredApiKey = clean(sourceEnv[configProvider.envKey]);
    if (resolvedProvider === "azure") {
      env.AZURE_OPENAI_API_KEY = configuredApiKey;
      if (!env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = configuredApiKey;
      }
    } else {
      env.OPENAI_API_KEY = configuredApiKey;
    }
  }

  // Azure deployments often differ from default model names.
  // If the env is using Azure and the model is still the default,
  // prefer the top-level ~/.codex/config.toml model when present.
  const activeProfileModelExplicit = Boolean(
    readProfileField(sourceEnv, activeProfile, "MODEL"),
  );
  const runtimeModelExplicit = Boolean(clean(sourceEnv.CODEX_MODEL));
  const activeModelValue = clean(env.CODEX_MODEL);
  const shouldPreferAzureConfigModel =
    resolvedProvider === "azure" &&
    configModel &&
    !activeProfileModelExplicit &&
    !runtimeModelExplicit &&
    !activeModelValue;
  if (shouldPreferAzureConfigModel) {
    env.CODEX_MODEL = configModel;
    active.model = configModel;
  }

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
