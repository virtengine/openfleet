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

  return {
    async runStageTurn(input = {}) {
      const stage = input.stage || {};
      const profile = input.profile || {};
      const providerSession = await createProviderSession(
        input.provider || stage.provider || profile.provider || null,
        {
          initialize: false,
          provider: input.provider || stage.provider || profile.provider || null,
          taskKey: toTrimmedString(stage.taskKey || input.taskKey || profile.taskKey || profile.agentId || "harness"),
          executionMode: input.executionMode,
          sessionType: toTrimmedString(stage.sessionType || input.sessionType || profile.sessionType || "harness"),
          cwd: toTrimmedString(stage.cwd || input.cwd || profile.cwd || ""),
          model: toTrimmedString(stage.model || input.model || profile.model || ""),
        },
      );
      const prompt = buildStagePrompt(stage, options);
      const result = await providerSession.runTurn(prompt, {
        cwd: toTrimmedString(stage.cwd || input.cwd || profile.cwd || ""),
        model: toTrimmedString(stage.model || input.model || profile.model || ""),
        timeoutMs: input.timeoutMs || stage.timeoutMs,
        sessionType: toTrimmedString(stage.sessionType || input.sessionType || profile.sessionType || "harness"),
        taskKey: toTrimmedString(stage.taskKey || input.taskKey || profile.taskKey || profile.agentId || "harness"),
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
