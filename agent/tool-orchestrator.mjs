import { resolveRepoRoot } from "../config/repo-root.mjs";
import { getAgentToolConfig, getEffectiveTools, listAvailableTools } from "./agent-tool-config.mjs";
import { createToolApprovalManager } from "./tool-approval-manager.mjs";
import { evaluateToolNetworkPolicy } from "./tool-network-policy.mjs";
import { buildToolExecutionEnvelope } from "./tool-runtime-context.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { truncateToolOutput } from "./tool-output-truncation.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
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
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
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
      if (typeof options.executeTool !== "function") {
        throw new Error("Tool orchestrator executeTool hook is not configured");
      }
      const toolDefinition = registry.getTool(toolName) || { id: toTrimmedString(toolName) };
      const envelope = buildToolExecutionEnvelope(toolName, args, context, {
        cwd: toTrimmedString(options.cwd),
        agentProfileId: toTrimmedString(options.agentProfileId) || null,
      });
      const approval = approvalManager.evaluate(toolDefinition, envelope.context);
      if (approval.blocked) {
        onEvent?.({ type: "approval_requested", toolName: envelope.toolName, context: envelope.context, approval });
        throw new Error(approval.reason || `Tool ${envelope.toolName} is blocked pending approval.`);
      }
      const network = evaluateToolNetworkPolicy(toolDefinition, envelope.context, options.networkPolicy || {});
      if (network.blocked) {
        onEvent?.({ type: "tool_execution_error", toolName: envelope.toolName, args: envelope.args, context: envelope.context, error: network.reason });
        throw new Error(network.reason || `Network access is blocked for ${envelope.toolName}.`);
      }
      const eventBase = {
        toolName: envelope.toolName,
        args: envelope.args,
        context: envelope.context,
      };
      onEvent?.({ type: "tool_execution_start", ...eventBase });
      try {
        const result = await options.executeTool(toolName, args, envelope.context, toolDefinition);
        const truncated = truncateToolOutput(result, options.truncation || {});
        onEvent?.({ type: "tool_execution_end", ...eventBase, result: truncated });
        return result;
      } catch (error) {
        onEvent?.({
          type: "tool_execution_error",
          ...eventBase,
          error: String(error?.message || error),
        });
        throw error;
      }
    },
  };
  orchestrator.executeTool = orchestrator.execute;
  return orchestrator;
}

export default createToolOrchestrator;
