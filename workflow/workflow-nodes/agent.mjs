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
import { buildRepoTopologyContext, hasRepoMapContext } from "../../lib/repo-map.mjs";

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

registerNodeType("agent.select_profile", {
  describe: () => "Select an agent profile based on task characteristics",
  schema: {
    type: "object",
    properties: {
      profiles: {
        type: "object",
        description: "Map of profile name → matching criteria",
        additionalProperties: {
          type: "object",
          properties: {
            titlePatterns: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            filePatterns: { type: "array", items: { type: "string" } },
          },
        },
      },
      default: { type: "string", default: "general", description: "Default profile if no match" },
    },
  },
  async execute(node, ctx) {
    const profiles = node.config?.profiles || {};
    const taskTitle = (ctx.data?.taskTitle || "").toLowerCase();
    const taskTags = (ctx.data?.taskTags || []).map((t) => t.toLowerCase());

    for (const [profileName, criteria] of Object.entries(profiles)) {
      // Check title patterns
      if (criteria.titlePatterns) {
        for (const pattern of criteria.titlePatterns) {
          if (new RegExp(pattern, "i").test(taskTitle)) {
            ctx.log(node.id, `Matched profile "${profileName}" via title pattern`);
            return { profile: profileName, matchedBy: "title" };
          }
        }
      }
      // Check tags
      if (criteria.tags) {
        for (const tag of criteria.tags) {
          if (taskTags.includes(tag.toLowerCase())) {
            ctx.log(node.id, `Matched profile "${profileName}" via tag`);
            return { profile: profileName, matchedBy: "tag" };
          }
        }
      }
    }

    const defaultProfile = node.config?.default || "general";
    ctx.log(node.id, `No profile matched, using default: ${defaultProfile}`);
    return { profile: defaultProfile, matchedBy: "default" };
  },
});

function parsePlannerJsonFromText(value) {
  const text = normalizeLineEndings(String(value || ""))
    .replace(/\u001b\[[0-9;]*m/g, "")
    // Strip common agent prefixes: "Agent: ", "Assistant: ", etc.
    .replace(/^\s*(?:Agent|Assistant|Planner|Output)\s*:\s*/i, "")
    .trim();
  if (!text) return null;

  const candidates = [];
  // Match fenced blocks (```json ... ``` or ``` ... ```)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = String(match[1] || "").trim();
    if (body) candidates.push(body);
  }
  // Also try stripped text without fences as raw JSON
  const strippedText = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  if (strippedText && !candidates.includes(strippedText)) {
    candidates.push(strippedText);
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try extracting a balanced object from prose-wrapped output.
    }

    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const jsonSlice = candidate.slice(start, i + 1);
          try {
            const parsed = JSON.parse(jsonSlice);
            if (parsed && typeof parsed === "object") return parsed;
          } catch {
            // Keep scanning.
          }
        }
      }
    }
  }

  return null;
}

const PLANNER_SCORE_MAX = 10;
const PLANNER_RISK_LEVELS = ["low", "medium", "high", "critical"];
export const PLANNER_RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
export const CALIBRATED_MIN_IMPACT_SCORE = 7;
export const CALIBRATED_MAX_RISK_WITHOUT_HUMAN = "medium";
const PLANNER_SCORE_MODE_RATIO = "ratio";
const PLANNER_SCORE_MODE_TEN = "ten";

function parsePlannerNumericScore(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? { numeric: value, scale: null } : null;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;

  const ratioMatch = raw.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(1|10|100)$/);
  if (ratioMatch) {
    const numeric = Number(ratioMatch[1]);
    const denom = Number(ratioMatch[2]);
    if (!Number.isFinite(numeric) || !Number.isFinite(denom) || denom <= 0) return null;
    return { numeric, scale: denom };
  }

  const percentMatch = raw.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (percentMatch) {
    const numeric = Number(percentMatch[1]);
    if (!Number.isFinite(numeric)) return null;
    return { numeric, scale: 100 };
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return { numeric, scale: null };
}

export function normalizePlannerScore(value, { preferTenScaleIntegers = false, preserveFractionalTenScale = false } = {}) {
  const parsed = parsePlannerNumericScore(value);
  if (!parsed) return null;

  let scaled = parsed.numeric;
  if (parsed.scale === 1) {
    scaled = parsed.numeric * PLANNER_SCORE_MAX;
  } else if (parsed.scale === 100) {
    scaled = parsed.numeric / 10;
  } else if (parsed.scale === 10) {
    scaled = parsed.numeric;
  } else if (scaled > 10 && scaled <= 100) {
    scaled = scaled / 10;
  } else if (scaled > 0 && scaled < 1) {
    const hasFractionalPart = Math.abs((scaled % 1)) > Number.EPSILON;
    if (!(preserveFractionalTenScale && hasFractionalPart)) {
      scaled = scaled * PLANNER_SCORE_MAX;
    }
  } else if (scaled === 1) {
    scaled = preferTenScaleIntegers ? 1 : PLANNER_SCORE_MAX;
  }

  const clamped = Math.max(0, Math.min(PLANNER_SCORE_MAX, scaled));
  return Math.round(clamped * 10) / 10;
}

function inferPlannerTaskScoreMode(task) {
  if (!task || typeof task !== "object") return PLANNER_SCORE_MODE_RATIO;
  const candidates = [task.impact, task.confidence, task.risk];
  for (const candidate of candidates) {
    const parsed = parsePlannerNumericScore(candidate);
    if (!parsed) continue;
    if (parsed.scale === 10) return PLANNER_SCORE_MODE_TEN;
    if (parsed.scale === 1 || parsed.scale === 100) return PLANNER_SCORE_MODE_RATIO;
    if (parsed.numeric > 1 && parsed.numeric <= PLANNER_SCORE_MAX) return PLANNER_SCORE_MODE_TEN;
    if (parsed.numeric > PLANNER_SCORE_MAX && parsed.numeric <= 100) return PLANNER_SCORE_MODE_RATIO;
  }
  return PLANNER_SCORE_MODE_RATIO;
}

export function normalizePlannerRiskLevel(value, { preferTenScaleIntegers = false, preserveFractionalTenScale = false } = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (PLANNER_RISK_LEVELS.includes(raw)) return raw;

  if (raw) {
    if (/\b(critical|catastrophic|severe|blocker|sev[\s-]*0|sev[\s-]*1|data\s+loss|outage|downtime|rce)\b/.test(raw)) return "critical";
    if (/\b(high|significant|major|risky|dangerous|blast\s+radius|customer[\s-]*impact|security|compliance|incident|breaking\s+change|migration\s+risk)\b/.test(raw)) return "high";
    if (/\b(medium|moderate)\b/.test(raw)) return "medium";
    if (/\b(low|minor|trivial|safe)\b/.test(raw)) return "low";
  }

  const numeric = normalizePlannerScore(value, { preferTenScaleIntegers, preserveFractionalTenScale });
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 9) return "critical";
  if (numeric >= 7) return "high";
  if (numeric >= 4) return "medium";
  return "low";
}

export function normalizePlannerTaskForCreation(task, index) {
  if (!task || typeof task !== "object") return null;
  const title = String(task.title || "").trim();
  if (!title) return null;

  const normalizeStringList = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  };
  const normalizeRepoAreas = (value) => {
    const list = normalizeStringList(value);
    if (!list.length) return [];
    const dedup = new Set();
    const normalized = [];
    for (const area of list) {
      const key = area.toLowerCase();
      if (dedup.has(key)) continue;
      dedup.add(key);
      normalized.push(area);
    }
    return normalized;
  };
  const scoreMode = inferPlannerTaskScoreMode(task);
  const preferTenScaleIntegers = scoreMode === PLANNER_SCORE_MODE_TEN;

  const lines = [];
  const description = String(task.description || "").trim();
  if (description) lines.push(description);
  const acceptanceCriteria = normalizeStringList(task.acceptance_criteria);
  const verification = normalizeStringList(task.verification);
  const repoAreas = normalizeRepoAreas(task.repo_areas || task.repoAreas);
  const impact = normalizePlannerScore(task.impact, { preferTenScaleIntegers });
  const confidence = normalizePlannerScore(task.confidence, { preferTenScaleIntegers });
  const risk = normalizePlannerRiskLevel(task.risk, {
    preferTenScaleIntegers,
    preserveFractionalTenScale: scoreMode === PLANNER_SCORE_MODE_TEN,
  });
  const estimatedEffort = String(task.estimated_effort || task.estimatedEffort || "").trim().toLowerCase();
  const whyNow = String(task.why_now || task.whyNow || "").trim();
  const killCriteria = normalizeStringList(task.kill_criteria || task.killCriteria);

  const appendList = (heading, values) => {
    if (!Array.isArray(values) || values.length === 0) return;
    const items = values
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!items.length) return;
    lines.push("", `## ${heading}`);
    for (const item of items) lines.push(`- ${item}`);
  };

  appendList("Implementation Steps", task.implementation_steps);
  appendList("Acceptance Criteria", acceptanceCriteria);
  appendList("Verification", verification);

  const baseBranch = String(task.base_branch || "").trim();
  const workspace = String(task.workspace || "").trim();
  const repository = String(task.repository || task.repo || "").trim();
  const repositories = Array.isArray(task.repositories)
    ? task.repositories.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const priority = String(task.priority || "").trim().toLowerCase();
  const tags = Array.isArray(task.tags || task.labels)
    ? (task.tags || task.labels)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
    : [];
  const requestedStatus = String(task.status || "").trim().toLowerCase();
  const draft = Boolean(task.draft || requestedStatus === "draft");
  if (baseBranch) {
    lines.push("", `Base branch: \`${baseBranch}\``);
  }

  return {
    title,
    description: lines.join("\n").trim(),
    index,
    baseBranch: baseBranch || null,
    workspace: workspace || null,
    repository: repository || null,
    repositories,
    priority: ["low", "medium", "high", "critical"].includes(priority) ? priority : null,
    tags,
    draft,
    requestedStatus: requestedStatus || null,
    acceptanceCriteria,
    verification,
    repoAreas,
    impact,
    confidence,
    risk,
    estimatedEffort: estimatedEffort || null,
    whyNow: whyNow || null,
    killCriteria: killCriteria.length > 0 ? killCriteria : null,
  };
}
export function extractPlannerTasksFromWorkflowOutput(output, maxTasks = 5) {
  const parsed = parsePlannerJsonFromText(output);
  if (!parsed || !Array.isArray(parsed.tasks)) return [];

  const max = Number.isFinite(Number(maxTasks))
    ? Math.max(1, Math.min(100, Math.trunc(Number(maxTasks))))
    : 5;
  const dedup = new Set();
  const tasks = [];
  for (let i = 0; i < parsed.tasks.length && tasks.length < max; i += 1) {
    const normalized = normalizePlannerTaskForCreation(parsed.tasks[i], i);
    if (!normalized) continue;
    const key = normalized.title.toLowerCase();
    if (dedup.has(key)) continue;
    dedup.add(key);
    tasks.push(normalized);
  }
  return tasks;
}

export function resolvePlannerMaterializationDefaults(ctx) {
  const data =
    ctx?.data && typeof ctx.data === "object" && !Array.isArray(ctx.data)
      ? ctx.data
      : {};
  const dataMeta =
    data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
      ? data.meta
      : {};
  const workspace = String(
    data.workspace ||
      data.workspaceId ||
      data._workspace ||
      data._workspaceId ||
      dataMeta.workspace ||
      process.env.BOSUN_WORKSPACE ||
      "",
  ).trim();
  const repository = String(
    data.repository ||
      data.repo ||
      data._targetRepo ||
      dataMeta.repository ||
      process.env.GITHUB_REPOSITORY ||
      "",
  ).trim();
  return {
    workspace,
    repository,
  };
}

export function normalizePlannerAreaKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function resolveTaskRepoAreas(task) {
  const candidates = []
    .concat(Array.isArray(task?.repo_areas) ? task.repo_areas : [])
    .concat(Array.isArray(task?.repoAreas) ? task.repoAreas : [])
    .concat(Array.isArray(task?.meta?.repo_areas) ? task.meta.repo_areas : [])
    .concat(Array.isArray(task?.meta?.repoAreas) ? task.meta.repoAreas : [])
    .concat(Array.isArray(task?.meta?.planner?.repo_areas) ? task.meta.planner.repo_areas : [])
    .concat(Array.isArray(task?.meta?.planner?.repoAreas) ? task.meta.planner.repoAreas : []);
  if (!candidates.length) return [];
  const dedup = new Set();
  const normalized = [];
  for (const entry of candidates) {
    const area = String(entry || "").trim();
    if (!area) continue;
    const key = normalizePlannerAreaKey(area);
    if (!key || dedup.has(key)) continue;
    dedup.add(key);
    normalized.push(area);
  }
  return normalized;
}

function resolvePlannerFeedbackContext(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2).trim();
    } catch {
      return "";
    }
  }
  return String(value).trim();
}

export function buildPlannerSkipReasonHistogram(skipped = []) {
  const histogram = {};
  for (const entry of skipped) {
    const reason = String(entry?.reason || "unknown");
    histogram[reason] = (histogram[reason] || 0) + 1;
  }
  return histogram;
}

registerNodeType("agent.run_planner", {
  describe: () => "Run the task planner agent to generate new backlog tasks",
  schema: {
    type: "object",
    properties: {
      taskCount: { type: "number", default: 5, description: "Number of tasks to generate" },
      context: { type: "string", description: "Additional context for the planner" },
      prompt: { type: "string", description: "Optional explicit planner prompt override" },
      outputVariable: { type: "string", description: "Optional context key to store planner output text" },
      repoMap: { type: "object", description: "Optional explicit repo map context" },
      repoMapQuery: { type: "string", description: "Optional query used to select a compact repo topology" },
      repoMapFileLimit: { type: "number", default: 8, description: "Maximum repo-map files to include" },
      projectId: { type: "string" },
      dedup: { type: "boolean", default: true },
      timeoutMs: { type: "number", default: 960000, description: "Node timeout in ms (recommended >= agentTimeoutMs)" },
      agentTimeoutMs: { type: "number", default: 900000, description: "Planner agent execution timeout in ms" },
      maxRetries: { type: "number", default: 0, description: "Retry attempts for planner node" },
      retryable: { type: "boolean", default: false, description: "Whether planner node should auto-retry on failure" },
      maxRetainedEvents: { type: "number", default: WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT, description: "Maximum planner events retained in run output" },
    },
  },
  async execute(node, ctx, engine) {
    const count = Number(ctx.resolve(node.config?.taskCount || 5)) || 5;
    const context = ctx.resolve(node.config?.context || "");
    const plannerFeedback = resolvePlannerFeedbackContext(ctx.data?._plannerFeedback);
    const explicitPrompt = ctx.resolve(node.config?.prompt || "");
    const outputVariable = ctx.resolve(node.config?.outputVariable || "");
    const repoMapQuery = ctx.resolve(node.config?.repoMapQuery || "");
    const configuredNodeTimeout = Number(ctx.resolve(node.config?.timeoutMs || node.config?.timeout || 0));
    const configuredAgentTimeout = Number(ctx.resolve(node.config?.agentTimeoutMs || 0));

    let agentTimeoutMs = Number.isFinite(configuredAgentTimeout) && configuredAgentTimeout > 0
      ? Math.max(10000, Math.trunc(configuredAgentTimeout))
      : 9 * 60 * 1000;
    if (!(Number.isFinite(configuredAgentTimeout) && configuredAgentTimeout > 0) && Number.isFinite(configuredNodeTimeout) && configuredNodeTimeout > 15000) {
      agentTimeoutMs = Math.max(10000, Math.trunc(configuredNodeTimeout) - 5000);
    }

    ctx.log(node.id, `Running planner for ${count} tasks`);

    // This delegates to the existing planner prompt flow
    const agentPool = engine.services?.agentPool;
    const plannerPrompt = engine.services?.prompts?.planner;
    const basePrompt = explicitPrompt || plannerPrompt || "";
    const promptHasRepoMap = hasRepoMapContext(basePrompt);
    const resolvedRepoMapFileLimit = ctx.resolve(node.config?.repoMapFileLimit ?? null);
    const repoMapFileLimit =
      resolvedRepoMapFileLimit == null || resolvedRepoMapFileLimit === ""
        ? 8
        : (Number(resolvedRepoMapFileLimit) || 8);
    const repoTopologyContext = (node.config?.repoMap || repoMapQuery)
      && !promptHasRepoMap
      ? buildRepoTopologyContext({
        repoMap: node.config?.repoMap || ctx.data?.repoMap || null,
        repoMapFileLimit,
    const repoTopologyContext = (node.config?.repoMap || repoMapQuery)
      && !promptHasRepoMap
      ? buildRepoTopologyContext({
        repoMap: node.config?.repoMap || ctx.data?.repoMap || null,
        repoMapFileLimit,
    const repoTopologyContext = (node.config?.repoMap || repoMapQuery)
      && !promptHasRepoMap
      ? buildRepoTopologyContext({
        repoMap: node.config?.repoMap || ctx.data?.repoMap || null,
        repoMapFileLimit,
        repoMapQuery,
        query: [context, explicitPrompt, plannerPrompt].filter(Boolean).join(" "),
        prompt: explicitPrompt || plannerPrompt || "",
        userMessage: context,
        taskTitle: ctx.data?.taskTitle || ctx.data?.task?.title || "",
        taskDescription:
          ctx.data?.taskDescription ||
          ctx.data?.task?.description ||
          ctx.data?.task?.body ||
          ctx.data?.taskDetail?.description ||
          ctx.data?.taskInfo?.description ||
          "",
        changedFiles:
          (Array.isArray(ctx.data?.changedFiles) ? ctx.data.changedFiles : null) ||
          (Array.isArray(ctx.data?.task?.changedFiles) ? ctx.data.task.changedFiles : null) ||
          [],
        cwd: process.cwd(),
        repoRoot: ctx.data?.repoRoot || process.cwd(),
      })
      : "";
    // Enforce strict output instructions to ensure the downstream materialize node
    // can parse the planner output. The planner prompt already defines the contract,
    // but we reinforce it here to prevent agents from wrapping output in prose.
    const outputEnforcement =
      `\n\n## CRITICAL OUTPUT REQUIREMENT\n` +
      `Generate exactly ${count} new tasks.\n` +
      ((context || plannerFeedback || repoTopologyContext)
        ? `${[
          context,
          plannerFeedback ? `Planner feedback context:\n${plannerFeedback}` : "",
          repoTopologyContext,
        ].filter(Boolean).join("\n\n")}\n\n`
        : "\n") +
      `Your response MUST be a single fenced JSON block with shape { "tasks": [...] }.\n` +
      `Do NOT include status updates, analysis notes, tool commentary, questions, or prose outside the JSON block.\n` +
      `Do NOT reference or use legacy ve-kanban integration commands or scripts.\n` +
      `The downstream system will parse your output as JSON — any extra text will cause task creation to fail.`;
    const promptText = basePrompt
      ? `${basePrompt}${outputEnforcement}`
      : "";

    if (agentPool?.launchEphemeralThread && promptText) {
      let streamEventCount = 0;
      let lastStreamLog = "";
      const streamLines = [];
      const startedAt = Date.now();
      const maxRetainedEvents = Number.isFinite(Number(node.config?.maxRetainedEvents))
        ? Math.max(10, Math.min(500, Math.trunc(Number(node.config.maxRetainedEvents))))
        : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
      const launchExtra = {
        onEvent: (event) => {
          try {
            const line = summarizeAgentStreamEvent(event);
            if (!line || line === lastStreamLog) return;
            lastStreamLog = line;
            streamEventCount += 1;
            if (streamLines.length >= maxRetainedEvents) {
              streamLines.shift();
            }
            streamLines.push(line);
            ctx.log(node.id, line);
          } catch {
            // Stream callbacks must never crash workflow execution.
          }
        },
      };

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        ctx.log(
          node.id,
          `Planner still running (${elapsedSec}s elapsed, streamEvents=${streamEventCount})`,
        );
      }, WORKFLOW_AGENT_HEARTBEAT_MS);

      let result;
      try {
        result = await agentPool.launchEphemeralThread(
          promptText,
          process.cwd(),
          agentTimeoutMs,
          launchExtra,
        );
      } finally {
        clearInterval(heartbeat);
      }

      ctx.log(
        node.id,
        `Planner completed: success=${result.success} streamEvents=${streamEventCount}`,
      );

      const threadId = result.threadId || result.sessionId || null;
      if (threadId) {
        ctx.data.sessionId = threadId;
        ctx.data.threadId = threadId;
      }

      if (outputVariable) {
        ctx.data[outputVariable] = String(result.output || "").trim();
      }
      const digest = buildAgentExecutionDigest(result, streamLines, maxRetainedEvents);
      return {
        success: result.success,
        output: result.output,
        summary: digest.summary,
        narrative: digest.narrative,
        thoughts: digest.thoughts,
        stream: digest.stream,
        taskCount: count,
        sdk: result.sdk,
        items: digest.items,
        itemCount: digest.itemCount,
        omittedItemCount: digest.omittedItemCount,
        threadId,
        sessionId: threadId,
      };
    }

    return {
      success: false,
      error: explicitPrompt
        ? "Agent pool not available"
        : "Agent pool or planner prompt not available",
    };
  },
});

registerNodeType("agent.evidence_collect", {
  describe: () => "Collect all evidence from .bosun/evidence for review",
  schema: {
    type: "object",
    properties: {
      evidenceDir: { type: "string", default: ".bosun/evidence" },
      types: { type: "array", items: { type: "string" }, default: ["png", "jpg", "json", "log", "txt"] },
    },
  },
  async execute(node, ctx) {
    const dir = ctx.resolve(node.config?.evidenceDir || ".bosun/evidence");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      return { files: [], count: 0, dir };
    }
    const { readdirSync, statSync } = await import("node:fs");
    const types = node.config?.types || ["png", "jpg", "json", "log", "txt"];
    const files = readdirSync(dir)
      .filter((f) => {
        const ext = f.split(".").pop()?.toLowerCase();
        return types.includes(ext);
      })
      .map((f) => ({
        name: f,
        path: resolve(dir, f),
        size: statSync(resolve(dir, f)).size,
        type: f.split(".").pop()?.toLowerCase(),
      }));

    return { files, count: files.length, dir };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  FLOW CONTROL — Gates, barriers, and routing
// ═══════════════════════════════════════════════════════════════════════════



