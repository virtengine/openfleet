import { getProviderAuthAdapter } from "./auth/index.mjs";
import { normalizeProviderCapabilityId } from "./provider-capabilities.mjs";
import { getBuiltinProviderDefinition } from "./providers/index.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeModelFamily(modelId = "", providerDefinition = null) {
  const normalized = toTrimmedString(modelId).toLowerCase();
  if (!normalized) return "unknown";
  if (providerDefinition?.provider === "ANTHROPIC" || normalized.includes("claude")) return "anthropic";
  if (providerDefinition?.provider?.includes("OPENAI") || normalized.startsWith("gpt-")) return "openai";
  if (normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4")) return "openai";
  if (providerDefinition?.provider === "GEMINI" || normalized.includes("gemini")) return "google";
  if (providerDefinition?.provider === "OLLAMA") return "ollama";
  if (providerDefinition?.capabilities?.local || normalized.includes("llama") || normalized.includes("mistral") || normalized.includes("qwen")) return "local";
  return "general";
}

export function normalizeModelEntry(model, options = {}) {
  const value = model && typeof model === "object" ? model : { id: model };
  const providerId = normalizeProviderCapabilityId(value.providerId || options.providerId);
  const providerDefinition = options.providerDefinition || getBuiltinProviderDefinition(providerId);
  const id = toTrimmedString(value.id || value.name || value.model);
  if (!id) return null;
  return {
    id,
    label: toTrimmedString(value.label || value.name || id) || id,
    providerId,
    family: normalizeModelFamily(id, providerDefinition),
    apiStyle: toTrimmedString(value.apiStyle || value.transport?.apiStyle || "") || null,
    reasoningEffort: toTrimmedString(value.reasoningEffort || value.reasoning || value.effort) || null,
    contextWindow: Number.isFinite(Number(value.contextWindow)) ? Number(value.contextWindow) : null,
    default: value.default === true || id === toTrimmedString(options.defaultModel),
    local: value.local === true || options.local === true || providerDefinition?.capabilities?.local === true,
  };
}

function uniqueEntries(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = typeof value === "string"
      ? toTrimmedString(value)
      : toTrimmedString(value?.id || value?.name || value?.model);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function listProviderModels(providerId, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const providerDefinition = getBuiltinProviderDefinition(normalizedProviderId);
  const authAdapter = getProviderAuthAdapter(normalizedProviderId);
  const settingsState = authAdapter?.resolveSettings({
    settings: options.settings || process.env,
    env: options.env || process.env,
  }) || {};
  const configured = Array.isArray(options.configuredModels) ? options.configuredModels : [];
  const adapterModels = Array.isArray(options.adapterModels)
    ? options.adapterModels
    : Array.isArray(options.adapter?.models)
      ? options.adapter.models
      : [];
  const definitionModels = Array.isArray(providerDefinition?.models) ? providerDefinition.models : [];
  const selectedSource = configured.length > 0
    ? configured
    : (adapterModels.length > 0
      ? adapterModels
      : definitionModels);
  return uniqueEntries(selectedSource)
    .map((entry) => normalizeModelEntry(entry, {
      providerId: normalizedProviderId,
      providerDefinition,
      defaultModel: options.defaultModel || settingsState.defaultModel || providerDefinition?.defaultModel,
      local: options.local === true || providerDefinition?.capabilities?.local === true,
    }))
    .filter(Boolean);
}

export function getProviderModelCatalog(providerId, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const providerDefinition = getBuiltinProviderDefinition(normalizedProviderId);
  const authAdapter = getProviderAuthAdapter(normalizedProviderId);
  const settingsState = authAdapter?.resolveSettings({
    settings: options.settings || process.env,
    env: options.env || process.env,
  }) || {};
  const models = listProviderModels(normalizedProviderId, options);
  const defaultModel = models.find((entry) => entry.id === settingsState.defaultModel)
    || models.find((entry) => entry.default)
    || models.find((entry) => entry.id === providerDefinition?.defaultModel)
    || models[0]
    || null;
  return {
    providerId: normalizedProviderId,
    enabled: settingsState.enabled !== false,
    catalogSource: providerDefinition?.models?.catalogSource || "static",
    defaultModel: defaultModel?.id || settingsState.defaultModel || providerDefinition?.defaultModel || null,
    supportsCustomModel: providerDefinition?.models?.supportsCustomModel !== false,
    models,
  };
}

export default getProviderModelCatalog;
