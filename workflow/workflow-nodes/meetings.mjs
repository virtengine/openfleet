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

registerNodeType("meeting.start", {
  describe: () => "Create or reuse a meeting session for workflow-driven voice/video orchestration",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Optional session ID (auto-generated when empty)" },
      title: { type: "string", description: "Optional human-readable session title" },
      executor: { type: "string", description: "Preferred executor for this meeting session" },
      mode: { type: "string", description: "Preferred agent mode for this meeting session" },
      model: { type: "string", description: "Preferred model override for this meeting session" },
      wakePhrase: { type: "string", description: "Optional wake phrase metadata for downstream workflow logic" },
      metadata: { type: "object", description: "Additional metadata stored with the meeting session" },
      activate: { type: "boolean", default: true, description: "Mark meeting session active after creation/reuse" },
      maxMessages: { type: "number", description: "Optional session max message retention override" },
      failOnError: { type: "boolean", default: true, description: "Throw when meeting setup fails" },
    },
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.startMeeting !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim() || undefined;
      const title = String(ctx.resolve(node.config?.title || "") || "").trim() || undefined;
      const executor = String(ctx.resolve(node.config?.executor || "") || "").trim() || undefined;
      const mode = String(ctx.resolve(node.config?.mode || "") || "").trim() || undefined;
      const model = String(ctx.resolve(node.config?.model || "") || "").trim() || undefined;
      const wakePhrase = String(ctx.resolve(node.config?.wakePhrase || "") || "").trim() || undefined;
      const metadataInput = resolveWorkflowNodeValue(node.config?.metadata || {}, ctx);
      const metadata =
        metadataInput && typeof metadataInput === "object" && !Array.isArray(metadataInput)
          ? { ...metadataInput }
          : {};
      if (title) metadata.title = title;
      if (wakePhrase) metadata.wakePhrase = wakePhrase;

      const activate = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.activate ?? true, ctx), true);
      const maxMessagesRaw = Number(resolveWorkflowNodeValue(node.config?.maxMessages, ctx));
      const maxMessages = Number.isFinite(maxMessagesRaw) && maxMessagesRaw > 0
        ? Math.trunc(maxMessagesRaw)
        : undefined;

      const result = await meeting.startMeeting({
        sessionId,
        metadata,
        agent: executor,
        mode,
        model,
        activate,
        maxMessages,
      });

      const activeSessionId = String(result?.sessionId || sessionId || "").trim() || null;
      if (activeSessionId) {
        ctx.data.meetingSessionId = activeSessionId;
        ctx.data.sessionId = ctx.data.sessionId || activeSessionId;
      }

      return {
        success: true,
        sessionId: activeSessionId,
        created: result?.created === true,
        session: result?.session || null,
        voice: result?.voice || null,
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerNodeType("meeting.send", {
  describe: () => "Send a meeting message through the meeting session dispatcher",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Meeting session ID (defaults to context session)" },
      message: { type: "string", description: "Message to send into the meeting session" },
      mode: { type: "string", description: "Optional per-message mode override" },
      model: { type: "string", description: "Optional per-message model override" },
      timeoutMs: { type: "number", description: "Optional per-message timeout in ms" },
      createIfMissing: { type: "boolean", default: true, description: "Create session automatically when missing" },
      allowInactive: { type: "boolean", default: false, description: "Allow sending when session is inactive" },
      failOnError: { type: "boolean", default: true, description: "Throw when sending fails" },
    },
    required: ["message"],
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.sendMeetingMessage !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim();
      if (!sessionId) {
        throw new Error("meeting.send requires sessionId (configure node.sessionId or run meeting.start first)");
      }
      const message = String(ctx.resolve(node.config?.message || "") || "").trim();
      if (!message) {
        throw new Error("meeting.send requires message");
      }

      const mode = String(ctx.resolve(node.config?.mode || "") || "").trim() || undefined;
      const model = String(ctx.resolve(node.config?.model || "") || "").trim() || undefined;
      const timeoutMsRaw = Number(resolveWorkflowNodeValue(node.config?.timeoutMs, ctx));
      const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? Math.trunc(timeoutMsRaw)
        : undefined;
      const createIfMissing = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.createIfMissing ?? true, ctx), true);
      const allowInactive = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.allowInactive ?? false, ctx), false);

      const result = await meeting.sendMeetingMessage(sessionId, message, {
        mode,
        model,
        timeoutMs,
        createIfMissing,
        allowInactive,
      });

      const nextSessionId = String(result?.sessionId || sessionId).trim();
      if (nextSessionId) {
        ctx.data.meetingSessionId = nextSessionId;
        ctx.data.sessionId = ctx.data.sessionId || nextSessionId;
      }

      return {
        success: result?.ok !== false,
        sessionId: nextSessionId || null,
        messageId: result?.messageId || null,
        status: result?.status || null,
        responseText: result?.responseText || "",
        adapter: result?.adapter || null,
        observedEventCount: Number(result?.observedEventCount || 0),
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerNodeType("meeting.transcript", {
  describe: () => "Fetch meeting transcript pages and optionally project as plain text",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Meeting session ID (defaults to context session)" },
      page: { type: "number", default: 1 },
      pageSize: { type: "number", default: 200 },
      includeMessages: { type: "boolean", default: true, description: "Include structured message array in output" },
      failOnError: { type: "boolean", default: true, description: "Throw when transcript retrieval fails" },
    },
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.fetchMeetingTranscript !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim();
      if (!sessionId) {
        throw new Error("meeting.transcript requires sessionId (configure node.sessionId or run meeting.start first)");
      }

      const pageRaw = Number(resolveWorkflowNodeValue(node.config?.page ?? 1, ctx));
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
      const pageSizeRaw = Number(resolveWorkflowNodeValue(node.config?.pageSize ?? 200, ctx));
      const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.trunc(pageSizeRaw) : 200;
      const includeMessages = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeMessages ?? true, ctx), true);

      const transcript = await meeting.fetchMeetingTranscript(sessionId, {
        page,
        pageSize,
      });
      const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
      const transcriptText = messages
        .map((msg) => {
          const role = String(msg?.role || msg?.type || "system").trim().toLowerCase();
          const content = String(msg?.content || "").trim();
          if (!content) return "";
          return `${role}: ${content}`;
        })
        .filter(Boolean)
        .join("\n");

      return {
        success: true,
        sessionId,
        status: transcript?.status || null,
        page: Number(transcript?.page || page),
        pageSize: Number(transcript?.pageSize || pageSize),
        totalMessages: Number(transcript?.totalMessages || messages.length),
        totalPages: Number(transcript?.totalPages || 0),
        hasNextPage: transcript?.hasNextPage === true,
        hasPreviousPage: transcript?.hasPreviousPage === true,
        transcript: transcriptText,
        messages: includeMessages ? messages : undefined,
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerNodeType("meeting.vision", {
  describe: () => "Analyze a meeting video frame and persist a vision summary",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Meeting session ID (defaults to context session)" },
      frameDataUrl: { type: "string", description: "Base64 data URL for the current frame" },
      source: { type: "string", enum: ["screen", "camera"], default: "screen" },
      prompt: { type: "string", description: "Optional per-frame vision prompt override" },
      visionModel: { type: "string", description: "Optional vision model override" },
      minIntervalMs: { type: "number", description: "Minimum analysis interval for this session" },
      forceAnalyze: { type: "boolean", default: false, description: "Bypass dedupe/throttle checks" },
      width: { type: "number", description: "Optional frame width for transcript context" },
      height: { type: "number", description: "Optional frame height for transcript context" },
      executor: { type: "string", description: "Optional executor hint for vision context" },
      mode: { type: "string", description: "Optional mode hint for vision context" },
      model: { type: "string", description: "Optional model hint for vision context" },
      failOnError: { type: "boolean", default: true, description: "Throw when vision analysis fails" },
    },
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.analyzeMeetingFrame !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim();
      if (!sessionId) {
        throw new Error("meeting.vision requires sessionId (configure node.sessionId or run meeting.start first)");
      }

      const frameDataUrl = String(
        ctx.resolve(node.config?.frameDataUrl || ctx.data?.frameDataUrl || ctx.data?.visionFrameDataUrl || ""),
      ).trim();
      if (!frameDataUrl) {
        throw new Error("meeting.vision requires frameDataUrl");
      }

      const source = String(ctx.resolve(node.config?.source || "screen") || "screen").trim() || "screen";
      const prompt = String(ctx.resolve(node.config?.prompt || "") || "").trim() || undefined;
      const visionModel = String(ctx.resolve(node.config?.visionModel || "") || "").trim() || undefined;
      const minIntervalRaw = Number(resolveWorkflowNodeValue(node.config?.minIntervalMs, ctx));
      const minIntervalMs = Number.isFinite(minIntervalRaw) && minIntervalRaw > 0
        ? Math.trunc(minIntervalRaw)
        : undefined;
      const forceAnalyze = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.forceAnalyze ?? false, ctx), false);
      const widthRaw = Number(resolveWorkflowNodeValue(node.config?.width, ctx));
      const heightRaw = Number(resolveWorkflowNodeValue(node.config?.height, ctx));
      const width = Number.isFinite(widthRaw) && widthRaw > 0 ? Math.trunc(widthRaw) : undefined;
      const height = Number.isFinite(heightRaw) && heightRaw > 0 ? Math.trunc(heightRaw) : undefined;
      const executor = String(ctx.resolve(node.config?.executor || "") || "").trim() || undefined;
      const mode = String(ctx.resolve(node.config?.mode || "") || "").trim() || undefined;
      const model = String(ctx.resolve(node.config?.model || "") || "").trim() || undefined;

      const result = await meeting.analyzeMeetingFrame(sessionId, frameDataUrl, {
        source,
        prompt,
        visionModel,
        minIntervalMs,
        forceAnalyze,
        width,
        height,
        executor,
        mode,
        model,
      });

      ctx.data.meetingSessionId = sessionId;
      if (result?.summary) {
        ctx.data.meetingVisionSummary = String(result.summary);
      }

      return {
        success: result?.ok !== false,
        sessionId: String(result?.sessionId || sessionId).trim(),
        analyzed: result?.analyzed === true,
        skipped: result?.skipped === true,
        reason: result?.reason || null,
        summary: result?.summary || "",
        provider: result?.provider || null,
        model: result?.model || null,
        frameHash: result?.frameHash || null,
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerNodeType("meeting.finalize", {
  describe: () => "Finalize a meeting session with status and optional note",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Meeting session ID (defaults to context session)" },
      status: {
        type: "string",
        enum: ["active", "paused", "completed", "archived", "failed", "cancelled"],
        default: "completed",
      },
      note: { type: "string", description: "Optional note recorded in session history" },
      failOnError: { type: "boolean", default: true, description: "Throw when finalization fails" },
    },
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.stopMeeting !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim();
      if (!sessionId) {
        throw new Error("meeting.finalize requires sessionId (configure node.sessionId or run meeting.start first)");
      }

      const status = String(
        ctx.resolve(node.config?.status || "completed") || "completed",
      ).trim().toLowerCase() || "completed";
      const note = String(ctx.resolve(node.config?.note || "") || "").trim() || undefined;

      const result = await meeting.stopMeeting(sessionId, { status, note });
      return {
        success: result?.ok !== false,
        sessionId: String(result?.sessionId || sessionId).trim(),
        status: result?.status || status,
        session: result?.session || null,
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});


