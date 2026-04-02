import { createProviderKernel } from "../provider-kernel.mjs";
import { createProviderSession } from "../provider-session.mjs";
import { createToolRunner } from "./tool-runner.mjs";
import { normalizeTurnResult } from "./message-normalizer.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function buildStagePrompt(stage = {}, options = {}) {
  const prompt = toTrimmedString(stage.prompt || "");
  const tools = Array.isArray(stage.tools) ? stage.tools.map((tool) => toTrimmedString(tool)).filter(Boolean) : [];
  if (!tools.length || options.includeToolManifest === false) {
    return prompt;
  }
  return [
    prompt,
    "",
    "Available stage tools:",
    ...tools.map((tool) => `- ${tool}`),
  ].join("\n");
}

export async function createTurnRunner(options = {}) {
  const toolRunner = await createToolRunner({
    toolOrchestrator: options.toolOrchestrator,
    onEvent: options.onEvent,
  });
  const providerKernel =
    options.providerKernel
    || createProviderKernel({
      providerRegistry: options.providerRegistry,
      adapters: options.adapters,
      configExecutors: options.configExecutors,
      getProviderRunner: options.getProviderRunner,
      runProviderTurn: options.runProviderTurn,
      getConfig: options.getConfig,
      config: options.config,
      env: options.env,
    });

  return {
    async runStageTurn(input = {}) {
      const stage = input.stage || {};
      const profile = input.profile || {};
      const prompt = buildStagePrompt(stage, options);
      if (typeof options.runProviderTurn === "function") {
        const providerSession = createProviderSession(
          input.provider || stage.provider || profile.provider || null,
          {
            providerRegistry: options.providerRegistry,
            adapters: options.adapters,
            configExecutors: options.configExecutors,
            runTurn: options.runProviderTurn,
            model: toTrimmedString(stage.model || input.model || profile.model || ""),
            sessionId: input.sessionId || null,
            threadId: input.threadId || null,
            toolRunner,
            sessionManager: options.sessionManager || null,
            onEvent: options.onEvent,
          },
        );
        const result = await providerSession.runTurn(prompt, {
          cwd: toTrimmedString(stage.cwd || input.cwd || profile.cwd || ""),
          model: toTrimmedString(stage.model || input.model || profile.model || ""),
          tools: toolRunner.listTools(),
          toolRunner,
          sessionManager: options.sessionManager || null,
          onEvent: options.onEvent,
          timeoutMs: input.timeoutMs || stage.timeoutMs,
          sessionType: toTrimmedString(stage.sessionType || input.sessionType || profile.sessionType || "harness"),
          taskKey: toTrimmedString(stage.taskKey || input.taskKey || profile.taskKey || profile.agentId || "harness"),
          sessionId: input.sessionId || null,
          threadId: input.threadId || null,
        });
        return {
          ...normalizeTurnResult(result),
          providerSession,
          toolRunner,
        };
      }
      const providerSession = providerKernel.createSession({
        selectionId: input.provider || stage.provider || profile.provider || null,
        provider: input.provider || stage.provider || profile.provider || null,
        adapterName: input.adapterName || null,
        taskKey: toTrimmedString(stage.taskKey || input.taskKey || profile.taskKey || profile.agentId || "harness"),
        executionMode: input.executionMode,
        sessionType: toTrimmedString(stage.sessionType || input.sessionType || profile.sessionType || "harness"),
        sessionId: input.sessionId || null,
        threadId: input.threadId || null,
        cwd: toTrimmedString(stage.cwd || input.cwd || profile.cwd || ""),
        model: toTrimmedString(stage.model || input.model || profile.model || ""),
      });
      const result = await providerSession.runTurn(prompt, {
        cwd: toTrimmedString(stage.cwd || input.cwd || profile.cwd || ""),
        model: toTrimmedString(stage.model || input.model || profile.model || ""),
        tools: toolRunner.listTools(),
        toolRunner,
        sessionManager: options.sessionManager || null,
        onEvent: options.onEvent,
        timeoutMs: input.timeoutMs || stage.timeoutMs,
        sessionType: toTrimmedString(stage.sessionType || input.sessionType || profile.sessionType || "harness"),
        taskKey: toTrimmedString(stage.taskKey || input.taskKey || profile.taskKey || profile.agentId || "harness"),
        sessionId: input.sessionId || null,
        threadId: input.threadId || null,
      });
      return {
        ...normalizeTurnResult(result),
        providerSession,
        toolRunner,
      };
    },
  };
}

export default createTurnRunner;
