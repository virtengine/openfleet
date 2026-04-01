import {
  buildProviderTurnPayload,
  normalizeProviderStreamEvent,
  normalizeProviderResultPayload,
} from "./provider-message-transform.mjs";
import { createProviderRegistry } from "./provider-registry.mjs";

export function extractProviderResponseText(result) {
  if (typeof result === "string") return result;
  return normalizeProviderResultPayload(result).text || JSON.stringify(result);
}

function normalizeProviderResult(result, context = {}) {
  const normalized = normalizeProviderResultPayload(result, context);
  return {
    success: result?.success !== false && !normalized.error,
    output: normalized.text,
    status: result?.status || (normalized.error || result?.success === false ? "failed" : "completed"),
    outcome: result?.outcome || (normalized.error || result?.success === false ? "failure" : "success"),
    sessionId: normalized.sessionId,
    threadId: normalized.threadId,
    items: normalized.messages,
    usage: normalized.usage,
    toolCalls: normalized.toolCalls,
    toolResults: normalized.toolResults,
    reasoning: normalized.reasoning,
    reasoningText: normalized.reasoningText,
    finishReason: normalized.finishReason,
    error: normalized.error,
    providerId: normalized.providerId || context.providerId || null,
    model: normalized.model || context.model || null,
    raw: result,
  };
}

export function createLinkedAbortController(parentController = null) {
  const controller = new AbortController();
  const parentSignal = parentController?.signal || null;
  if (!parentSignal) return controller;
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return controller;
  }
  parentSignal.addEventListener("abort", () => {
    controller.abort(parentSignal.reason || "user_stop");
  }, { once: true });
  return controller;
}

export async function runProviderSessionTurn({
  adapter,
  message,
  options = {},
  timeoutMs,
  label,
  withTimeout,
}) {
  if (!adapter || typeof adapter.exec !== "function") {
    throw new Error("Provider adapter.exec is required");
  }
  if (typeof withTimeout !== "function") {
    throw new Error("withTimeout helper is required");
  }
  const timeoutAbort = createLinkedAbortController(options.abortController || null);
  const result = await withTimeout(
    adapter.exec(message, { ...options, abortController: timeoutAbort }),
    timeoutMs,
    label || `${adapter.name || "provider"}.exec`,
    timeoutAbort,
  );
  return {
    result,
    text: extractProviderResponseText(result),
    abortController: timeoutAbort,
  };
}

function resolveRegistry(options = {}) {
  if (options.providerRegistry && typeof options.providerRegistry.listProviders === "function") {
    return options.providerRegistry;
  }
  return createProviderRegistry({
    adapters: options.adapters || {},
    configExecutors: options.configExecutors || [],
    env: options.env,
    readBusy: options.readBusy,
    getAdapterCapabilities: options.getAdapterCapabilities,
    readAuthState: options.readAuthState,
  });
}

function resolveProviderRuntime(providerId, options = {}) {
  const registry = resolveRegistry(options);
  const selection = registry.resolveSelection(providerId || options.provider || "");
  const provider = registry.getProvider(selection?.providerId || providerId || options.provider)
    || registry.getDefaultProvider();
  const adapters = options.adapters && typeof options.adapters === "object"
    ? options.adapters
    : {};
  const adapter = provider?.adapterId ? adapters[provider.adapterId] || null : null;
  return {
    registry,
    provider,
    adapter,
  };
}

export function createProviderSession(providerId = null, options = {}) {
  const runtime = resolveProviderRuntime(providerId, options);
  const provider = runtime.provider?.providerId || providerId || options.provider || "unknown";
  const adapter = options.adapter || runtime.adapter;
  let activeSessionId = String(options.sessionId || "").trim() || null;
  let activeThreadId = String(options.threadId || options.sessionId || "").trim() || null;
  let activeModel = String(options.model || runtime.provider?.defaultModel || "").trim() || null;
  const runner =
    typeof options.runTurn === "function"
      ? options.runTurn
      : (typeof options.getProviderRunner === "function"
        ? options.getProviderRunner({
          providerId: provider,
          adapterId: runtime.provider?.adapterId || null,
          adapter,
          definition: runtime.provider?.definition || null,
        })
        : null);

  return {
    provider,
    providerEntry: runtime.provider || null,
    adapter,
    options: { ...options, provider },
    async runTurn(message, turnOptions = {}) {
      if (typeof runner !== "function") {
        if (!adapter || typeof adapter.exec !== "function") {
          throw new Error(`Provider session "${provider}" is not configured`);
        }
      }
      const payload = buildProviderTurnPayload(message, {
        providerId: provider,
        model: turnOptions.model || activeModel || runtime.provider?.defaultModel || null,
        tools: turnOptions.tools || options.tools,
        metadata: turnOptions.metadata || options.metadata,
        reasoningEffort: turnOptions.reasoningEffort || turnOptions.reasoning || options.reasoningEffort || options.reasoning,
        sessionId: turnOptions.sessionId || activeSessionId || options.sessionId,
        threadId: turnOptions.threadId || activeThreadId || options.threadId || options.sessionId,
      });
      const result = typeof runner === "function"
        ? await runner(payload, {
          ...options,
          ...turnOptions,
          provider,
          providerEntry: runtime.provider || null,
          adapter,
        })
        : await adapter.exec(payload, {
          ...options,
          ...turnOptions,
          provider,
          providerEntry: runtime.provider || null,
        });
      const normalized = normalizeProviderResult(result, {
        providerId: provider,
        model: payload.model,
        sessionId: payload.sessionId,
        threadId: payload.threadId,
      });
      activeModel = normalized.model || payload.model || activeModel;
      activeSessionId = normalized.sessionId || payload.sessionId || activeSessionId;
      activeThreadId = normalized.threadId || payload.threadId || activeThreadId || activeSessionId;
      return normalized;
    },
    normalizeStreamEvent(event, eventOptions = {}) {
      return normalizeProviderStreamEvent(event, {
        providerId: provider,
        sessionId: eventOptions.sessionId || activeSessionId || options.sessionId,
        threadId:
          eventOptions.threadId
          || activeThreadId
          || options.threadId
          || options.sessionId
          || activeSessionId,
        ...eventOptions,
      });
    },
    getState() {
      return {
        provider,
        model: activeModel,
        sessionId: activeSessionId,
        threadId: activeThreadId,
      };
    },
  };
}

export default runProviderSessionTurn;
