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

registerNodeType("notify.log", {
  describe: () => "Log a message (to console and workflow run log)",
  schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to log (supports {{variables}})" },
      level: { type: "string", enum: ["info", "warn", "error"], default: "info" },
    },
    required: ["message"],
  },
  async execute(node, ctx) {
    const message = ctx.resolve(node.config?.message || "");
    const level = node.config?.level || "info";
    ctx.log(node.id, message, level);
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`${TAG} ${message}`);
    return { logged: true, message };
  },
});

registerNodeType("notify.telegram", {
  describe: () => "Send a message to Telegram chat",
  schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message text (supports {{variables}} and Markdown)" },
      chatId: { type: "string", description: "Chat ID (uses default if empty)" },
      silent: { type: "boolean", default: false },
      parseMode: { type: "string", enum: ["Markdown", "MarkdownV2", "HTML"], description: "Optional Telegram parse mode" },
    },
    required: ["message"],
  },
  async execute(node, ctx, engine) {
    const message = normalizeWorkflowTelegramText(ctx.resolve(node.config?.message || ""));
    const telegram = engine.services?.telegram;
    const options = {
      silent: node.config?.silent,
      parseMode: node.config?.parseMode || undefined,
    };

    if (telegram?.sendMessage) {
      await telegram.sendMessage(
        node.config?.chatId || undefined,
        message,
        options,
      );
      return { sent: true, message };
    }
    ctx.log(node.id, "Telegram service not available", "warn");
    return { sent: false, reason: "no_telegram" };
  },
});

registerNodeType("notify.webhook_out", {
  describe: () => "Send an HTTP webhook notification",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Webhook URL" },
      method: { type: "string", default: "POST" },
      body: { type: "object", description: "Request body (supports {{variables}} in string values)" },
      headers: { type: "object" },
    },
    required: ["url"],
  },
  async execute(node, ctx) {
    const url = ctx.resolve(node.config?.url || "");
    const method = node.config?.method || "POST";
    const body = node.config?.body ? JSON.stringify(node.config.body) : undefined;

    ctx.log(node.id, `Webhook ${method} to ${url}`);
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...node.config?.headers,
        },
        body,
      });
      return { success: resp.ok, status: resp.status };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  AGENT-SPECIFIC — Specialized agent operations
// ═══════════════════════════════════════════════════════════════════════════


