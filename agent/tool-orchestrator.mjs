import { resolveRepoRoot } from "../config/repo-root.mjs";
import { getAgentToolConfig, getEffectiveTools, listAvailableTools } from "./agent-tool-config.mjs";
import { createToolApprovalManager } from "./tool-approval-manager.mjs";
import { evaluateToolNetworkPolicy } from "./tool-network-policy.mjs";
import { buildToolExecutionEnvelope } from "./tool-runtime-context.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { truncateToolOutput } from "./tool-output-truncation.mjs";
import { randomUUID } from "node:crypto";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function emitToolEvents(context = {}, ...hooks) {
  const listeners = [
    ...hooks,
    context?.onEvent,
  ].filter((hook) => typeof hook === "function");
  return (event) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Tool telemetry must never break execution.
      }
    }
  };
}

function buildToolError(message, detail = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(detail || {})) {
    error[key] = value;
  }
  return error;
}

function resolveRetryConfig(toolDefinition = {}, context = {}, options = {}) {
  const merged = {
    ...((options && typeof options === "object") ? options : {}),
    ...((toolDefinition?.retry && typeof toolDefinition.retry === "object") ? toolDefinition.retry : {}),
    ...((context?.retry && typeof context.retry === "object") ? context.retry : {}),
  };
  return {
    maxAttempts: normalizePositiveInteger(
      merged.maxAttempts ?? merged.attempts,
      1,
    ),
    backoffMs: Math.max(0, normalizePositiveInteger(merged.backoffMs, 0)),
  };
}

async function sleep(ms) {
  if (!(ms > 0)) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveToolRootDir(cwd = "") {
  try {
    return toTrimmedString(cwd || resolveRepoRoot() || process.cwd());
  } catch {
    return toTrimmedString(cwd || process.cwd());
  }
}

export function createToolCapabilityManifest(options = {}) {
  const rootDir = resolveToolRootDir(options.cwd);
  const agentProfileId = toTrimmedString(options.agentProfileId);
  const toolState = agentProfileId
    ? getEffectiveTools(rootDir, agentProfileId)
    : getEffectiveTools(rootDir, "__default__");
  const rawCfg = agentProfileId ? getAgentToolConfig(rootDir, agentProfileId) : null;
  const enabledBuiltinTools = (Array.isArray(toolState?.builtinTools) ? toolState.builtinTools : [])
    .filter((tool) => tool?.enabled)
    .map((tool) => ({
      id: toTrimmedString(tool?.id),
      name: toTrimmedString(tool?.name),
      description: toTrimmedString(tool?.description),
    }))
    .filter((tool) => tool.id);
  const enabledMcpServers = Array.isArray(rawCfg?.enabledMcpServers)
    ? rawCfg.enabledMcpServers.map((id) => toTrimmedString(id)).filter(Boolean)
    : [];
  return {
    agentProfileId: agentProfileId || null,
    enabledBuiltinTools,
    enabledMcpServers,
    toolBridge: {
      module: "./voice-tools.mjs",
      function: "executeToolCall(toolName, args, context)",
      quickUse: [
        "node -e \"import('../voice/voice-tools.mjs').then(async m=>{const r=await m.executeToolCall('get_workspace_context', {}, {});console.log(r?.result||r);})\"",
        "node -e \"import('../voice/voice-tools.mjs').then(async m=>{const r=await m.executeToolCall('list_tasks', {limit:10}, {});console.log(r?.result||r);})\"",
      ],
    },
  };
}

export function buildToolCapabilityContract(options = {}) {
  const manifest = createToolCapabilityManifest(options);
  return [
    "## Tool Capability Contract",
    "Use enabled tools by default. Do not claim tools are unavailable without first trying them.",
    "Enabled tools JSON:",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "When uncertain about tool inputs/outputs, call get_admin_help via executeToolCall first.",
  ].join("\n");
}

export function createToolOrchestrator(options = {}) {
  const approvalManager = createToolApprovalManager(options.approvalOptions || {});
  const registry = options.registry || createToolRegistry(options.toolSources || []);
  const orchestrator = {
    listTools(context = {}) {
      const rootDir = resolveToolRootDir(context.cwd || options.cwd);
      const agentProfileId = toTrimmedString(context.agentProfileId || options.agentProfileId);
      const configured = listAvailableTools(rootDir, agentProfileId || "__default__");
      const registryTools = registry.listTools();
      return registryTools.length > 0 ? registryTools : configured;
    },
    async execute(toolName, args = {}, context = {}) {
      const executeTool = typeof options.executeTool === "function"
        ? options.executeTool
        : (typeof registry.execute === "function"
            ? registry.execute.bind(registry)
            : null);
      if (typeof executeTool !== "function") {
        throw new Error("Tool orchestrator executeTool hook is not configured");
      }
      const toolDefinition = registry.getTool(toolName) || { id: toTrimmedString(toolName) };
      const envelope = buildToolExecutionEnvelope(toolName, args, context, {
        cwd: toTrimmedString(options.cwd),
        repoRoot: toTrimmedString(options.repoRoot),
        agentProfileId: toTrimmedString(options.agentProfileId) || null,
      });
      const executionId = toTrimmedString(envelope.context.requestId) || `tool-${randomUUID()}`;
      envelope.context.requestId = executionId;
      const emitEvent = emitToolEvents(envelope.context, options.onEvent);
      const approvalOutcome = approvalManager.request(toolDefinition, envelope.context, {
        ...options.approvalOptions,
        repoRoot: envelope.context.repoRoot || envelope.context.cwd || options.repoRoot || options.cwd,
        preview: JSON.stringify(args ?? {}),
      });
      const approval = approvalOutcome?.approval || approvalManager.evaluate(toolDefinition, envelope.context);
      if (approval.blocked) {
        emitEvent({
          type: "approval_requested",
          toolName: envelope.toolName,
          args: envelope.args,
          context: envelope.context,
          executionId,
          approval,
          request: approvalOutcome?.request || null,
        });
        throw buildToolError(
          approval.reason || `Tool ${envelope.toolName} is blocked pending approval.`,
          {
            code: "tool_approval_required",
            approval,
            request: approvalOutcome?.request || null,
            toolName: envelope.toolName,
            executionId,
          },
        );
      }
      const network = evaluateToolNetworkPolicy(toolDefinition, envelope.context, options.networkPolicy || {});
      if (network.blocked) {
        emitEvent({
          type: "tool_execution_error",
          toolName: envelope.toolName,
          args: envelope.args,
          context: envelope.context,
          executionId,
          error: network.reason,
          network,
        });
        throw buildToolError(
          network.reason || `Network access is blocked for ${envelope.toolName}.`,
          {
            code: "tool_network_blocked",
            network,
            toolName: envelope.toolName,
            executionId,
          },
        );
      }
      const retry = resolveRetryConfig(toolDefinition, envelope.context, options.retryPolicy || {});
      const eventBase = {
        toolName: envelope.toolName,
        args: envelope.args,
        context: envelope.context,
        approval,
        executionId,
        retry,
      };
      emitEvent({ type: "tool_execution_start", ...eventBase });
      let attempt = 0;
      let lastError = null;
      while (attempt < retry.maxAttempts) {
        attempt += 1;
        try {
          const result = await executeTool(toolName, args, envelope.context, toolDefinition);
          const truncated = truncateToolOutput(result, options.truncation || {});
          emitEvent({
            type: "tool_execution_end",
            ...eventBase,
            attempt,
            attemptCount: attempt,
            result: truncated,
            truncation: {
              truncated: truncated.truncated,
              originalBytes: truncated.originalBytes,
              retainedBytes: truncated.retainedBytes,
            },
          });
          return result;
        } catch (error) {
          lastError = error;
          const errorMessage = String(error?.message || error);
          if (attempt < retry.maxAttempts) {
            emitEvent({
              type: "tool_execution_retry",
              ...eventBase,
              attempt,
              nextAttempt: attempt + 1,
              error: errorMessage,
            });
            await sleep(retry.backoffMs);
            continue;
          }
          emitEvent({
            type: "tool_execution_error",
            ...eventBase,
            attempt,
            attemptCount: attempt,
            error: errorMessage,
          });
          throw error;
        }
      }
      throw lastError || new Error(`Tool ${envelope.toolName} failed.`);
    },
  };
  orchestrator.executeTool = orchestrator.execute;
  return orchestrator;
}

export default createToolOrchestrator;
