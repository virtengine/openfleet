import { getModelsForExecutor } from "../task/task-complexity.mjs";
import { normalizeProviderCapabilityId } from "./provider-capabilities.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => toTrimmedString(value))
      .filter(Boolean),
  )];
}

function normalizeModelFamily(modelId = "") {
  const normalized = toTrimmedString(modelId).toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.startsWith("gpt-")) return "openai";
  if (normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4")) return "openai";
  if (normalized.includes("claude")) return "anthropic";
  if (normalized.includes("gemini")) return "google";
  if (normalized.includes("llama") || normalized.includes("mistral") || normalized.includes("qwen")) return "local";
  return "general";
}

export function normalizeModelEntry(model, options = {}) {
  const value = model && typeof model === "object" ? model : { id: model };
  const id = toTrimmedString(value.id || value.name || value.model);
  if (!id) return null;
  return {
    id,
    label: toTrimmedString(value.label || value.name || id) || id,
    providerId: normalizeProviderCapabilityId(value.providerId || options.providerId),
    family: normalizeModelFamily(id),
    reasoningEffort: toTrimmedString(value.reasoningEffort || value.reasoning || value.effort) || null,
    contextWindow: Number.isFinite(Number(value.contextWindow)) ? Number(value.contextWindow) : null,
    default: value.default === true || id === toTrimmedString(options.defaultModel),
    local: value.local === true || options.local === true,
  };
}

export function listProviderModels(providerId, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const configured = Array.isArray(options.configuredModels) ? options.configuredModels : [];
  const adapterModels = Array.isArray(options.adapterModels)
    ? options.adapterModels
    : Array.isArray(options.adapter?.models)
      ? options.adapter.models
      : [];
  const fallbackModels = uniqueStrings(
    getModelsForExecutor(options.executor || options.adapter?.provider || normalizedProviderId),
  );
  const selectedSource = configured.length > 0
    ? configured
    : (adapterModels.length > 0 ? adapterModels : fallbackModels);
  const merged = uniqueStrings(selectedSource);
  return merged
    .map((entry) => normalizeModelEntry(entry, {
      providerId: normalizedProviderId,
      defaultModel: options.defaultModel,
      local: options.local === true,
    }))
    .filter(Boolean);
}

export function getProviderModelCatalog(providerId, options = {}) {
  const provider = normalizeProviderCapabilityId(providerId);
  const models = listProviderModels(provider, options);
  const defaultModel = models.find((entry) => entry.default) || models[0] || null;
  return {
    providerId: provider,
    defaultModel: defaultModel?.id || null,
    models,
  };
}

export default getProviderModelCatalog;
