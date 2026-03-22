/**
 * workflow-nodes.mjs — Built-in Workflow Node Types for Bosun
 *
 * Registers all standard node types that can be used in workflow definitions.
 * Node types are organized by category:
 *
 *   TRIGGERS    — Events that start workflow execution
 *   CONDITIONS  — Branching logic / gates
 *   ACTIONS     — Side-effect operations (run agent, create task, etc.)
 *   VALIDATION  — Verification gates (screenshots, tests, model review)
 *   TRANSFORM   — Data transformation / aggregation
 *   NOTIFY      — Notifications (telegram, log, etc.)
 *
 * Each node type must export:
 *   execute(node, ctx, engine) → Promise<any>   — The node's logic
 *   describe() → string                         — Human-readable description
 *   schema → object                             — JSON Schema for node config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getAgentToolConfig, getEffectiveTools } from "../../agent/agent-tool-config.mjs";
import { getToolsPromptBlock } from "../../agent/agent-custom-tools.mjs";
import { buildRelevantSkillsPromptBlock, findRelevantSkills } from "../../agent/bosun-skills.mjs";
import { getSessionTracker } from "../../infra/session-tracker.mjs";
import { fixGitConfigCorruption } from "../../workspace/worktree-manager.mjs";

import {
  registerNodeType,
  BOSUN_ATTACHED_PR_LABEL,
  PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND,
  PORTABLE_WORKTREE_COUNT_COMMAND,
  TAG,
  WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT,
  WORKFLOW_AGENT_HEARTBEAT_MS,
  WORKFLOW_TELEGRAM_ICON_MAP,
  bindTaskContext,
  buildAgentEventPreview,
  buildAgentExecutionDigest,
  buildGitExecutionEnv,
  buildTaskContextBlock,
  buildWorkflowAgentToolContract,
  collectWakePhraseCandidates,
  condenseAgentItems,
  createKanbanTaskWithProject,
  decodeWorkflowUnicodeIconToken,
  deriveManagedWorktreeDirName,
  detectWakePhraseMatch,
  execGitArgsSync,
  extractStreamText,
  extractSymbolHint,
  formatAttachmentLine,
  formatCommentLine,
  getPathValue,
  isBosunStateComment,
  isManagedBosunWorktree,
  makeIsolatedGitEnv,
  normalizeLegacyWorkflowCommand,
  normalizeLineEndings,
  normalizeNarrativeText,
  normalizeTaskAttachments,
  normalizeTaskComments,
  normalizeWorkflowStack,
  normalizeWorkflowTelegramText,
  parseBooleanSetting,
  parsePathListingLine,
  resolveGitCandidates,
  resolveWorkflowNodeValue,
  simplifyPathLabel,
  summarizeAgentStreamEvent,
  summarizeAssistantMessageData,
  summarizeAssistantUsage,
  summarizePathListingBlock,
  trimLogText,
} from "./definitions.mjs";

registerNodeType("flow.gate", {
  describe: () => "Pause workflow execution until a condition is met or manual approval is given",
  schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["manual", "condition", "timeout"],
        default: "condition",
        description: "Gate mode: manual (requires approval), condition (auto-check expression), timeout (wait then proceed)",
      },
      condition: { type: "string", description: "JS expression that must return true to open gate (condition mode)" },
      timeoutMs: { type: "number", default: 300000, description: "Max wait time before gate auto-opens or fails (ms)" },
      onTimeout: { type: "string", enum: ["proceed", "fail"], default: "proceed", description: "Action when timeout is reached" },
      pollIntervalMs: { type: "number", default: 5000, description: "How often to re-evaluate the condition (ms)" },
      reason: { type: "string", description: "Human-readable description of what this gate is waiting for" },
    },
  },
  async execute(node, ctx, engine) {
    const mode = node.config?.mode || "condition";
    const timeoutMs = node.config?.timeoutMs || 300000;
    const onTimeout = node.config?.onTimeout || "proceed";
    const reason = ctx.resolve(node.config?.reason || "Waiting at gate");
    const pollInterval = node.config?.pollIntervalMs || 5000;

    ctx.log(node.id, `Gate (${mode}): ${reason}`);
    ctx.setNodeStatus?.(node.id, "waiting");
    engine?.emit?.("node:waiting", { nodeId: node.id, mode, reason });

    if (mode === "timeout") {
      // Simple wait
      await new Promise((r) => setTimeout(r, timeoutMs));
      return { gateOpened: true, mode, waited: timeoutMs, reason };
    }

    if (mode === "condition" && node.config?.condition) {
      // Poll-based condition check
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const fn = new Function("$data", "$ctx", `return (${node.config.condition});`);
          if (fn(ctx.data, ctx)) {
            const waited = Date.now() - start;
            return { gateOpened: true, mode, waited, reason };
          }
        } catch { /* condition eval failed, keep waiting */ }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      // Timeout reached
      if (onTimeout === "fail") {
        throw new Error(`Gate timed out after ${timeoutMs}ms: ${reason}`);
      }
      return { gateOpened: true, mode, timedOut: true, waited: timeoutMs, reason };
    }

    // Manual mode or fallback: wait for external approval via context variable
    const approvalKey = `_gate_${node.id}_approved`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (ctx.data[approvalKey] || ctx.variables[approvalKey]) {
        return { gateOpened: true, mode: "manual", waited: Date.now() - start, reason };
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    if (onTimeout === "fail") {
      throw new Error(`Manual gate timed out after ${timeoutMs}ms: ${reason}`);
    }
    return { gateOpened: true, mode: "manual", timedOut: true, waited: timeoutMs, reason };
  },
});

registerNodeType("flow.join", {
  describe: () => "Explicitly join multiple branches before continuing",
  schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["all", "any", "quorum"],
        default: "all",
        description: "Join condition. 'all' waits for all listed sources, 'any' waits for one, 'quorum' waits for N",
      },
      sourceNodeIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit source node IDs to evaluate at join time",
      },
      quorum: {
        type: "number",
        description: "Required count when mode='quorum'",
      },
      includeSkipped: {
        type: "boolean",
        default: true,
        description: "Whether skipped sources count as arrived",
      },
      failOnUnmet: {
        type: "boolean",
        default: false,
        description: "Throw when join criteria are not met",
      },
    },
  },
  async execute(node, ctx) {
    const mode = String(ctx.resolve(node.config?.mode || "all") || "all").toLowerCase();
    const includeSkipped = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.includeSkipped ?? true, ctx),
      true,
    );
    const failOnUnmet = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.failOnUnmet ?? false, ctx),
      false,
    );

    const configuredSourceIds = Array.isArray(node.config?.sourceNodeIds)
      ? node.config.sourceNodeIds
      : [];
    const sourceNodeIds = configuredSourceIds
      .map((value) => String(resolveWorkflowNodeValue(value, ctx) || "").trim())
      .filter(Boolean);

    const statuses = sourceNodeIds.map((sourceNodeId) => {
      const status = typeof ctx.getNodeStatus === "function"
        ? String(ctx.getNodeStatus(sourceNodeId) || "pending").toLowerCase()
        : "pending";
      return { sourceNodeId, status };
    });

    const arrivedStates = includeSkipped
      ? new Set(["completed", "failed", "skipped"])
      : new Set(["completed", "failed"]);
    const arrived = statuses.filter((entry) => arrivedStates.has(entry.status));
    const pendingSources = statuses
      .filter((entry) => !arrivedStates.has(entry.status))
      .map((entry) => entry.sourceNodeId);

    const resolvedQuorumRaw = Number(ctx.resolve(node.config?.quorum ?? 0));
    const resolvedQuorum = Number.isFinite(resolvedQuorumRaw)
      ? Math.max(1, Math.trunc(resolvedQuorumRaw))
      : Math.max(1, sourceNodeIds.length || 1);

    let joined = true;
    if (sourceNodeIds.length > 0) {
      if (mode === "any") {
        joined = arrived.length > 0;
      } else if (mode === "quorum") {
        joined = arrived.length >= Math.min(resolvedQuorum, sourceNodeIds.length);
      } else {
        joined = pendingSources.length === 0;
      }
    }

    if (!joined && failOnUnmet) {
      throw new Error(
        `Join criteria not met for node ${node.id}: mode=${mode}, pending=${pendingSources.join(",") || "none"}`,
      );
    }

    return {
      joined,
      mode,
      sourceCount: sourceNodeIds.length,
      arrivedCount: arrived.length,
      pendingSources,
      quorum: mode === "quorum" ? resolvedQuorum : undefined,
      includeSkipped,
    };
  },
});

registerNodeType("flow.end", {
  describe: () => "End the workflow immediately with explicit terminal status",
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["completed", "failed"],
        default: "completed",
      },
      message: { type: "string", description: "Terminal reason or summary" },
      output: {
        description: "Optional structured output persisted on workflow terminal metadata",
      },
    },
  },
  async execute(node, ctx) {
    const rawStatus = String(ctx.resolve(node.config?.status || "completed") || "completed")
      .trim()
      .toLowerCase();
    const status = rawStatus === "failed" ? "failed" : "completed";
    const message = String(ctx.resolve(node.config?.message || "") || "").trim();
    const output = resolveWorkflowNodeValue(node.config?.output, ctx);

    if (message) {
      const level = status === "failed" ? "warn" : "info";
      ctx.log(node.id, `Workflow end requested (${status}): ${message}`, level);
    }

    return {
      _workflowEnd: true,
      status,
      message,
      output,
      nodeId: node.id,
      timestamp: Date.now(),
    };
  },
});

const UNIVERSAL_FLOW_NODE = {
  describe: () => "Run a universal reusable subworkflow (alias of execute-workflow pattern)",
  schema: {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "Shared subworkflow to run" },
      mode: { type: "string", enum: ["sync", "dispatch"], default: "sync" },
      input: { type: "object", additionalProperties: true },
      inheritContext: { type: "boolean", default: true },
      outputVariable: { type: "string" },
      allowRecursive: { type: "boolean", default: false },
    },
    required: ["workflowId"],
  },
  async execute(node, ctx, engine) {
    const workflowId = String(ctx.resolve(node.config?.workflowId || "") || "").trim();
    const mode = String(ctx.resolve(node.config?.mode || "sync") || "sync")
      .trim()
      .toLowerCase();
    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    const inheritContext = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.inheritContext ?? true, ctx),
      true,
    );
    const allowRecursive = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.allowRecursive ?? false, ctx),
      false,
    );

    if (!workflowId) {
      throw new Error("flow.universal: 'workflowId' is required");
    }
    if (!engine || typeof engine.execute !== "function") {
      throw new Error("flow.universal: workflow engine is not available");
    }
    if (mode !== "sync" && mode !== "dispatch") {
      throw new Error(`flow.universal: invalid mode \"${mode}\"`);
    }

    const resolvedInputConfig = resolveWorkflowNodeValue(node.config?.input ?? {}, ctx);
    if (
      resolvedInputConfig != null &&
      (typeof resolvedInputConfig !== "object" || Array.isArray(resolvedInputConfig))
    ) {
      throw new Error("flow.universal: 'input' must resolve to an object");
    }
    const configuredInput = resolvedInputConfig && typeof resolvedInputConfig === "object"
      ? resolvedInputConfig
      : {};

    const sourceData = ctx.data && typeof ctx.data === "object" ? ctx.data : {};
    const inheritedInput = inheritContext ? { ...sourceData } : {};

    const parentWorkflowId = String(ctx.data?._workflowId || "").trim();
    const workflowStack = normalizeWorkflowStack(ctx.data?._workflowStack);
    if (parentWorkflowId && workflowStack[workflowStack.length - 1] !== parentWorkflowId) {
      workflowStack.push(parentWorkflowId);
    }
    if (!allowRecursive && workflowStack.includes(workflowId)) {
      const cyclePath = [...workflowStack, workflowId].join(" -> ");
      throw new Error(
        `flow.universal: recursive workflow call blocked (${cyclePath}). Set allowRecursive=true to override.`,
      );
    }

    const childInput = {
      ...inheritedInput,
      ...configuredInput,
      _workflowStack: [...workflowStack, workflowId],
    };

    if (mode === "dispatch") {
      ctx.log(node.id, `Dispatching universal workflow \"${workflowId}\"`);
      let dispatched;
      try {
        dispatched = Promise.resolve(engine.execute(workflowId, childInput));
      } catch (err) {
        dispatched = Promise.reject(err);
      }
      dispatched
        .then((childCtx) => {
          const status = childCtx?.errors?.length ? "failed" : "completed";
          ctx.log(node.id, `Dispatched universal workflow \"${workflowId}\" finished with status=${status}`);
        })
        .catch((err) => {
          ctx.log(node.id, `Dispatched universal workflow \"${workflowId}\" failed: ${err.message}`, "error");
        });

      const output = {
        success: true,
        queued: true,
        mode: "dispatch",
        workflowId,
        parentRunId: ctx.id,
      };
      if (outputVariable) ctx.data[outputVariable] = output;
      return output;
    }

    ctx.log(node.id, `Executing universal workflow \"${workflowId}\" (sync)`);
    const childCtx = await engine.execute(workflowId, childInput);
    const errorCount = Array.isArray(childCtx?.errors) ? childCtx.errors.length : 0;
    const output = {
      success: errorCount === 0,
      queued: false,
      mode: "sync",
      workflowId,
      runId: childCtx?.id || null,
      status: errorCount > 0 ? "failed" : "completed",
      errorCount,
    };
    if (outputVariable) ctx.data[outputVariable] = output;
    return output;
  },
};

registerNodeType("flow.universal", UNIVERSAL_FLOW_NODE);

registerNodeType("flow.universial", UNIVERSAL_FLOW_NODE);

// ═══════════════════════════════════════════════════════════════════════════
//  LOOP / ITERATION
// ═══════════════════════════════════════════════════════════════════════════

