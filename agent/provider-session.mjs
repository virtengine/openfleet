import {
  execPrimaryPrompt,
  getPrimaryAgentInfo,
  initPrimaryAgent,
  steerPrimaryPrompt,
} from "./primary-agent.mjs";
import {
  execPooledPrompt,
  getThreadRecord,
  hasActiveSession,
  launchOrResumeThread,
  steerActiveThread,
} from "./agent-pool.mjs";
import { createProviderRegistry } from "./provider-registry.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizePromptResult(result = {}, meta = {}) {
  const finalResponse =
    typeof result === "string"
      ? result
      : String(result?.finalResponse || result?.output || result?.text || result?.message || "").trim();
  const items = Array.isArray(result?.items) ? result.items : [];
  const usage = result?.usage && typeof result.usage === "object" ? result.usage : null;
  return {
    ok: result?.success !== false,
    success: result?.success !== false,
    finalResponse,
    output: finalResponse,
    text: finalResponse,
    items,
    usage,
    threadId: toTrimmedString(result?.threadId || meta.threadId || ""),
    sessionId: toTrimmedString(result?.sessionId || meta.sessionId || result?.threadId || ""),
    providerId: meta.providerId || null,
    adapterId: meta.adapterId || null,
    poolSdk: meta.poolSdk || null,
    executionMode: meta.executionMode || "pooled",
    raw: result,
  };
}

function shouldUsePrimaryExecution(provider, options = {}) {
  if (options.executionMode === "primary") return true;
  if (options.forcePooled === true) return false;
  if (options.executionMode === "thread" || options.executionMode === "pooled") return false;
  return provider?.isActive === true;
}

export async function executeProviderTurn(prompt, options = {}) {
  await initPrimaryAgent();
  const registry = await createProviderRegistry({ initialize: false });
  const provider = await registry.resolveProvider(options.provider || options.providerId || options.adapterId || null);
  if (!provider) {
    throw new Error(`Unknown provider: ${options.provider || options.providerId || options.adapterId || "(default)"}`);
  }

  const executionMode = shouldUsePrimaryExecution(provider, options)
    ? "primary"
    : (options.resumeThreadId || options.taskKey || options.sessionKey ? "thread" : "pooled");
  const sessionId = toTrimmedString(options.sessionId || options.resumeThreadId || "");

  if (executionMode === "primary") {
    const result = await execPrimaryPrompt(prompt, {
      ...options,
      model: options.model || provider.models?.[0] || undefined,
      sessionId: sessionId || undefined,
    });
    return normalizePromptResult(result, {
      providerId: provider.id,
      adapterId: provider.adapterId,
      poolSdk: provider.poolSdk,
      executionMode,
      sessionId: sessionId || getPrimaryAgentInfo()?.sessionId || "",
      threadId: getPrimaryAgentInfo()?.threadId || "",
    });
  }

  if (executionMode === "thread") {
    const taskKey = toTrimmedString(options.taskKey || options.sessionKey || sessionId || `provider-session:${provider.id}`);
    const result = await launchOrResumeThread(
      prompt,
      options.cwd,
      options.timeoutMs,
      {
        ...options,
        taskKey,
        sdk: provider.poolSdk,
        model: options.model || provider.models?.[0] || undefined,
        sessionType: options.sessionType || "harness",
        resumeThreadId: options.resumeThreadId || sessionId || undefined,
      },
    );
    const record = getThreadRecord(taskKey);
    return normalizePromptResult(result, {
      providerId: provider.id,
      adapterId: provider.adapterId,
      poolSdk: provider.poolSdk,
      executionMode,
      sessionId: toTrimmedString(record?.threadId || sessionId),
      threadId: toTrimmedString(result?.threadId || record?.threadId || ""),
    });
  }

  const result = await execPooledPrompt(prompt, {
    ...options,
    sdk: provider.poolSdk,
    model: options.model || provider.models?.[0] || undefined,
    sessionType: options.sessionType || "harness",
  });
  return normalizePromptResult(result, {
    providerId: provider.id,
    adapterId: provider.adapterId,
    poolSdk: provider.poolSdk,
    executionMode,
    sessionId,
  });
}

export async function createProviderSession(providerLike, options = {}) {
  const registry = await createProviderRegistry({ initialize: options.initialize !== false });
  const provider = await registry.resolveProvider(providerLike || options.provider || null);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerLike || options.provider || "(default)"}`);
  }
  const taskKey = toTrimmedString(options.taskKey || `provider-session:${provider.id}`);
  const preferredExecutionMode = shouldUsePrimaryExecution(provider, options)
    ? "primary"
    : (options.executionMode || "thread");

  return {
    provider,
    taskKey,
    executionMode: preferredExecutionMode,
    async runTurn(prompt, turnOptions = {}) {
      return await executeProviderTurn(prompt, {
        ...options,
        ...turnOptions,
        provider,
        taskKey: toTrimmedString(turnOptions.taskKey || taskKey),
        executionMode: turnOptions.executionMode || preferredExecutionMode,
      });
    },
    steer(prompt, meta = {}) {
      const requestedMode = toTrimmedString(meta.executionMode || options.executionMode || preferredExecutionMode);
      if (requestedMode === "primary" || provider.isActive === true) {
        return steerPrimaryPrompt(prompt);
      }
      const activeKey = toTrimmedString(meta.taskKey || taskKey);
      if (!activeKey || !hasActiveSession(activeKey)) {
        return {
          ok: false,
          reason: "no_active_session",
        };
      }
      return steerActiveThread(activeKey, prompt);
    },
    getInfo() {
      const threadRecord = getThreadRecord(taskKey);
      return {
        provider,
        taskKey,
        hasActiveThread: hasActiveSession(taskKey),
        threadRecord,
        primaryInfo: provider.isActive === true ? getPrimaryAgentInfo() : null,
      };
    },
  };
}

export default createProviderSession;
