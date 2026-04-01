import { getModelsForExecutor, normalizeExecutorKey } from "../task/task-complexity.mjs";
import { createProviderAuthManager } from "./provider-auth-manager.mjs";
import { getProviderCapabilities, normalizeProviderCapabilityId } from "./provider-capabilities.mjs";
import { getProviderModelCatalog } from "./provider-model-catalog.mjs";

function envFlagEnabled(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

export function normalizeProviderAdapterName(value) {
  const normalized = normalizeProviderCapabilityId(value);
  if (normalized === "github-copilot") return "copilot-sdk";
  if (normalized === "claude_code" || normalized === "claude-code") return "claude-sdk";
  if (normalized === "google-gemini") return "gemini-sdk";
  if (normalized === "open-code") return "opencode-sdk";
  return normalized || "codex-sdk";
}

export function executorToAdapterName(executor) {
  const key = normalizeExecutorKey(executor);
  if (key === "copilot") return "copilot-sdk";
  if (key === "claude") return "claude-sdk";
  if (key === "gemini") return "gemini-sdk";
  if (key === "opencode") return "opencode-sdk";
  return "codex-sdk";
}

function resolveDisabled(adapterId, env = process.env) {
  const envKey = `${String(adapterId || "").replace("-sdk", "").toUpperCase()}_SDK_DISABLED`;
  return envFlagEnabled(env?.[envKey]);
}

function buildCapabilities(adapter, adapterId, getAdapterCapabilities) {
  const providerCapabilities = getProviderCapabilities(adapterId);
  const adapterCapabilities =
    typeof getAdapterCapabilities === "function"
      ? getAdapterCapabilities(adapter)
      : {};
  return {
    ...providerCapabilities,
    ...adapterCapabilities,
  };
}

function resolveProviderAuth(adapterId, fields, options) {
  const authManager = createProviderAuthManager({ env: options.env || process.env });
  const readAuthState = typeof options.readAuthState === "function"
    ? options.readAuthState
    : () => ({});
  return authManager.resolve(adapterId, readAuthState(adapterId, fields) || {}, {
    capabilities: buildCapabilities({}, adapterId, null),
  });
}

function buildProviderEntry(adapterId, adapter, fields, options) {
  const configuredModels = Array.isArray(fields.models)
    ? fields.models.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const modelCatalog = getProviderModelCatalog(adapterId, {
    adapter,
    executor: fields.executor,
    configuredModels,
    defaultModel: fields.defaultModel,
    local: getProviderCapabilities(adapterId).local === true,
  });
  return {
    id: fields.id,
    name: fields.name,
    provider: fields.provider,
    executor: fields.executor,
    variant: fields.variant,
    adapterId,
    available: fields.available,
    busy: fields.busy,
    models: configuredModels.length > 0
      ? configuredModels
      : modelCatalog.models.map((entry) => entry.id),
    defaultModel: fields.defaultModel || modelCatalog.defaultModel,
    modelCatalog,
    auth: resolveProviderAuth(adapterId, fields, options),
    capabilities: buildCapabilities(adapter, adapterId, options.getAdapterCapabilities),
  };
}

export function listRegisteredProviders(options = {}) {
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

  if (executors.length > 0) {
    return executors.map((entry, index) => {
      const adapterId = normalizeProviderAdapterName(
        entry?.adapterId || executorToAdapterName(entry?.executor),
      );
      const adapter = adapters[adapterId] || adapters["codex-sdk"] || {};
      const available = entry?.enabled !== false && !resolveDisabled(adapterId, env);
      const configuredModels = Array.isArray(entry?.models)
        ? entry.models.map((model) => String(model || "").trim()).filter(Boolean)
        : [];
      const name = String(entry?.name || "").trim() || adapter.displayName || adapter.name || adapterId;
      return buildProviderEntry(
        adapterId,
        adapter,
        {
          id: name || `${adapterId}-${index + 1}`,
          name,
          provider: adapter.provider || String(entry?.executor || "").toUpperCase() || adapterId,
          executor: String(entry?.executor || "").toUpperCase() || adapter.provider || adapterId,
          variant: String(entry?.variant || "DEFAULT"),
          available,
          busy: available ? readBusy(adapter) : false,
          models: configuredModels,
        },
        options,
      );
    });
  }

  return Object.entries(adapters).map(([adapterId, adapter]) => {
    const available = !resolveDisabled(adapterId, env);
    return buildProviderEntry(
      adapterId,
      adapter,
      {
        id: adapterId,
        name: adapter.displayName || adapter.name || adapterId,
        provider: adapter.provider || adapterId,
        executor: adapter.provider || adapterId,
        variant: "DEFAULT",
        available,
        busy: available ? readBusy(adapter) : false,
        models: [],
      },
      options,
    );
  });
}

export function resolveProviderSelection(name, options = {}) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const normalized = normalizeProviderAdapterName(raw);
  const adapters = options.adapters && typeof options.adapters === "object"
    ? options.adapters
    : {};
  if (adapters[normalized]) {
    return { adapterName: normalized, selectionId: normalized };
  }

  const providers = Array.isArray(options.availableProviders)
    ? options.availableProviders
    : listRegisteredProviders(options);
  const match = providers.find((entry) => entry.id === raw);
  if (!match) return null;
  const adapterName = normalizeProviderAdapterName(match.adapterId || match.executor || match.provider);
  if (!adapters[adapterName]) return null;
  return {
    adapterName,
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
    getProvider(adapterId) {
      const normalized = normalizeProviderAdapterName(adapterId);
      const providers = listRegisteredProviders(options);
      return providers.find((entry) => entry.adapterId === normalized || entry.id === adapterId) || null;
    },
    getCapabilities(adapterId) {
      return getProviderCapabilities(adapterId);
    },
  };
}

export default createProviderRegistry;
