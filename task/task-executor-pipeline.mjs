/**
 * @module task/task-executor-pipeline
 * @description Pipeline orchestration helpers extracted from task-executor.
 */

import { FanoutPipeline, RacePipeline, SequentialPipeline } from "./pipeline.mjs";

function toAgentList(agents) {
  if (Array.isArray(agents)) return agents.filter(Boolean);
  return [agents].filter(Boolean);
}

function normalizeMode(mode) {
  return String(mode || "single").trim().toLowerCase();
}

function isHeavyValidationAgent(agent = {}, input = {}) {
  if (agent?.heavy === true || agent?.isolated === true) return true;
  const role = String(agent?.role || agent?.name || agent?.id || "").toLowerCase();
  const command = String(agent?.command || input?.command || "").toLowerCase();
  if (/\b(validation|validate|build|test|pre-push|prepush|diff)\b/.test(role)) return true;
  return /\b(npm\s+(run\s+build|test)|pnpm\s+(build|test)|yarn\s+(build|test)|pre-push|prepush|git\s+diff)\b/.test(command);
}

function toBlockedEvidenceError(taskKey, message, details = {}) {
  const error = new Error(`Runner lease blocked evidence for ${taskKey}: ${message}`);
  error.code = "RUNNER_LEASE_BLOCKED";
  error.blockedEvidence = true;
  error.details = details;
  return error;
}

async function runHeavyValidationStage(agent, input, context, options, taskKey) {
  const acquireRunnerLease = options.acquireRunnerLease;
  const execHeavyValidation = options.execHeavyValidation;
  const releaseRunnerLease = options.releaseRunnerLease;
  if (typeof acquireRunnerLease !== "function") {
    throw toBlockedEvidenceError(taskKey, "runner lease acquisition is unavailable", { phase: "acquire" });
  }
  if (typeof execHeavyValidation !== "function") {
    throw toBlockedEvidenceError(taskKey, "isolated validation executor is unavailable", { phase: "execute" });
  }

  const maxAttempts = Math.max(1, Number(agent?.runnerRetries || options.runnerRetries || 1));
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    let lease = null;
    try {
      lease = await acquireRunnerLease({
        taskKey,
        taskId: input?.taskId || context?.options?.metadata?.taskId || null,
        purpose: String(agent?.role || agent?.id || "validation"),
        command: agent?.command || input?.command || null,
        attempt,
        repoRoot: options.repoRoot || process.cwd(),
        signal: context?.signal || null,
      });

      const result = await execHeavyValidation({
        lease,
        agent,
        input,
        context,
        taskKey,
        attempt,
        repoRoot: options.repoRoot || process.cwd(),
        timeoutMs: Number(agent?.timeoutMs || options.timeoutMs || 0) || undefined,
        signal: context?.signal || null,
      });

      if (!result?.success) {
        throw new Error(result?.error || `Isolated runner failed for ${taskKey}`);
      }

      await releaseRunnerLease?.({ ...(lease || {}), leaseId: lease?.leaseId || null, status: "completed", taskKey, attempt });

      return {
        success: true,
        output: {
          text: result.output,
          sdk: result.sdk || agent?.sdk || null,
          taskKey,
          compact: result.compact || null,
          artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
        },
        text: result.output,
        meta: {
          taskKey,
          sdk: result.sdk || agent?.sdk || null,
          executionMode: "isolated-runner",
          leaseId: lease?.leaseId || null,
          attempt,
        },
        tokensUsed: Number(result.tokensUsed || result.usage?.totalTokens || result.usage?.total_tokens || 0) || 0,
      };
    } catch (error) {
      lastError = error;
      await releaseRunnerLease?.({ ...(lease || {}), leaseId: lease?.leaseId || null, status: "failed", taskKey, attempt, error: error?.message || String(error) });
      if (attempt >= maxAttempts) break;
    }
  }

  throw toBlockedEvidenceError(taskKey, lastError?.message || "isolated runner failed", { attempts: maxAttempts, cause: lastError });
}

function buildStageRunner(agent, stageIndex, runner) {
  const id = String(agent?.id || agent?.name || `agent-${stageIndex + 1}`);
  const name = String(agent?.name || agent?.id || id);
  return {
    ...agent,
    id,
    name,
    async run(input, context) {
      return runner(agent, input, context);
    },
  };
}

export function createExecutionPipeline(mode = "single", agents = [], options = {}) {
  const list = toAgentList(agents);
  if (list.length === 0) {
    throw new Error("At least one pipeline agent is required");
  }

  const runAgent =
    typeof options.agentRunner === "function" ? options.agentRunner : null;
  if (!runAgent) {
    throw new Error("Execution pipeline requires options.agentRunner");
  }

  const normalizedMode = normalizeMode(mode);
  const stages = list.map((agent, stageIndex) =>
    buildStageRunner(agent, stageIndex, runAgent));
  const pipelineOptions = {
    id: options.id || `${options.task?.id || "task"}-${normalizedMode}`,
    name: options.name || `${normalizedMode}-execution`,
    metadata: {
      taskId: options.task?.id || null,
      mode: normalizedMode,
      source: "task-executor",
      ...(options.metadata && typeof options.metadata === "object" ? options.metadata : {}),
    },
  };

  if (["parallel", "fanout", "parallel-slots"].includes(normalizedMode)) {
    return FanoutPipeline(stages, pipelineOptions);
  }
  if (["failover", "race"].includes(normalizedMode)) {
    return RacePipeline(stages, pipelineOptions);
  }
  return SequentialPipeline(stages, pipelineOptions);
}

export async function runExecutionPipeline(mode, agents, input, options = {}) {
  const pipeline = createExecutionPipeline(mode, agents, options);
  return pipeline.run(input, {
    metadata: options.metadata || {},
    signal: options.signal || null,
  });
}

export async function runExecutionPipelineAgent(
  agent,
  input,
  context,
  options = {},
) {
  const runWithRetry = options.execWithRetry;
  if (typeof runWithRetry !== "function") {
    throw new Error("runExecutionPipelineAgent requires options.execWithRetry");
  }

  const prompt =
    typeof agent?.prompt === "string" && agent.prompt.trim()
      ? agent.prompt
      : [
          "Task execution pipeline",
          `Mode: ${context?.options?.metadata?.mode || context?.pipelineType || "sequential"}`,
          `Agent role: ${agent?.role || agent?.name || agent?.id || "agent"}`,
          "Use only the structured input below; do not rely on prior conversation state.",
          typeof input === "string" ? input : JSON.stringify(input, null, 2),
        ]
          .filter(Boolean)
          .join("\n\n");

  const stageIndex = Number.isInteger(context?.stageIndex)
    ? context.stageIndex
    : Number.isInteger(context?.agentIndex)
      ? context.agentIndex
      : 0;
  const pipelineId = String(
    context?.options?.id || context?.runId || context?.pipeline?.id || "pipeline",
  );
  const taskKey = `${pipelineId}-${agent?.id || agent?.name || "agent"}-${stageIndex + 1}`;
  const result = isHeavyValidationAgent(agent, input)
    ? await runHeavyValidationStage(agent, input, context, options, taskKey)
    : await runWithRetry(prompt, {
        taskKey,
        cwd: options.repoRoot || process.cwd(),
        timeoutMs: Number(agent?.timeoutMs || options.timeoutMs || 0) || undefined,
        maxRetries: Number(agent?.maxRetries || 1) || 1,
        sdk: agent?.sdk || agent?.executor || undefined,
        model: agent?.model || undefined,
        sessionType: "task-pipeline",
        signal: context?.signal || null,
      });

  if (!result?.success) {
    throw new Error(result?.error || `Pipeline agent ${agent?.id || "agent"} failed`);
  }

  if (result?.meta?.executionMode === "isolated-runner") {
    return result;
  }

  return {
    success: true,
    output: {
      text: result.output,
      sdk: result.sdk,
      taskKey,
    },
    text: result.output,
    meta: {
      taskKey,
      sdk: result.sdk,
    },
    tokensUsed:
      Number(result.tokensUsed || result.usage?.totalTokens || result.usage?.total_tokens || 0) ||
      0,
  };
}

export default {
  createExecutionPipeline,
  runExecutionPipeline,
  runExecutionPipelineAgent,
};

