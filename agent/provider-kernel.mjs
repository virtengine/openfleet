import { createProviderRegistry } from "./provider-registry.mjs";
import { createProviderSession } from "./provider-session.mjs";
import { getBuiltInProviderDriver, normalizeProviderDefinitionId } from "./providers/index.mjs";

function setProviderSetting(target, key, value) {
  if (value === undefined || value === null || value === "") return;
  target[key] = value;
}

export function buildProviderKernelSettings(config = {}) {
  const providers = config?.providers && typeof config.providers === "object"
    ? config.providers
    : {};
  const flattened = {};
  setProviderSetting(flattened, "BOSUN_PROVIDER_DEFAULT", providers.defaultProvider);
  setProviderSetting(flattened, "BOSUN_PROVIDER_DEFAULT_MODEL", providers.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_RESPONSES_ENABLED", providers.openaiResponses?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_RESPONSES_MODEL", providers.openaiResponses?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED", providers.chatgptCodex?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODE", providers.chatgptCodex?.mode);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODEL", providers.chatgptCodex?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE", providers.chatgptCodex?.workspace);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_ENABLED", providers.azureOpenAi?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_MODE", providers.azureOpenAi?.mode);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_MODEL", providers.azureOpenAi?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_ENDPOINT", providers.azureOpenAi?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_DEPLOYMENT", providers.azureOpenAi?.deployment);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_API_VERSION", providers.azureOpenAi?.apiVersion);
  setProviderSetting(flattened, "BOSUN_PROVIDER_ANTHROPIC_ENABLED", providers.anthropic?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_ANTHROPIC_MODEL", providers.anthropic?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED", providers.claudeSubscription?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODE", providers.claudeSubscription?.mode);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODEL", providers.claudeSubscription?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_WORKSPACE", providers.claudeSubscription?.workspace);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED", providers.openaiCompatible?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODE", providers.openaiCompatible?.mode);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL", providers.openaiCompatible?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL", providers.openaiCompatible?.baseUrl);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OLLAMA_ENABLED", providers.ollama?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OLLAMA_MODEL", providers.ollama?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OLLAMA_BASE_URL", providers.ollama?.baseUrl);
  setProviderSetting(flattened, "BOSUN_PROVIDER_COPILOT_OAUTH_ENABLED", providers.copilotOAuth?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_COPILOT_OAUTH_MODEL", providers.copilotOAuth?.defaultModel);
  return flattened;
}

function extractMessageFromPayload(payload = {}) {
  return payload.prompt
    || payload.messages?.at(-1)?.text
    || payload.messages?.at(-1)?.content?.find?.((entry) => entry?.type === "text")?.text
    || "";
}

function resolveKernelConfig(options = {}) {
  if (typeof options.getConfig === "function") {
    try {
      return options.getConfig() || {};
    } catch {
      return {};
    }
  }
  return options.config && typeof options.config === "object" ? options.config : {};
}

function createRegistryFactory(options = {}) {
  return () => {
    const config = resolveKernelConfig(options);
    const configExecutors = Array.isArray(config?.executorConfig?.executors)
      ? config.executorConfig.executors
      : [];
    const settings = buildProviderKernelSettings(config);
    return createProviderRegistry({
      adapters: options.adapters || {},
      configExecutors,
      defaultProviderId:
        normalizeProviderDefinitionId(
          settings.BOSUN_PROVIDER_DEFAULT || options.env?.BOSUN_PROVIDER_DEFAULT || process.env.BOSUN_PROVIDER_DEFAULT || "",
          "",
        ) || undefined,
      env: options.env || process.env,
      includeBuiltins: options.includeBuiltins !== false,
      settings,
      readBusy: options.readBusy,
      getAdapterCapabilities: options.getAdapterCapabilities,
    });
  };
}

export function createProviderKernel(options = {}) {
  const createRegistryInstance = createRegistryFactory(options);

  function resolveRuntime(selectionId = "", adapterName = "") {
    const registry = createRegistryInstance();
    const normalizedSelectionId = String(selectionId || "").trim();
    const normalizedAdapterName = String(adapterName || "").trim();
    const resolvedSelection = normalizedSelectionId
      ? registry.resolveSelection(normalizedSelectionId)
      : null;
    const providerEntry = resolvedSelection
      ? registry.getProvider(resolvedSelection.selectionId) || registry.getProvider(resolvedSelection.providerId)
      : registry.getDefaultProvider();
    const providerId =
      providerEntry?.providerId
      || normalizeProviderDefinitionId(normalizedSelectionId || normalizedAdapterName, "")
      || null;
    const driver = providerEntry?.providerId
      ? getBuiltInProviderDriver(providerEntry.providerId)
      : null;
    const providerSettings = providerEntry?.auth?.settings && typeof providerEntry.auth.settings === "object"
      ? providerEntry.auth.settings
      : {};
    const providerConfig = driver
      ? driver.createSessionConfig({
          env: options.env || process.env,
          model: providerSettings.defaultModel || providerEntry?.defaultModel || null,
          authMode: providerSettings.authMode || providerEntry?.auth?.preferredMode || null,
          endpoint: providerSettings.endpoint || null,
          baseUrl: providerSettings.baseUrl || null,
          deployment: providerSettings.deployment || null,
          apiVersion: providerSettings.apiVersion || null,
          workspace: providerSettings.workspace || null,
          settings: {
            defaultModel: providerSettings.defaultModel || providerEntry?.defaultModel || null,
            authMode: providerSettings.authMode || null,
          },
        })
      : null;

    return {
      registry,
      selection: resolvedSelection,
      providerEntry: providerEntry || null,
      providerId,
      providerConfig: providerConfig
        ? {
            ...providerConfig,
            provider: providerId,
          }
        : null,
    };
  }

  function withRuntimeOptions(adapterName, selectionId, runtimeOptions = {}) {
    const normalizedAdapterName = String(adapterName || "").trim();
    if (normalizedAdapterName !== "opencode-sdk") {
      return runtimeOptions;
    }
    const runtime = resolveRuntime(selectionId, adapterName);
    if (!runtime.providerId || !runtime.providerConfig) {
      return runtimeOptions;
    }
    return {
      ...runtimeOptions,
      provider: runtime.providerId,
      providerConfig: runtime.providerConfig,
    };
  }

  function createExecutionSession(input = {}) {
    const adapterName = String(input.adapterName || "").trim();
    const selectionId = String(input.selectionId || "").trim();
    const targetAdapter = options.adapters?.[adapterName] || null;
    const runtime = resolveRuntime(selectionId, adapterName);
    const explicitProviderId =
      String(input.provider || runtime.providerId || "").trim() || runtime.providerId || null;
    const explicitProviderConfig =
      input.providerConfig && typeof input.providerConfig === "object" && !Array.isArray(input.providerConfig)
        ? { ...input.providerConfig }
        : null;
    return createProviderSession(runtime.providerId, {
      providerRegistry: runtime.registry,
      adapter: targetAdapter,
      sessionId: input.sessionId || null,
      threadId: input.threadId || input.sessionId || null,
      model: input.model || null,
      metadata: input.metadata || {},
      getProviderRunner: () => async (payload, runnerOptions = {}) => {
        const execOptions = withRuntimeOptions(adapterName, selectionId, {
          ...runnerOptions,
          sessionId: payload.sessionId || runnerOptions.sessionId || null,
          threadId: payload.threadId || runnerOptions.threadId || payload.sessionId || runnerOptions.sessionId || null,
          model: payload.model || runnerOptions.model || null,
          metadata: payload.metadata || runnerOptions.metadata || {},
        });
        const mergedProviderConfig =
          explicitProviderConfig || execOptions.providerConfig
            ? {
                ...(execOptions.providerConfig || {}),
                ...(explicitProviderConfig || {}),
              }
            : undefined;
        return targetAdapter.exec(extractMessageFromPayload(payload), {
          ...execOptions,
          ...(explicitProviderId ? { provider: explicitProviderId } : {}),
          ...(mergedProviderConfig ? { providerConfig: mergedProviderConfig } : {}),
        });
      },
    });
  }

  return {
    createRegistry: createRegistryInstance,
    listProviders() {
      return createRegistryInstance().listProviders();
    },
    resolveSelection(name) {
      return createRegistryInstance().resolveSelection(name);
    },
    resolveRuntime,
    withRuntimeOptions,
    createExecutionSession,
  };
}

export default createProviderKernel;
