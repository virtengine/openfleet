/**
 * Canonical architecture note:
 * Provider resolution, provider runtime normalization, and execution-session
 * creation are owned here. Transitional shells and legacy entrypoints may call
 * into this module, but they must not define parallel provider-selection or
 * provider-lifecycle semantics outside the provider kernel contract.
 */

import { createProviderRegistry } from "./provider-registry.mjs";
import { createProviderSession } from "./provider-session.mjs";
import { createToolOrchestrator } from "./tool-orchestrator.mjs";
import { getBuiltInProviderDriver, normalizeProviderDefinitionId } from "./providers/index.mjs";
import { ProviderConfigurationError } from "./providers/provider-errors.mjs";
import {
  normalizeProviderSelection,
  normalizeProviderSessionInput,
} from "./providers/provider-contract.mjs";

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

function renderProviderMessage(message = {}) {
  const role = String(message?.role || "user").trim().toUpperCase() || "USER";
  const lines = [];
  const text = String(
    message?.text
    || message?.content?.find?.((entry) => entry?.type === "text")?.text
    || "",
  ).trim();
  if (text) {
    lines.push(`${role}: ${text}`);
  }
  for (const entry of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
    lines.push(`${role} TOOL_CALL ${String(entry?.name || entry?.id || "tool").trim()}: ${JSON.stringify(entry?.input ?? {})}`);
  }
  for (const entry of Array.isArray(message?.toolResults) ? message.toolResults : []) {
    lines.push(`TOOL_RESULT ${String(entry?.name || entry?.toolCallId || "tool").trim()}: ${JSON.stringify(entry?.output ?? {})}`);
  }
  return lines.join("\n");
}

function extractMessageFromPayload(payload = {}) {
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    const transcript = payload.messages
      .map((message) => renderProviderMessage(message))
      .filter(Boolean)
      .join("\n\n");
    if (transcript) return transcript;
  }
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
    if (options.providerRegistry && typeof options.providerRegistry.listProviders === "function") {
      return options.providerRegistry;
    }
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

function createSessionToolOrchestrator(input = {}, options = {}) {
  if (input.toolOrchestrator && typeof input.toolOrchestrator === "object") {
    return input.toolOrchestrator;
  }
  if (options.toolOrchestrator && typeof options.toolOrchestrator === "object") {
    return options.toolOrchestrator;
  }
  return createToolOrchestrator({
    cwd: input.cwd || options.cwd || process.cwd(),
    repoRoot: input.repoRoot || options.repoRoot || input.cwd || options.cwd || process.cwd(),
    agentProfileId: input.agentProfileId || options.agentProfileId || null,
    sessionManager: input.sessionManager || options.sessionManager || null,
    onEvent: input.onEvent || options.onEvent,
    includeBuiltinBosunTools: input.includeBuiltinBosunTools ?? options.includeBuiltinBosunTools,
    toolSources: input.toolSources || options.toolSources,
    registry: input.toolRegistry || options.toolRegistry,
  });
}

export function createProviderKernel(options = {}) {
  const createRegistryInstance = createRegistryFactory(options);

  function resolveRuntime(selectionId = "", adapterName = "") {
    const registry = createRegistryInstance();
    const normalizedSelectionId = String(selectionId || "").trim();
    const resolvedRuntime = normalizedSelectionId
      ? (
        typeof registry.resolveProviderRuntime === "function"
          ? registry.resolveProviderRuntime(normalizedSelectionId)
          : {
              selection: registry.resolveSelection?.(normalizedSelectionId) || null,
              provider:
                registry.getProvider?.(normalizedSelectionId)
                || registry.getProvider?.(registry.resolveSelection?.(normalizedSelectionId)?.providerId)
                || registry.getDefaultProvider?.()
                || null,
            }
      )
      : { selection: null, provider: registry.getDefaultProvider() };
    const resolvedSelection = normalizeProviderSelection(resolvedRuntime.selection || {});
    const providerEntry = resolvedRuntime.provider || registry.getDefaultProvider();
    const providerId =
      providerEntry?.providerId
      || normalizeProviderDefinitionId(normalizedSelectionId || adapterName, "")
      || null;
    const driver = providerId ? getBuiltInProviderDriver(providerId) : null;
    const providerSettings = providerEntry?.auth?.settings && typeof providerEntry.auth.settings === "object"
      ? providerEntry.auth.settings
      : {};
    const providerOverrides = {
      model: providerSettings.defaultModel || providerEntry?.defaultModel || resolvedSelection.model || null,
      authMode: providerSettings.authMode || providerEntry?.auth?.preferredMode || null,
      endpoint: providerSettings.endpoint || null,
      baseUrl: providerSettings.baseUrl || null,
      deployment: providerSettings.deployment || null,
      apiVersion: providerSettings.apiVersion || null,
      workspace: providerSettings.workspace || null,
    };
    const providerConfig = providerEntry?.providerId
      ? (
        typeof registry.buildSessionConfig === "function"
          ? registry.buildSessionConfig(providerEntry.providerId, providerOverrides)
          : driver?.createSessionConfig({
              env: options.env || process.env,
              ...providerOverrides,
              settings: {
                defaultModel: providerSettings.defaultModel || providerEntry?.defaultModel || null,
                authMode: providerSettings.authMode || null,
                endpoint: providerSettings.endpoint || null,
                baseUrl: providerSettings.baseUrl || null,
                deployment: providerSettings.deployment || null,
                apiVersion: providerSettings.apiVersion || null,
                workspace: providerSettings.workspace || null,
              },
            })
      )
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
    const normalizedInput = normalizeProviderSessionInput({
      providerId: input.provider || input.selectionId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      metadata: input.metadata || {},
    });
    const requestedAdapterName = String(input.adapterName || "").trim();
    const selectionId = String(input.selectionId || input.provider || "").trim();
    const runtime = resolveRuntime(selectionId, requestedAdapterName);
    const adapterName = requestedAdapterName || runtime.providerEntry?.adapterId || "";
    const targetAdapter = options.adapters?.[adapterName] || null;
    if (!runtime.providerEntry && !targetAdapter) {
      throw new ProviderConfigurationError(`Unknown provider selection "${selectionId || adapterName || "default"}"`, {
        providerId: selectionId || null,
      });
    }
    const explicitProviderId =
      String(input.provider || runtime.providerId || "").trim() || runtime.providerId || null;
    const explicitProviderConfig =
      input.providerConfig && typeof input.providerConfig === "object" && !Array.isArray(input.providerConfig)
        ? { ...input.providerConfig }
        : null;
    const toolOrchestrator = createSessionToolOrchestrator(input, options);
    return createProviderSession(runtime.providerId, {
      providerRegistry: runtime.registry,
      adapter: targetAdapter,
      sessionId: normalizedInput.sessionId,
      threadId: normalizedInput.threadId,
      model: normalizedInput.model,
      metadata: normalizedInput.metadata,
      cwd: input.cwd || options.cwd || null,
      repoRoot: input.repoRoot || options.repoRoot || input.cwd || options.cwd || null,
      agentProfileId: input.agentProfileId || options.agentProfileId || null,
      sessionManager: input.sessionManager || options.sessionManager || null,
      onEvent: input.onEvent || options.onEvent,
      toolOrchestrator,
      executeTool: input.executeTool || options.executeTool || null,
      toolRunner: input.toolRunner || options.toolRunner || null,
      maxToolRounds: input.maxToolRounds ?? options.maxToolRounds,
      subagentMaxParallel: input.subagentMaxParallel ?? options.subagentMaxParallel,
      getProviderRunner:
        typeof options.getProviderRunner === "function"
          ? options.getProviderRunner
          : (
            targetAdapter && typeof targetAdapter.exec === "function"
              ? () => async (payload, runnerOptions = {}) => {
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
                          model:
                            payload.model
                            || runnerOptions.model
                            || normalizedInput.model
                            || execOptions.providerConfig?.model
                            || explicitProviderConfig?.model
                            || null,
                        }
                      : undefined;
                  return targetAdapter.exec(extractMessageFromPayload(payload), {
                    ...execOptions,
                    ...(explicitProviderId ? { provider: explicitProviderId } : {}),
                    ...(mergedProviderConfig ? { providerConfig: mergedProviderConfig } : {}),
                  });
                }
              : null
          ),
    });
  }

  return {
    createRegistry: createRegistryInstance,
    getInventory() {
      return createRegistryInstance().getInventory();
    },
    listProviders() {
      return createRegistryInstance().listProviders();
    },
    listEnabledProviders() {
      return createRegistryInstance().listEnabledProviders();
    },
    getRegistrySnapshot() {
      return createRegistryInstance().getRegistrySnapshot();
    },
    resolveSelection(name) {
      return createRegistryInstance().resolveSelection(name);
    },
    resolveRuntime,
    withRuntimeOptions,
    createSession(input = {}) {
      return createExecutionSession(input);
    },
    createExecutionSession,
  };
}

export default createProviderKernel;
