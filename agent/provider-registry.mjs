import { getModelsForExecutor, normalizeExecutorKey } from "../task/task-complexity.mjs";
import { createProviderAuthManager } from "./provider-auth-manager.mjs";
import { getProviderCapabilities, normalizeProviderCapabilityId } from "./provider-capabilities.mjs";
import { getProviderModelCatalog } from "./provider-model-catalog.mjs";
import {
  getBuiltinProviderDefinition,
  listBuiltinProviderDefinitions,
  normalizeProviderDefinitionId,
  resolveProviderAdapterId,
} from "./providers/index.mjs";

function envFlagEnabled(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

export function normalizeProviderAdapterName(value) {
  const adapterId = resolveProviderAdapterId(value);
  if (adapterId) return adapterId;
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "github-copilot") return "copilot-sdk";
  if (normalized === "claude_code" || normalized === "claude-code") return "claude-sdk";
  if (normalized === "google-gemini" || normalized === "gemini" || normalized === "gemini-sdk") return "gemini-sdk";
  if (normalized === "open-code" || normalized === "opencode" || normalized === "opencode-sdk") return "opencode-sdk";
  if (normalized === "copilot" || normalized === "copilot-sdk") return "copilot-sdk";
  if (normalized === "claude" || normalized === "claude-sdk" || normalized === "anthropic") return "claude-sdk";
  if (normalized === "ollama") return "opencode-sdk";
  return "codex-sdk";
}

export function executorToAdapterName(executor) {
  const key = normalizeExecutorKey(executor);
  const definition = getBuiltinProviderDefinition(key);
  if (definition?.adapterId) return definition.adapterId;
  if (key === "copilot") return "copilot-sdk";
  if (key === "claude" || key === "anthropic") return "claude-sdk";
  if (key === "gemini") return "gemini-sdk";
  if (key === "opencode" || key === "ollama" || key === "openai-compatible") return "opencode-sdk";
  return "codex-sdk";
}

function resolveDisabled(definition, env = process.env) {
  const providerKey = String(definition?.id || "").replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  const adapterKey = String(definition?.adapterId || "").replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  const providerDisabled = providerKey ? envFlagEnabled(env?.[`${providerKey}_DISABLED`]) : false;
  const adapterDisabled = adapterKey ? envFlagEnabled(env?.[`${adapterKey}_DISABLED`]) : false;
  return providerDisabled || adapterDisabled;
}

function buildCapabilities(adapter, providerId, getAdapterCapabilities) {
  const providerCapabilities = getProviderCapabilities(providerId);
  const adapterCapabilities =
    typeof getAdapterCapabilities === "function"
      ? getAdapterCapabilities(adapter, providerId)
      : {};
  return {
    ...providerCapabilities,
    ...adapterCapabilities,
  };
}

function resolveProviderAuth(providerId, fields, options) {
  const authManager = createProviderAuthManager({ env: options.env || process.env });
  const readAuthState = typeof options.readAuthState === "function"
    ? options.readAuthState
    : () => ({});
  return authManager.resolve(providerId, readAuthState(providerId, fields) || {}, {
    capabilities: buildCapabilities({}, providerId, null),
  });
}

function buildProviderEntry(providerId, definition, adapter, fields, options) {
  const configuredModels = Array.isArray(fields.models)
    ? fields.models.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const modelCatalog = getProviderModelCatalog(providerId, {
    adapter,
    executor: fields.executor,
    configuredModels,
    defaultModel: fields.defaultModel || definition?.defaultModel,
    local: getProviderCapabilities(providerId).local === true,
  });
  const capabilities = buildCapabilities(adapter, providerId, options.getAdapterCapabilities);
  return {
    id: fields.id,
    name: fields.name,
    providerId,
    provider: fields.provider,
    executor: fields.executor,
    variant: fields.variant,
    adapterId: definition?.adapterId || normalizeProviderAdapterName(providerId),
    transport: definition?.transport || null,
    available: fields.available,
    busy: fields.busy,
    models: configuredModels.length > 0
      ? configuredModels
      : modelCatalog.models.map((entry) => entry.id),
    defaultModel: fields.defaultModel || modelCatalog.defaultModel,
    modelCatalog,
    auth: resolveProviderAuth(providerId, fields, options),
    capabilities,
    definition: definition ? { ...definition } : null,
  };
}

function resolveDefinitionFromEntry(entry = {}) {
  const direct = entry.providerId || entry.id || entry.adapterId || entry.executor || entry.provider;
  const normalizedProviderId = normalizeProviderDefinitionId(direct, "");
  const definition = getBuiltinProviderDefinition(normalizedProviderId || entry.adapterId || entry.executor);
  return {
    providerId: definition?.id || normalizeProviderCapabilityId(direct),
    definition,
  };
}

function buildConfiguredProviders(options = {}) {
  const adapters = options.adapters && typeof options.adapters === "object"
    ? options.adapters
    : {};
  const env = options.env || process.env;
  const readBusy = typeof options.readBusy === "function"
    ? options.readBusy
    : () => false;
  const executors = Array.isArray(options.configExecutors)
    ? options.configExecutors
    : [];
  return executors.map((entry, index) => {
    const { providerId, definition } = resolveDefinitionFromEntry(entry);
    const adapterId = definition?.adapterId || normalizeProviderAdapterName(entry?.adapterId || entry?.executor);
    const adapter = adapters[adapterId] || adapters["codex-sdk"] || {};
    const available = entry?.enabled !== false && !resolveDisabled(definition || { id: providerId, adapterId }, env);
    const configuredModels = Array.isArray(entry?.models)
      ? entry.models.map((model) => String(model || "").trim()).filter(Boolean)
      : [];
    const name = String(entry?.name || "").trim()
      || definition?.name
      || adapter.displayName
      || adapter.name
      || providerId;
    return buildProviderEntry(
      providerId,
      definition,
      adapter,
      {
        id: name || `${providerId}-${index + 1}`,
        name,
        provider: definition?.provider || adapter.provider || String(entry?.executor || "").toUpperCase() || providerId,
        executor: definition?.executor || String(entry?.executor || "").toUpperCase() || adapter.provider || providerId,
        variant: String(entry?.variant || definition?.variant || "DEFAULT"),
        available,
        busy: available ? readBusy(adapter) : false,
        models: configuredModels,
        defaultModel: entry?.defaultModel || definition?.defaultModel || null,
      },
      options,
    );
  });
}

function buildBuiltinProviders(options = {}) {
  const adapters = options.adapters && typeof options.adapters === "object"
    ? options.adapters
    : {};
  const env = options.env || process.env;
  const readBusy = typeof options.readBusy === "function"
    ? options.readBusy
    : () => false;
  return listBuiltinProviderDefinitions().map((definition) => {
    const adapter = adapters[definition.adapterId] || adapters["codex-sdk"] || {};
    const available = !resolveDisabled(definition, env);
    return buildProviderEntry(
      definition.id,
      definition,
      adapter,
      {
        id: definition.id,
        name: definition.name,
        provider: definition.provider,
        executor: definition.executor,
        variant: definition.variant || "DEFAULT",
        available,
        busy: available ? readBusy(adapter) : false,
        models: [],
        defaultModel: definition.defaultModel || null,
      },
      options,
    );
  });
}

export function listRegisteredProviders(options = {}) {
  const configuredProviders = buildConfiguredProviders(options);
  if (configuredProviders.length > 0) return configuredProviders;
  return buildBuiltinProviders(options);
}

export function resolveProviderSelection(name, options = {}) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const providers = Array.isArray(options.availableProviders)
    ? options.availableProviders
    : listRegisteredProviders(options);
  const directProviderId = normalizeProviderDefinitionId(raw, "");
  if (directProviderId) {
    const providerMatch = providers.find((entry) => entry.providerId === directProviderId);
    if (providerMatch) {
      return {
        providerId: providerMatch.providerId,
        adapterName: normalizeProviderAdapterName(providerMatch.adapterId || providerMatch.providerId),
        selectionId: providerMatch.providerId,
      };
    }
  }
  const match = providers.find((entry) =>
    entry.id === raw || entry.adapterId === normalizeProviderAdapterName(raw));
  if (!match) return null;
  return {
    providerId: match.providerId || normalizeProviderCapabilityId(match.id),
    adapterName: normalizeProviderAdapterName(match.adapterId || match.providerId || match.executor || match.provider),
    selectionId: match.id,
  };
}

export function createProviderRegistry(options = {}) {
  return {
    listProviders() {
      return listRegisteredProviders(options);
    },
    resolveSelection(name) {
      return resolveProviderSelection(name, options);
    },
    getProvider(providerId) {
      const normalized = normalizeProviderCapabilityId(providerId);
      const providers = listRegisteredProviders(options);
      return providers.find((entry) => entry.providerId === normalized || entry.id === providerId) || null;
    },
    getCapabilities(providerId) {
      return getProviderCapabilities(providerId);
    },
    getDefinition(providerId) {
      return getBuiltinProviderDefinition(providerId);
    },
    getDefaultProvider() {
      const providers = listRegisteredProviders(options);
      return providers[0] || null;
    },
  };
}

export default createProviderRegistry;
