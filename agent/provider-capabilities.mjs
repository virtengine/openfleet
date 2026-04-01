const PROVIDER_ALIASES = Object.freeze({
  codex: "codex-sdk",
  "codex-sdk": "codex-sdk",
  copilot: "copilot-sdk",
  "copilot-sdk": "copilot-sdk",
  claude: "claude-sdk",
  "claude-sdk": "claude-sdk",
  gemini: "gemini-sdk",
  "gemini-sdk": "gemini-sdk",
  opencode: "opencode-sdk",
  "opencode-sdk": "opencode-sdk",
});

const DEFAULT_CAPABILITIES = Object.freeze({
  streaming: true,
  steering: false,
  sessions: false,
  sdkCommands: false,
  usage: true,
  auth: true,
  subscription: false,
  apiKey: false,
  oauth: false,
  local: false,
  openaiCompatible: false,
});

const PROVIDER_CAPABILITIES = Object.freeze({
  "codex-sdk": Object.freeze({
    ...DEFAULT_CAPABILITIES,
    steering: true,
    sessions: true,
    sdkCommands: true,
    subscription: true,
    apiKey: true,
  }),
  "copilot-sdk": Object.freeze({
    ...DEFAULT_CAPABILITIES,
    steering: true,
    sdkCommands: true,
    oauth: true,
  }),
  "claude-sdk": Object.freeze({
    ...DEFAULT_CAPABILITIES,
    steering: true,
    sdkCommands: true,
    subscription: true,
  }),
  "gemini-sdk": Object.freeze({
    ...DEFAULT_CAPABILITIES,
    steering: true,
    sessions: true,
    sdkCommands: true,
    apiKey: true,
  }),
  "opencode-sdk": Object.freeze({
    ...DEFAULT_CAPABILITIES,
    steering: true,
    sessions: true,
    sdkCommands: true,
    apiKey: true,
    local: true,
    openaiCompatible: true,
  }),
});

export function normalizeProviderCapabilityId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] || normalized;
}

export function listProviderCapabilityIds() {
  return Object.keys(PROVIDER_CAPABILITIES);
}

export function getProviderCapabilities(providerId, overrides = null) {
  const normalized = normalizeProviderCapabilityId(providerId);
  const base = PROVIDER_CAPABILITIES[normalized] || DEFAULT_CAPABILITIES;
  return overrides && typeof overrides === "object"
    ? { ...base, ...overrides }
    : { ...base };
}

export function supportsProviderCapability(providerId, capability, overrides = null) {
  const resolved = getProviderCapabilities(providerId, overrides);
  return resolved[String(capability || "").trim()] === true;
}

export default getProviderCapabilities;
