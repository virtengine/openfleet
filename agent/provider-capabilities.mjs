function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => toTrimmedString(value)).filter(Boolean))];
}

function inferAuthMode(provider = {}) {
  const adapterId = toTrimmedString(provider.adapterId).toLowerCase();
  if (adapterId === "codex-sdk") return "subscription_or_api";
  if (adapterId === "copilot-sdk") return "oauth";
  if (adapterId === "claude-sdk") return "subscription_or_api";
  if (adapterId === "gemini-sdk") return "api";
  if (adapterId === "opencode-sdk") return "local_or_remote";
  return "unknown";
}

export function normalizeProviderCapabilities(input = {}) {
  return {
    streaming: input.streaming !== false,
    steering: input.steering === true,
    persistentSessions: input.persistentSessions === true,
    listSessions: input.listSessions === true,
    createSessions: input.createSessions === true,
    switchSessions: input.switchSessions === true,
    pooledExecution: input.pooledExecution !== false,
    primaryExecution: input.primaryExecution !== false,
    sdkCommands: uniqueStrings(input.sdkCommands),
    modelSelection: input.modelSelection !== false,
    attachments: input.attachments !== false,
    toolCalls: input.toolCalls !== false,
    authMode: toTrimmedString(input.authMode || "unknown") || "unknown",
  };
}

export function deriveProviderCapabilities(provider = {}) {
  const capabilityInput = provider.capabilities && typeof provider.capabilities === "object"
    ? provider.capabilities
    : {};
  return normalizeProviderCapabilities({
    streaming: capabilityInput.streaming !== false,
    steering: capabilityInput.steering === true,
    persistentSessions:
      capabilityInput.sessions === true ||
      capabilityInput.persistentSessions === true,
    listSessions:
      capabilityInput.sessions === true ||
      capabilityInput.listSessions === true,
    createSessions:
      capabilityInput.sessions === true ||
      capabilityInput.createSessions === true,
    switchSessions:
      capabilityInput.sessions === true ||
      capabilityInput.switchSessions === true,
    pooledExecution: capabilityInput.pooledExecution !== false,
    primaryExecution: capabilityInput.primaryExecution !== false,
    sdkCommands: capabilityInput.sdkCommands || provider.sdkCommands || [],
    modelSelection: capabilityInput.modelSelection !== false,
    attachments: capabilityInput.attachments !== false,
    toolCalls: capabilityInput.toolCalls !== false,
    authMode: capabilityInput.authMode || inferAuthMode(provider),
  });
}

export function buildProviderCapabilitySummary(provider = {}) {
  const capabilities = deriveProviderCapabilities(provider);
  return {
    providerId: toTrimmedString(provider.id || provider.selectionId || provider.adapterId),
    adapterId: toTrimmedString(provider.adapterId || provider.name),
    authMode: capabilities.authMode,
    supportsSteering: capabilities.steering,
    supportsPersistentSessions: capabilities.persistentSessions,
    supportsPooledExecution: capabilities.pooledExecution,
    supportsPrimaryExecution: capabilities.primaryExecution,
    supportsToolCalls: capabilities.toolCalls,
    supportsAttachments: capabilities.attachments,
    sdkCommands: capabilities.sdkCommands,
  };
}

export default deriveProviderCapabilities;
