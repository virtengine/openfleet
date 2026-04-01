import {
  getAvailableAgents,
  getPrimaryAgentName,
  getPrimaryAgentSelection,
  getSdkCommands,
  initPrimaryAgent,
  switchPrimaryAgent,
} from "./primary-agent.mjs";
import {
  deriveProviderCapabilities,
  buildProviderCapabilitySummary,
} from "./provider-capabilities.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPoolSdk(adapterId) {
  const normalized = toTrimmedString(adapterId).toLowerCase();
  if (normalized === "copilot-sdk") return "copilot";
  if (normalized === "claude-sdk") return "claude";
  if (normalized === "gemini-sdk") return "gemini";
  if (normalized === "opencode-sdk") return "opencode";
  return "codex";
}

function normalizeProviderRecord(agent = {}, activeSelection = "", activeAdapter = "") {
  const selectionId = toTrimmedString(agent.id || agent.selectionId || agent.name || agent.adapterId);
  const adapterId = toTrimmedString(agent.adapterId || agent.name || "codex-sdk") || "codex-sdk";
  const capabilities = deriveProviderCapabilities({
    ...agent,
    capabilities: {
      sessions: agent.capabilities?.sessions === true,
      steering: agent.capabilities?.steering === true,
      sdkCommands: getSdkCommands(adapterId),
    },
  });
  return {
    id: selectionId || adapterId,
    selectionId: selectionId || adapterId,
    adapterId,
    poolSdk: toPoolSdk(adapterId),
    name: toTrimmedString(agent.name || selectionId || adapterId) || adapterId,
    provider: toTrimmedString(agent.provider || agent.executor || adapterId).toUpperCase() || adapterId.toUpperCase(),
    executor: toTrimmedString(agent.executor || agent.provider || adapterId).toUpperCase() || adapterId.toUpperCase(),
    variant: toTrimmedString(agent.variant || "DEFAULT") || "DEFAULT",
    available: agent.available !== false,
    busy: agent.busy === true,
    models: Array.isArray(agent.models) ? agent.models.map((model) => toTrimmedString(model)).filter(Boolean) : [],
    capabilities,
    capabilitySummary: buildProviderCapabilitySummary({
      id: selectionId || adapterId,
      adapterId,
      capabilities,
      sdkCommands: getSdkCommands(adapterId),
    }),
    isActive:
      selectionId === activeSelection ||
      adapterId === activeSelection ||
      adapterId === activeAdapter,
  };
}

export async function listRegisteredProviders(options = {}) {
  if (options.initialize !== false) {
    await initPrimaryAgent(options.primaryAgent || null);
  }
  const activeSelection = getPrimaryAgentSelection();
  const activeAdapter = getPrimaryAgentName();
  return getAvailableAgents().map((agent) => normalizeProviderRecord(agent, activeSelection, activeAdapter));
}

export async function getProviderRecord(providerId, options = {}) {
  const providers = await listRegisteredProviders(options);
  const requested = toTrimmedString(providerId);
  if (!requested) {
    return providers.find((provider) => provider.isActive) || providers[0] || null;
  }
  return providers.find((provider) =>
    provider.id === requested ||
    provider.selectionId === requested ||
    provider.adapterId === requested ||
    provider.name === requested
  ) || null;
}

export async function resolveProviderRecord(providerLike, options = {}) {
  if (providerLike && typeof providerLike === "object" && toTrimmedString(providerLike.adapterId || providerLike.id)) {
    return normalizeProviderRecord(
      providerLike,
      toTrimmedString(options.activeSelection || getPrimaryAgentSelection()),
      toTrimmedString(options.activeAdapter || getPrimaryAgentName()),
    );
  }
  return await getProviderRecord(providerLike, options);
}

export async function getActiveProviderRecord(options = {}) {
  return await getProviderRecord(
    options.providerId || getPrimaryAgentSelection() || getPrimaryAgentName(),
    options,
  );
}

export async function activateProviderRecord(providerId, options = {}) {
  const requested = toTrimmedString(providerId);
  if (!requested) return { ok: false, reason: "missing_provider" };
  const switched = await switchPrimaryAgent(requested);
  if (switched?.ok !== true) {
    return { ok: false, reason: switched?.reason || "switch_failed" };
  }
  return {
    ok: true,
    provider: await getProviderRecord(requested, options),
  };
}

export async function createProviderRegistry(options = {}) {
  return {
    listProviders: (overrides = {}) => listRegisteredProviders({ ...options, ...overrides }),
    getProvider: (providerId, overrides = {}) => getProviderRecord(providerId, { ...options, ...overrides }),
    getActiveProvider: (overrides = {}) => getActiveProviderRecord({ ...options, ...overrides }),
    resolveProvider: (providerLike, overrides = {}) => resolveProviderRecord(providerLike, { ...options, ...overrides }),
    activateProvider: (providerId, overrides = {}) => activateProviderRecord(providerId, { ...options, ...overrides }),
  };
}

export default createProviderRegistry;
