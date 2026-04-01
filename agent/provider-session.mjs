import {
  buildProviderTurnPayload,
  normalizeProviderResultPayload,
} from "./provider-message-transform.mjs";

export function extractProviderResponseText(result) {
  if (typeof result === "string") return result;
  return normalizeProviderResultPayload(result).text || JSON.stringify(result);
}

function normalizeProviderResult(result) {
  const normalized = normalizeProviderResultPayload(result);
  return {
    success: result?.success !== false,
    output: normalized.text,
    status: result?.status || (result?.success === false ? "failed" : "completed"),
    outcome: result?.outcome || (result?.success === false ? "failure" : "success"),
    sessionId: normalized.sessionId,
    threadId: normalized.threadId,
    items: normalized.messages,
    usage: normalized.usage,
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

export function createProviderSession(providerId = null, options = {}) {
  const provider = providerId || options.provider || "unknown";
  const runner =
    typeof options.runTurn === "function"
      ? options.runTurn
      : async () => {
          throw new Error(`Provider session "${provider}" is not configured`);
        };
  return {
    provider,
    options: { ...options, provider },
    async runTurn(message, turnOptions = {}) {
      const payload = buildProviderTurnPayload(message, {
        providerId: provider,
        model: turnOptions.model || options.model,
      });
      const result = await runner(payload, {
        ...options,
        ...turnOptions,
        provider,
      });
      return normalizeProviderResult(result);
    },
  };
}

export default runProviderSessionTurn;
