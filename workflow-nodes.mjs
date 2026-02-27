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

import { registerNodeType } from "./workflow-engine.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const TAG = "[workflow-nodes]";
const PORTABLE_WORKTREE_COUNT_COMMAND = "node -e \"const cp=require('node:child_process');const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(String(count)+'\\\\n');\"";
const PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND = "node -e \"const cp=require('node:child_process');cp.execSync('git worktree prune',{stdio:'ignore'});const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(String(count)+'\\\\n');\"";
const WORKFLOW_AGENT_HEARTBEAT_MS = (() => {
  const raw = Number(process.env.WORKFLOW_AGENT_HEARTBEAT_MS || 30000);
  if (!Number.isFinite(raw)) return 30000;
  return Math.max(5000, Math.min(120000, Math.trunc(raw)));
})();

function trimLogText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function extractStreamText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (entry == null) return "";
        if (typeof entry === "string") return entry;
        if (typeof entry?.text === "string") return entry.text;
        if (typeof entry?.content === "string") return entry.content;
        if (typeof entry?.deltaContent === "string") return entry.deltaContent;
        return "";
      })
      .filter(Boolean);
    return parts.join(" ");
  }
  if (typeof value === "object") {
    if (typeof value?.text === "string") return value.text;
    if (typeof value?.content === "string") return value.content;
    if (typeof value?.deltaContent === "string") return value.deltaContent;
  }
  return "";
}

function summarizeAgentStreamEvent(event) {
  const type = String(event?.type || "").trim();
  if (!type) return "";

  if (type === "item.updated") {
    return "";
  }

  if (type === "tool_call") {
    return `Tool call: ${event?.tool_name || event?.data?.tool_name || "unknown"}`;
  }

  if (type === "tool_result") {
    const name = event?.tool_name || event?.data?.tool_name || "unknown";
    return `Tool result: ${name}`;
  }

  if (type === "error") {
    return `Agent error: ${trimLogText(event?.error || event?.message || "unknown error", 220)}`;
  }

  const item = event?.item;
  if (item && (type === "item.completed" || type === "item.started")) {
    const itemType = String(item?.type || "").trim().toLowerCase();
    const toolName =
      item?.tool_name ||
      item?.toolName ||
      item?.name ||
      item?.call?.tool_name ||
      item?.call?.name ||
      item?.function?.name ||
      null;

    if (
      itemType === "tool_call" ||
      itemType === "mcp_tool_call" ||
      itemType === "function_call" ||
      itemType === "tool_use"
    ) {
      return `Tool call: ${toolName || "unknown"}`;
    }
    if (
      itemType === "tool_result" ||
      itemType === "mcp_tool_result" ||
      itemType === "tool_output"
    ) {
      return `Tool result: ${toolName || "unknown"}`;
    }

    const itemText = trimLogText(
      extractStreamText(item?.text) ||
        extractStreamText(item?.summary) ||
        extractStreamText(item?.content) ||
        extractStreamText(item?.message?.content) ||
        extractStreamText(item?.message?.text),
      220,
    );

    if (itemType.includes("reason") || itemType.includes("thinking")) {
      return itemText ? `Thinking: ${itemText}` : "Thinking...";
    }

    if (
      itemType === "agent_message" ||
      itemType === "assistant_message" ||
      itemType === "message"
    ) {
      return itemText ? `Agent: ${itemText}` : "";
    }

    if (itemText) {
      return `${itemType || "item"}: ${itemText}`;
    }
  }

  const messageText = trimLogText(
    extractStreamText(event?.message?.content) ||
      extractStreamText(event?.message?.text) ||
      extractStreamText(event?.content) ||
      extractStreamText(event?.text) ||
      extractStreamText(event?.data?.content) ||
      extractStreamText(event?.data?.text) ||
      extractStreamText(event?.data?.deltaContent) ||
      "",
    220,
  );

  if (messageText) {
    if (
      type === "agent_message" ||
      type === "assistant_message" ||
      type === "message" ||
      type === "item.completed"
    ) {
      return `Agent: ${messageText}`;
    }
    return `${type}: ${messageText}`;
  }

  if (
    type === "turn.complete" ||
    type === "session.completed" ||
    type === "response.completed"
  ) {
    return `Agent event: ${type}`;
  }

  return "";
}

function normalizeLegacyWorkflowCommand(command) {
  let normalized = String(command || "");
  if (!normalized) return normalized;
  if (/--json\s+name,state,conclusion\b/i.test(normalized)) {
    normalized = normalized.replace(/--json\s+name,state,conclusion\b/gi, "--json name,state");
  }
  if (/grep\s+-c\s+worktree/i.test(normalized)) {
    normalized = /git\s+worktree\s+prune/i.test(normalized)
      ? PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND
      : PORTABLE_WORKTREE_COUNT_COMMAND;
  }
  return normalized;
}

function isBosunStateComment(text) {
  const raw = String(text || "").toLowerCase();
  return raw.includes("bosun-state") || raw.includes("codex:ignore");
}

function normalizeTaskComments(task, maxComments = 6) {
  if (!task) return [];
  const raw = Array.isArray(task.comments)
    ? task.comments
    : Array.isArray(task.meta?.comments)
      ? task.meta.comments
      : [];
  const normalized = raw
    .map((comment) => {
      const body = typeof comment === "string"
        ? comment
        : comment.body || comment.text || comment.content || "";
      const trimmed = String(body || "").trim();
      if (!trimmed || isBosunStateComment(trimmed)) return null;
      return {
        author: comment?.author || comment?.user || null,
        createdAt: comment?.createdAt || comment?.created_at || null,
        body: trimmed.replace(/\s+/g, " ").slice(0, 600),
      };
    })
    .filter(Boolean);
  if (normalized.length <= maxComments) return normalized;
  return normalized.slice(-maxComments);
}

function normalizeTaskAttachments(task, maxAttachments = 10) {
  if (!task) return [];
  const combined = []
    .concat(Array.isArray(task.attachments) ? task.attachments : [])
    .concat(Array.isArray(task.meta?.attachments) ? task.meta.attachments : []);
  if (combined.length <= maxAttachments) return combined;
  return combined.slice(0, maxAttachments);
}

function formatAttachmentLine(att) {
  const name = att.name || att.filename || att.title || "attachment";
  const kind = att.kind ? ` (${att.kind})` : "";
  const location = att.url || att.filePath || att.path || "";
  const suffix = location ? ` — ${location}` : "";
  return `- ${name}${kind}${suffix}`;
}

function formatCommentLine(comment) {
  const author = comment.author ? `@${comment.author}` : "comment";
  const when = comment.createdAt ? ` (${comment.createdAt})` : "";
  return `- ${author}${when}: ${comment.body}`;
}

function buildTaskContextBlock(task) {
  if (!task) return "";
  const comments = normalizeTaskComments(task);
  const attachments = normalizeTaskAttachments(task);
  if (!comments.length && !attachments.length) return "";
  const lines = ["## Task Context"];
  if (comments.length) {
    lines.push("### Comments");
    for (const comment of comments) lines.push(formatCommentLine(comment));
  }
  if (attachments.length) {
    lines.push("### Attachments");
    for (const attachment of attachments) lines.push(formatAttachmentLine(attachment));
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
//  TRIGGERS — Events that initiate a workflow
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("trigger.manual", {
  describe: () => "Manual trigger — workflow starts on user request",
  schema: {
    type: "object",
    properties: {},
  },
  async execute(node, ctx) {
    ctx.log(node.id, "Manual trigger fired");
    return { triggered: true, reason: "manual" };
  },
});

registerNodeType("trigger.task_low", {
  describe: () => "Fires when backlog task count drops below threshold",
  schema: {
    type: "object",
    properties: {
      threshold: { type: "number", default: 3, description: "Minimum todo count before triggering" },
      status: { type: "string", default: "todo", description: "Task status to count" },
      projectId: { type: "string", description: "Project ID to check (optional)" },
    },
  },
  async execute(node, ctx) {
    const threshold = node.config?.threshold ?? 3;
    const todoCount = ctx.data?.todoCount ?? ctx.data?.backlogCount ?? 0;
    const triggered = todoCount < threshold;
    ctx.log(node.id, `Task count: ${todoCount}, threshold: ${threshold}, triggered: ${triggered}`);
    return { triggered, todoCount, threshold };
  },
});

registerNodeType("trigger.schedule", {
  describe: () => "Fires on a cron-like schedule (checked by supervisor loop)",
  schema: {
    type: "object",
    properties: {
      intervalMs: { type: "number", default: 3600000, description: "Interval in milliseconds" },
      cron: { type: "string", description: "Cron expression (future support)" },
    },
  },
  async execute(node, ctx) {
    const interval = node.config?.intervalMs ?? 3600000;
    const lastRun = ctx.data?._lastRunAt ?? 0;
    const elapsed = Date.now() - lastRun;
    const triggered = elapsed >= interval;
    ctx.log(node.id, `Schedule check: ${elapsed}ms elapsed, interval: ${interval}ms, triggered: ${triggered}`);
    return { triggered, elapsed, interval };
  },
});

registerNodeType("trigger.event", {
  describe: () => "Fires on a specific bosun event (task.complete, pr.merged, etc.)",
  schema: {
    type: "object",
    properties: {
      eventType: { type: "string", description: "Event type to listen for" },
      filter: { type: "string", description: "Optional filter expression" },
    },
  },
  async execute(node, ctx) {
    const expected = node.config?.eventType;
    const actual = ctx.data?.eventType || ctx.eventType;
    const triggered = expected === actual;
    if (triggered && node.config?.filter) {
      try {
        const fn = new Function("$event", `return (${node.config.filter});`);
        return { triggered: fn(ctx.data), eventType: actual };
      } catch {
        return { triggered: false, reason: "filter_error" };
      }
    }
    return { triggered, eventType: actual };
  },
});

registerNodeType("trigger.webhook", {
  describe: () => "Fires when a webhook is received at the workflow's endpoint",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Webhook path (auto-generated if empty)" },
      method: { type: "string", default: "POST", enum: ["GET", "POST"] },
    },
  },
  async execute(node, ctx) {
    return { triggered: true, payload: ctx.data?.webhookPayload || {} };
  },
});

registerNodeType("trigger.pr_event", {
  describe: () => "Fires on PR events (opened, merged, review requested, etc.)",
  schema: {
    type: "object",
    properties: {
      event: { type: "string", enum: ["opened", "merged", "review_requested", "changes_requested", "approved", "closed"], description: "PR event type" },
      branchPattern: { type: "string", description: "Branch name regex filter" },
    },
  },
  async execute(node, ctx) {
    const expected = node.config?.event;
    const actual = ctx.data?.prEvent;
    let triggered = expected === actual;
    if (triggered && node.config?.branchPattern) {
      const regex = new RegExp(node.config.branchPattern);
      triggered = regex.test(ctx.data?.branch || "");
    }
    return { triggered, prEvent: actual };
  },
});

registerNodeType("trigger.task_assigned", {
  describe: () => "Fires when a task is assigned to an agent",
  schema: {
    type: "object",
    properties: {
      agentType: { type: "string", description: "Filter by agent type (e.g., 'frontend')" },
      taskPattern: { type: "string", description: "Title/tag pattern to match" },
    },
  },
  async execute(node, ctx) {
    const triggered = ctx.data?.eventType === "task.assigned";
    if (triggered && node.config?.taskPattern) {
      const regex = new RegExp(node.config.taskPattern, "i");
      const title = ctx.data?.taskTitle || "";
      return { triggered: regex.test(title), task: ctx.data };
    }
    return { triggered, task: ctx.data };
  },
});

registerNodeType("trigger.anomaly", {
  describe: () => "Fires when the anomaly detector reports an anomaly matching the configured criteria",
  schema: {
    type: "object",
    properties: {
      anomalyType: { type: "string", description: "Anomaly type filter (e.g., 'error_spike', 'stuck_agent', 'build_failure')" },
      minSeverity: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium", description: "Minimum severity to trigger" },
      agentFilter: { type: "string", description: "Regex to match agent ID or name" },
    },
  },
  async execute(node, ctx) {
    const expected = node.config?.anomalyType;
    const actual = ctx.data?.anomalyType || ctx.data?.type;
    const typeMatch = !expected || expected === actual;

    // Severity ranking
    const severityRank = { low: 1, medium: 2, high: 3, critical: 4 };
    const minSev = severityRank[node.config?.minSeverity || "medium"] || 2;
    const actualSev = severityRank[ctx.data?.severity] || 0;
    const sevMatch = actualSev >= minSev;

    // Agent filter
    let agentMatch = true;
    if (node.config?.agentFilter && ctx.data?.agentId) {
      try {
        agentMatch = new RegExp(node.config.agentFilter, "i").test(ctx.data.agentId);
      } catch { agentMatch = false; }
    }

    const triggered = typeMatch && sevMatch && agentMatch;
    return {
      triggered,
      anomaly: ctx.data,
      anomalyType: actual,
      severity: ctx.data?.severity,
      agentId: ctx.data?.agentId,
    };
  },
});

registerNodeType("trigger.scheduled_once", {
  describe: () => "Fires once at or after a specific scheduled time (persistent — survives restarts)",
  schema: {
    type: "object",
    properties: {
      runAt: { type: "string", description: "ISO 8601 datetime or relative expression (e.g., '+30m', '+2h')" },
      reason: { type: "string", description: "Human-readable reason for the scheduled trigger" },
    },
    required: ["runAt"],
  },
  async execute(node, ctx) {
    const rawRunAt = ctx.resolve(node.config?.runAt || "");
    let runAtMs;

    // Parse relative time expressions: +30m, +2h, +1d
    const relMatch = rawRunAt.match(/^\+(\d+)([smhd])$/);
    if (relMatch) {
      const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      runAtMs = Date.now() + (parseInt(relMatch[1], 10) * (multipliers[relMatch[2]] || 60000));
    } else {
      runAtMs = new Date(rawRunAt).getTime();
    }

    if (isNaN(runAtMs)) {
      return { triggered: false, reason: "invalid_runAt", raw: rawRunAt };
    }

    const triggered = Date.now() >= runAtMs;
    return {
      triggered,
      runAt: new Date(runAtMs).toISOString(),
      reason: node.config?.reason || "",
      remainingMs: triggered ? 0 : runAtMs - Date.now(),
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONDITIONS — Branching / routing logic
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("condition.expression", {
  describe: () => "Evaluate a JS expression to branch workflow execution",
  schema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "JS expression. Access $data, $output, $ctx" },
    },
    required: ["expression"],
  },
  async execute(node, ctx) {
    const expr = node.config?.expression;
    if (!expr) throw new Error("Expression is required");
    try {
      const fn = new Function("$data", "$ctx", "$output", `return (${expr});`);
      const allOutputs = {};
      for (const [k, v] of ctx.nodeOutputs) allOutputs[k] = v;
      const result = fn(ctx.data, ctx, allOutputs);
      ctx.log(node.id, `Expression "${expr}" → ${result}`);
      return { result: !!result, value: result };
    } catch (err) {
      throw new Error(`Expression error: ${err.message}`);
    }
  },
});

registerNodeType("condition.task_has_tag", {
  describe: () => "Check if current task has a specific tag or label",
  schema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Tag to check for" },
      field: { type: "string", default: "tags", description: "Field to check (tags, labels, title)" },
    },
    required: ["tag"],
  },
  async execute(node, ctx) {
    const tag = node.config?.tag?.toLowerCase();
    const field = node.config?.field || "tags";
    let haystack = ctx.data?.task?.[field] || ctx.data?.[field] || "";
    if (Array.isArray(haystack)) haystack = haystack.join(",").toLowerCase();
    else haystack = String(haystack).toLowerCase();
    const result = haystack.includes(tag);
    ctx.log(node.id, `Tag check: "${tag}" in ${field} → ${result}`);
    return { result, tag, field };
  },
});

registerNodeType("condition.file_exists", {
  describe: () => "Check if a file or directory exists in the workspace",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path (supports {{variables}})" },
    },
    required: ["path"],
  },
  async execute(node, ctx) {
    const filePath = ctx.resolve(node.config?.path || "");
    const exists = existsSync(filePath);
    ctx.log(node.id, `File check: "${filePath}" → ${exists}`);
    return { result: exists, path: filePath };
  },
});

registerNodeType("condition.switch", {
  describe: () => "Multi-way branch based on a value matching cases",
  schema: {
    type: "object",
    properties: {
      value: { type: "string", description: "Expression to evaluate" },
      expression: { type: "string", description: "Legacy alias for value" },
      field: { type: "string", description: "Legacy field lookup key (fallback when no expression is provided)" },
      cases: {
        type: "object",
        description: "Map of case values to output port names",
        additionalProperties: { type: "string" },
      },
    },
    required: [],
  },
  async execute(node, ctx) {
    let value;
    const expr = node.config?.value || node.config?.expression || "";
    if (expr) {
      try {
        const fn = new Function("$data", "$ctx", `return (${expr});`);
        value = fn(ctx.data, ctx);
      } catch {
        value = ctx.resolve(expr);
      }
    } else if (node.config?.field) {
      const field = String(node.config.field || "").trim();
      value = field ? ctx.data?.[field] : undefined;
      if (value === undefined && field) {
        for (const output of ctx.nodeOutputs?.values?.() || []) {
          if (
            output &&
            typeof output === "object" &&
            Object.prototype.hasOwnProperty.call(output, field)
          ) {
            value = output[field];
            break;
          }
        }
      }
    }
    const cases = node.config?.cases || {};
    const matchedPort = cases[String(value)] || "default";
    ctx.log(node.id, `Switch: "${value}" → port "${matchedPort}"`);
    return { value, matchedPort, port: matchedPort };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  ACTIONS — Side-effect operations
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("action.run_agent", {
  describe: () => "Run a bosun agent with a prompt to perform work",
  schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Agent prompt (supports {{variables}})" },
      sdk: { type: "string", enum: ["codex", "copilot", "claude", "auto"], default: "auto" },
      cwd: { type: "string", description: "Working directory for the agent" },
      timeoutMs: { type: "number", default: 3600000, description: "Agent timeout in ms" },
      agentProfile: { type: "string", description: "Agent profile name (e.g., 'frontend', 'backend')" },
      includeTaskContext: { type: "boolean", default: true, description: "Append task comments/attachments if available" },
      failOnError: { type: "boolean", default: false, description: "Throw when agent returns success=false (enables workflow retries)" },
    },
    required: ["prompt"],
  },
  async execute(node, ctx, engine) {
    const prompt = ctx.resolve(node.config?.prompt || "");
    const sdk = node.config?.sdk || "auto";
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const timeoutMs = node.config?.timeoutMs || 3600000;
    const includeTaskContext = node.config?.includeTaskContext !== false;
    let finalPrompt = prompt;
    if (includeTaskContext) {
      const explicitContext =
        ctx.data?.taskContext ||
        ctx.data?.taskContextBlock ||
        null;
      const task = ctx.data?.task || ctx.data?.taskDetail || ctx.data?.taskInfo || null;
      const contextBlock = explicitContext || buildTaskContextBlock(task);
      if (contextBlock) finalPrompt = `${prompt}\n\n${contextBlock}`;
    }

    ctx.log(node.id, `Running agent (${sdk}) in ${cwd}`);

    // Use the engine's service injection to call agent pool
    const agentPool = engine.services?.agentPool;
    if (agentPool?.launchEphemeralThread) {
      let streamEventCount = 0;
      let lastStreamLog = "";
      const startedAt = Date.now();
      const launchExtra = {};
      if (sdk && sdk !== "auto") launchExtra.sdk = sdk;

      launchExtra.onEvent = (event) => {
        try {
          const line = summarizeAgentStreamEvent(event);
          if (!line || line === lastStreamLog) return;
          lastStreamLog = line;
          streamEventCount += 1;
          ctx.log(node.id, line);
        } catch {
          // Stream callbacks must never crash workflow execution.
        }
      };

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        ctx.log(node.id, `Agent still running (${elapsedSec}s elapsed)`);
      }, WORKFLOW_AGENT_HEARTBEAT_MS);

      let result;
      try {
        result = await agentPool.launchEphemeralThread(
          finalPrompt,
          cwd,
          timeoutMs,
          launchExtra,
        );
      } finally {
        clearInterval(heartbeat);
      }

      ctx.log(
        node.id,
        `Agent completed: success=${result.success} streamEvents=${streamEventCount}`,
      );

      if (node.config?.failOnError && result.success !== true) {
        const errorMessage = trimLogText(
          result.error || result.output || "Agent reported failure",
          400,
        );
        throw new Error(errorMessage || "Agent reported failure");
      }

      // Propagate session/thread IDs for downstream chaining
      const threadId = result.threadId || result.sessionId || null;
      if (threadId) {
        ctx.data.sessionId = threadId;
        ctx.data.threadId = threadId;
      }

      return {
        success: result.success,
        output: result.output,
        sdk: result.sdk,
        items: result.items,
        threadId,
        sessionId: threadId,
      };
    }

    // Fallback: shell-based execution
    ctx.log(node.id, "Agent pool not available, using shell fallback");
    try {
      const output = execSync(
        `node -e "import('./agent-pool.mjs').then(m => m.launchEphemeralThread(process.argv[1], process.argv[2], ${timeoutMs}).then(r => console.log(JSON.stringify(r))))" "${finalPrompt.replace(/"/g, '\\"')}" "${cwd}"`,
        { cwd: resolve(dirname(new URL(import.meta.url).pathname)), timeout: timeoutMs + 30000, encoding: "utf8" }
      );
      const parsed = JSON.parse(output);
      if (node.config?.failOnError && parsed?.success === false) {
        throw new Error(trimLogText(parsed?.error || parsed?.output || "Agent reported failure", 400));
      }
      return parsed;
    } catch (err) {
      if (node.config?.failOnError) throw err;
      return { success: false, error: err.message };
    }
  },
});

registerNodeType("action.run_command", {
  describe: () => "Execute a shell command in the workspace",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      cwd: { type: "string", description: "Working directory" },
      timeoutMs: { type: "number", default: 300000 },
      shell: { type: "string", default: "auto", enum: ["auto", "bash", "pwsh", "cmd"] },
      captureOutput: { type: "boolean", default: true },
      failOnError: { type: "boolean", default: false, description: "Throw on non-zero exit status (enables workflow retries)" },
    },
    required: ["command"],
  },
  async execute(node, ctx) {
    const resolvedCommand = ctx.resolve(node.config?.command || "");
    const command = normalizeLegacyWorkflowCommand(resolvedCommand);
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const timeout = node.config?.timeoutMs || 300000;

    if (command !== resolvedCommand) {
      ctx.log(node.id, `Normalized legacy command for portability: ${command}`);
    }
    ctx.log(node.id, `Running: ${command}`);
    try {
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: node.config?.captureOutput !== false ? "pipe" : "inherit",
      });
      ctx.log(node.id, `Command succeeded`);
      return { success: true, output: output?.trim(), exitCode: 0 };
    } catch (err) {
      const output = err.stdout?.toString() || "";
      const stderr = err.stderr?.toString() || "";
      const result = {
        success: false,
        output,
        stderr,
        exitCode: err.status,
        error: err.message,
      };
      if (node.config?.failOnError) {
        const reason = trimLogText(stderr || output || err.message, 400) || err.message;
        throw new Error(reason);
      }
      return result;
    }
  },
});

registerNodeType("action.create_task", {
  describe: () => "Create a new task in the kanban board",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title" },
      description: { type: "string", description: "Task description" },
      status: { type: "string", default: "todo" },
      priority: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
      projectId: { type: "string" },
    },
    required: ["title"],
  },
  async execute(node, ctx, engine) {
    const title = ctx.resolve(node.config?.title || "");
    const description = ctx.resolve(node.config?.description || "");
    const kanban = engine.services?.kanban;

    ctx.log(node.id, `Creating task: ${title}`);

    if (kanban?.createTask) {
      const task = await kanban.createTask({
        title,
        description,
        status: node.config?.status || "todo",
        priority: node.config?.priority,
        tags: node.config?.tags,
        projectId: node.config?.projectId,
      });
      return { success: true, taskId: task.id, title };
    }
    return { success: false, error: "Kanban adapter not available" };
  },
});

registerNodeType("action.update_task_status", {
  describe: () => "Update the status of an existing task",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID (supports {{variables}})" },
      status: { type: "string", enum: ["todo", "inprogress", "inreview", "done", "archived"] },
      taskTitle: { type: "string", description: "Optional task title for downstream event payloads" },
      previousStatus: { type: "string", description: "Optional explicit previous status" },
      workflowEvent: { type: "string", description: "Optional follow-up workflow event to emit after status update" },
      workflowData: { type: "object", description: "Additional payload for workflowEvent" },
      workflowDedupKey: { type: "string", description: "Optional dedup key for workflowEvent dispatch" },
    },
    required: ["taskId", "status"],
  },
  async execute(node, ctx, engine) {
    const taskId = ctx.resolve(node.config?.taskId || "");
    const status = node.config?.status;
    const kanban = engine.services?.kanban;
    const workflowEvent = ctx.resolve(node.config?.workflowEvent || "");
    const workflowData =
      node.config?.workflowData && typeof node.config.workflowData === "object"
        ? node.config.workflowData
        : null;
    const taskTitle = ctx.resolve(node.config?.taskTitle || "");
    const previousStatus = ctx.resolve(node.config?.previousStatus || "");
    const workflowDedupKey = ctx.resolve(node.config?.workflowDedupKey || "");
    const updateOptions = {};
    if (taskTitle) updateOptions.taskTitle = taskTitle;
    if (previousStatus) updateOptions.previousStatus = previousStatus;
    if (workflowEvent) updateOptions.workflowEvent = workflowEvent;
    if (workflowData) updateOptions.workflowData = workflowData;
    if (workflowDedupKey) updateOptions.workflowDedupKey = workflowDedupKey;

    if (kanban?.updateTaskStatus) {
      await kanban.updateTaskStatus(taskId, status, updateOptions);
      return {
        success: true,
        taskId,
        status,
        workflowEvent: workflowEvent || null,
      };
    }
    return { success: false, error: "Kanban adapter not available" };
  },
});

registerNodeType("action.git_operations", {
  describe: () => "Perform git operations (commit, push, create branch, etc.)",
  schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["commit", "push", "create_branch", "checkout", "merge", "rebase", "status"] },
      operations: {
        type: "array",
        description: "Legacy multi-step operation list",
        items: {
          type: "object",
          properties: {
            op: { type: "string" },
            operation: { type: "string" },
            message: { type: "string" },
            branch: { type: "string" },
            name: { type: "string" },
            includeTags: { type: "boolean" },
            paths: { type: "array", items: { type: "string" } },
          },
        },
      },
      message: { type: "string", description: "Commit message (for commit operation)" },
      branch: { type: "string", description: "Branch name" },
      cwd: { type: "string" },
    },
    required: [],
  },
  async execute(node, ctx) {
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const resolveOpCommand = (opConfig = {}) => {
      const op = String(opConfig.op || opConfig.operation || "").trim();
      const branch = ctx.resolve(opConfig.branch || node.config?.branch || "");
      const message = ctx.resolve(opConfig.message || node.config?.message || "");
      const tagName = ctx.resolve(opConfig.name || "");
      const includeTags = opConfig.includeTags === true;
      const addPaths = Array.isArray(opConfig.paths) && opConfig.paths.length > 0
        ? opConfig.paths.map((path) => ctx.resolve(String(path))).join(" ")
        : "-A";

      const commands = {
        add: `git add ${addPaths}`,
        commit: `git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`,
        tag: tagName ? `git tag ${tagName}` : "",
        push: includeTags
          ? "git push --set-upstream origin HEAD && git push --tags"
          : "git push --set-upstream origin HEAD",
        create_branch: `git checkout -b ${branch}`,
        checkout: `git checkout ${branch}`,
        merge: `git merge ${branch} --no-edit`,
        rebase: `git rebase ${branch}`,
        status: "git status --porcelain",
      };
      const cmd = commands[op];
      if (!cmd) {
        throw new Error(`Unknown git operation: ${op}`);
      }
      return { op, cmd };
    };

    const runGitCommand = ({ op, cmd }) => {
      ctx.log(node.id, `Git ${op}: ${cmd}`);
      try {
        const output = execSync(cmd, { cwd, encoding: "utf8", timeout: 120000 });
        return { success: true, output: output?.trim(), operation: op, command: cmd };
      } catch (err) {
        return { success: false, error: err.message, operation: op, command: cmd };
      }
    };

    const operationList = Array.isArray(node.config?.operations)
      ? node.config.operations
      : [];
    if (operationList.length > 0) {
      const steps = [];
      for (const spec of operationList) {
        const resolved = resolveOpCommand(spec || {});
        const result = runGitCommand(resolved);
        steps.push(result);
        if (result.success !== true) {
          return {
            success: false,
            operation: resolved.op,
            steps,
            error: result.error,
          };
        }
      }
      return { success: true, operation: "batch", steps };
    }

    const op = String(node.config?.operation || "").trim();
    if (!op) {
      return { success: false, error: "No git operation provided", operation: null };
    }
    const resolved = resolveOpCommand({ op });
    return runGitCommand(resolved);
  },
});

registerNodeType("action.create_pr", {
  describe: () => "Create a GitHub Pull Request using gh CLI",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "PR title" },
      body: { type: "string", description: "PR body" },
      base: { type: "string", description: "Base branch" },
      baseBranch: { type: "string", description: "Legacy alias for base branch" },
      branch: { type: "string", description: "Head branch to open PR from" },
      draft: { type: "boolean", default: false },
      cwd: { type: "string" },
      failOnError: { type: "boolean", default: false, description: "Throw when PR creation fails (enables workflow retries)" },
    },
    required: ["title"],
  },
  async execute(node, ctx) {
    const title = ctx.resolve(node.config?.title || "");
    const body = ctx.resolve(node.config?.body || "");
    const base = ctx.resolve(node.config?.base || node.config?.baseBranch || "main");
    const branch = ctx.resolve(node.config?.branch || "");
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const draft = node.config?.draft ? "--draft" : "";
    const head = branch ? `--head ${branch}` : "";

    const cmd = `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --base ${base} ${head} ${draft}`.trim();
    ctx.log(node.id, `Creating PR: ${title}`);
    try {
      const output = execSync(cmd, { cwd, encoding: "utf8", timeout: 60000 });
      return { success: true, url: output?.trim(), title, base, branch: branch || null };
    } catch (err) {
      if (node.config?.failOnError) {
        const stderr = err.stderr?.toString() || "";
        const stdout = err.stdout?.toString() || "";
        const reason = trimLogText(stderr || stdout || err.message, 400) || err.message;
        throw new Error(reason);
      }
      return { success: false, error: err.message };
    }
  },
});

registerNodeType("action.write_file", {
  describe: () => "Write content to a file in the workspace",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "File content" },
      append: { type: "boolean", default: false },
      mkdir: { type: "boolean", default: true },
    },
    required: ["path", "content"],
  },
  async execute(node, ctx) {
    const filePath = ctx.resolve(node.config?.path || "");
    const content = ctx.resolve(node.config?.content || "");
    if (node.config?.mkdir) {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    if (node.config?.append) {
      const fs = await import("node:fs");
      fs.appendFileSync(filePath, content, "utf8");
    } else {
      writeFileSync(filePath, content, "utf8");
    }
    ctx.log(node.id, `Wrote ${filePath}`);
    return { success: true, path: filePath };
  },
});

registerNodeType("action.read_file", {
  describe: () => "Read content from a file",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
    },
    required: ["path"],
  },
  async execute(node, ctx) {
    const filePath = ctx.resolve(node.config?.path || "");
    if (!existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    const content = readFileSync(filePath, "utf8");
    return { success: true, content, path: filePath };
  },
});

registerNodeType("action.set_variable", {
  describe: () => "Set a variable in the workflow context for downstream nodes",
  schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Variable name" },
      value: { type: "string", description: "Value (supports {{template}} and JS expressions)" },
      isExpression: { type: "boolean", default: false },
    },
    required: ["key"],
  },
  async execute(node, ctx) {
    const key = node.config?.key;
    let value = node.config?.value || "";
    if (node.config?.isExpression) {
      try {
        const fn = new Function("$data", "$ctx", `return (${value});`);
        value = fn(ctx.data, ctx);
      } catch (err) {
        throw new Error(`Variable expression error: ${err.message}`);
      }
    } else {
      value = ctx.resolve(value);
    }
    ctx.data[key] = value;
    ctx.log(node.id, `Set variable: ${key} = ${JSON.stringify(value)}`);
    return { key, value };
  },
});

registerNodeType("action.delay", {
  describe: () => "Wait for a specified duration before continuing (supports ms, seconds, minutes, hours)",
  schema: {
    type: "object",
    properties: {
      ms: { type: "number", description: "Delay in milliseconds (direct)" },
      delayMs: { type: "number", description: "Legacy alias for ms" },
      durationMs: { type: "number", description: "Legacy alias for ms" },
      seconds: { type: "number", description: "Delay in seconds" },
      minutes: { type: "number", description: "Delay in minutes" },
      hours: { type: "number", description: "Delay in hours" },
      jitter: { type: "number", default: 0, description: "Random jitter percentage (0-100) to add/subtract from delay" },
      reason: { type: "string", description: "Human-readable reason for the delay (logged)" },
      message: { type: "string", description: "Legacy alias for reason" },
    },
  },
  async execute(node, ctx) {
    const baseMs = Number(
      node.config?.ms ??
      node.config?.delayMs ??
      node.config?.durationMs ??
      0,
    );
    const seconds = Number(node.config?.seconds || 0);
    const minutes = Number(node.config?.minutes || 0);
    const hours = Number(node.config?.hours || 0);

    // Compute total delay from all duration fields
    let totalMs = Number.isFinite(baseMs) ? baseMs : 0;
    if (Number.isFinite(seconds) && seconds > 0) totalMs += seconds * 1000;
    if (Number.isFinite(minutes) && minutes > 0) totalMs += minutes * 60_000;
    if (Number.isFinite(hours) && hours > 0) totalMs += hours * 3_600_000;
    if (totalMs <= 0) totalMs = 1000; // Default 1s

    // Apply jitter
    const jitterPct = Math.min(Math.max(node.config?.jitter || 0, 0), 100);
    if (jitterPct > 0) {
      const jitterRange = totalMs * (jitterPct / 100);
      totalMs += Math.floor(Math.random() * jitterRange * 2 - jitterRange);
      totalMs = Math.max(totalMs, 100); // Floor at 100ms
    }

    const reason = ctx.resolve(node.config?.reason || node.config?.message || "");
    ctx.log(node.id, `Waiting ${totalMs}ms${reason ? ` (${reason})` : ""}`);
    await new Promise((r) => setTimeout(r, totalMs));
    return { waited: totalMs, reason };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  VALIDATION — Verification gates
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("validation.screenshot", {
  describe: () => "Take a screenshot for visual verification and store in evidence",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to screenshot (local dev server, etc.)" },
      outputDir: { type: "string", default: ".bosun/evidence", description: "Directory to save screenshots" },
      filename: { type: "string", description: "Screenshot filename (auto-generated if empty)" },
      fullPage: { type: "boolean", default: true },
      viewport: {
        type: "object",
        properties: {
          width: { type: "number", default: 1280 },
          height: { type: "number", default: 720 },
        },
      },
      waitMs: { type: "number", default: 2000, description: "Wait time before screenshot" },
    },
    required: ["url"],
  },
  async execute(node, ctx) {
    const url = ctx.resolve(node.config?.url || "http://localhost:3000");
    const outDir = ctx.resolve(node.config?.outputDir || ".bosun/evidence");
    const filename = ctx.resolve(node.config?.filename || `screenshot-${Date.now()}.png`);
    const fullPage = node.config?.fullPage !== false;
    const viewport = node.config?.viewport || { width: 1280, height: 720 };
    const waitMs = node.config?.waitMs || 2000;

    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, filename);

    ctx.log(node.id, `Taking screenshot of ${url}`);

    // Try multiple screenshot methods in order of preference
    // 1. Playwright (if available)
    // 2. Puppeteer (if available)
    // 3. Agent-based (ask agent to take screenshot via MCP)
    // 4. Fallback: generate a placeholder and note for manual

    const screenshotMethods = [
      {
        name: "playwright",
        test: () => {
          try { execSync("npx playwright --version", { stdio: "pipe", timeout: 10000 }); return true; } catch { return false; }
        },
        exec: () => {
          const script = `
            const { chromium } = require('playwright');
            (async () => {
              const browser = await chromium.launch({ headless: true });
              const page = await browser.newPage({ viewport: { width: ${viewport.width}, height: ${viewport.height} } });
              await page.goto('${url}', { waitUntil: 'networkidle' });
              await page.waitForTimeout(${waitMs});
              await page.screenshot({ path: '${outPath.replace(/\\/g, "\\\\")}', fullPage: ${fullPage} });
              await browser.close();
            })();
          `;
          execSync(`node -e "${script.replace(/\n/g, " ").replace(/"/g, '\\"')}"`, {
            timeout: 60000,
            stdio: "pipe",
          });
        },
      },
      {
        name: "mcp-devtools",
        test: () => true, // always available as a prompt option
        exec: () => {
          // This will be executed by the agent via MCP chrome devtools
          ctx.data._pendingScreenshots = ctx.data._pendingScreenshots || [];
          ctx.data._pendingScreenshots.push({
            url,
            outPath,
            viewport,
            fullPage,
            waitMs,
          });
          // Write metadata file for the agent to process
          writeFileSync(
            resolve(outDir, `${filename}.meta.json`),
            JSON.stringify({ url, viewport, fullPage, waitMs, createdAt: Date.now() }, null, 2),
            "utf8"
          );
        },
      },
    ];

    let method = "none";
    for (const m of screenshotMethods) {
      try {
        if (m.test()) {
          m.exec();
          method = m.name;
          break;
        }
      } catch (err) {
        ctx.log(node.id, `Screenshot method ${m.name} failed: ${err.message}`, "warn");
      }
    }

    return {
      success: true,
      screenshotPath: outPath,
      method,
      url,
      viewport,
    };
  },
});

registerNodeType("validation.model_review", {
  describe: () => "Send evidence (screenshots, code, logs) to a non-agent model for independent verification",
  schema: {
    type: "object",
    properties: {
      evidenceDir: { type: "string", default: ".bosun/evidence", description: "Directory with evidence files" },
      originalTask: { type: "string", description: "Original task description for context" },
      criteria: { type: "string", description: "Specific acceptance criteria to verify" },
      model: { type: "string", default: "auto", description: "Model to use for review" },
      strictMode: { type: "boolean", default: true, description: "Require explicit PASS to succeed" },
    },
    required: ["originalTask"],
  },
  async execute(node, ctx, engine) {
    const evidenceDir = ctx.resolve(node.config?.evidenceDir || ".bosun/evidence");
    const originalTask = ctx.resolve(node.config?.originalTask || "");
    const criteria = ctx.resolve(node.config?.criteria || "");
    const strictMode = node.config?.strictMode !== false;

    ctx.log(node.id, `Model review: checking evidence in ${evidenceDir}`);

    // Collect evidence files
    const evidenceFiles = [];
    if (existsSync(evidenceDir)) {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(evidenceDir);
      for (const file of files) {
        if (file.endsWith(".meta.json")) continue;
        const filePath = resolve(evidenceDir, file);
        evidenceFiles.push({
          name: file,
          path: filePath,
          type: file.endsWith(".png") || file.endsWith(".jpg") ? "image" : "text",
        });
      }
    }

    if (evidenceFiles.length === 0) {
      ctx.log(node.id, "No evidence files found", "warn");
      return { passed: false, reason: "no_evidence", evidenceCount: 0 };
    }

    // Build the review prompt
    const reviewPrompt = `# Task Verification Review

## Original Task
${originalTask}

${criteria ? `## Acceptance Criteria\n${criteria}\n` : ""}

## Evidence Files
${evidenceFiles.map((f) => `- ${f.name} (${f.type})`).join("\n")}

## Instructions
Review the provided evidence (screenshots, code changes, logs) against the original task requirements.

Provide your assessment:
1. Does the implementation match the task requirements?
2. Are there any visual/functional issues visible in the screenshots?
3. Is the implementation complete or are there missing pieces?

## Verdict
Respond with exactly one of:
- **PASS** — Implementation meets all requirements
- **FAIL** — Implementation has issues (explain what's wrong)
- **PARTIAL** — Some requirements met but not all (explain what's missing)
`;

    // Use the agent pool for a non-agent model review
    const agentPool = engine.services?.agentPool;
    if (agentPool?.launchEphemeralThread) {
      const result = await agentPool.launchEphemeralThread(
        reviewPrompt,
        process.cwd(),
        5 * 60 * 1000, // 5-minute timeout for review
        { images: evidenceFiles.filter((f) => f.type === "image").map((f) => f.path) }
      );

      const output = result.output || "";
      const passed = strictMode
        ? /\bPASS\b/i.test(output) && !/\bFAIL\b/i.test(output)
        : !/\bFAIL\b/i.test(output);

      // Save review result
      const reviewPath = resolve(evidenceDir, `review-${Date.now()}.json`);
      writeFileSync(
        reviewPath,
        JSON.stringify({
          passed,
          originalTask,
          criteria,
          evidenceFiles: evidenceFiles.map((f) => f.name),
          reviewOutput: output,
          model: result.sdk,
          timestamp: Date.now(),
        }, null, 2),
        "utf8"
      );

      return {
        passed,
        reviewOutput: output,
        evidenceCount: evidenceFiles.length,
        reviewPath,
      };
    }

    // Fallback: mark for manual review
    ctx.log(node.id, "Agent pool not available for model review — marking for manual review", "warn");
    return {
      passed: false,
      reason: "manual_review_required",
      evidenceCount: evidenceFiles.length,
      evidenceDir,
    };
  },
});

registerNodeType("validation.tests", {
  describe: () => "Run test suite and verify results",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm test", description: "Test command to run" },
      cwd: { type: "string", description: "Working directory" },
      timeoutMs: { type: "number", default: 600000 },
      requiredPassRate: { type: "number", default: 1.0, description: "Minimum pass rate (0-1)" },
    },
  },
  async execute(node, ctx) {
    const command = ctx.resolve(node.config?.command || "npm test");
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const timeout = node.config?.timeoutMs || 600000;

    ctx.log(node.id, `Running tests: ${command}`);
    try {
      const output = execSync(command, { cwd, timeout, encoding: "utf8", stdio: "pipe" });
      ctx.log(node.id, "Tests passed");
      return { passed: true, output: output?.trim() };
    } catch (err) {
      const output = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
      ctx.log(node.id, "Tests failed", "error");
      return { passed: false, output, exitCode: err.status };
    }
  },
});

registerNodeType("validation.build", {
  describe: () => "Run build and verify it succeeds with 0 errors",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm run build", description: "Build command" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", default: 600000 },
      zeroWarnings: { type: "boolean", default: false, description: "Fail on warnings too" },
    },
  },
  async execute(node, ctx) {
    const resolvedCommand = ctx.resolve(node.config?.command || "npm run build");
    const command = normalizeLegacyWorkflowCommand(resolvedCommand);
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const timeout = node.config?.timeoutMs || 600000;

    if (command !== resolvedCommand) {
      ctx.log(node.id, `Normalized legacy command for portability: ${command}`);
    }
    ctx.log(node.id, `Building: ${command}`);
    try {
      const output = execSync(command, { cwd, timeout, encoding: "utf8", stdio: "pipe" });
      const hasWarnings = /warning/i.test(output || "");
      if (node.config?.zeroWarnings && hasWarnings) {
        return { passed: false, reason: "warnings_found", output: output?.trim() };
      }
      return { passed: true, output: output?.trim() };
    } catch (err) {
      return { passed: false, output: err.stderr?.toString() || err.message, exitCode: err.status };
    }
  },
});

registerNodeType("validation.lint", {
  describe: () => "Run linter and verify results",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm run lint", description: "Lint command" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", default: 120000 },
    },
  },
  async execute(node, ctx) {
    const command = ctx.resolve(node.config?.command || "npm run lint");
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    try {
      const output = execSync(command, { cwd, timeout: node.config?.timeoutMs || 120000, encoding: "utf8", stdio: "pipe" });
      return { passed: true, output: output?.trim() };
    } catch (err) {
      return { passed: false, output: err.stderr?.toString() || err.message };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  TRANSFORM — Data manipulation
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("transform.json_parse", {
  describe: () => "Parse JSON from a previous node's output",
  schema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Source: node ID or {{variable}}" },
      field: { type: "string", description: "Field in source output containing JSON" },
    },
  },
  async execute(node, ctx) {
    const sourceId = node.config?.input;
    const field = node.config?.field || "output";
    let raw = sourceId ? ctx.getNodeOutput(sourceId)?.[field] : ctx.resolve(node.config?.value || "");
    if (typeof raw !== "string") raw = JSON.stringify(raw);
    try {
      return { data: JSON.parse(raw), success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});

registerNodeType("transform.template", {
  describe: () => "Render a text template with context variables",
  schema: {
    type: "object",
    properties: {
      template: { type: "string", description: "Template text with {{variables}}" },
    },
    required: ["template"],
  },
  async execute(node, ctx) {
    const result = ctx.resolve(node.config?.template || "");
    return { text: result };
  },
});

registerNodeType("transform.aggregate", {
  describe: () => "Aggregate outputs from multiple nodes into a single object",
  schema: {
    type: "object",
    properties: {
      sources: { type: "array", items: { type: "string" }, description: "Node IDs to aggregate" },
    },
  },
  async execute(node, ctx) {
    const sources = node.config?.sources || [];
    const aggregated = {};
    for (const src of sources) {
      aggregated[src] = ctx.getNodeOutput(src);
    }
    return { aggregated, count: sources.length };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  NOTIFY — Notifications
// ═══════════════════════════════════════════════════════════════════════════

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
    },
    required: ["message"],
  },
  async execute(node, ctx, engine) {
    const message = ctx.resolve(node.config?.message || "");
    const telegram = engine.services?.telegram;

    if (telegram?.sendMessage) {
      await telegram.sendMessage(
        node.config?.chatId || undefined,
        message,
        { silent: node.config?.silent }
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

registerNodeType("agent.run_planner", {
  describe: () => "Run the task planner agent to generate new backlog tasks",
  schema: {
    type: "object",
    properties: {
      taskCount: { type: "number", default: 5, description: "Number of tasks to generate" },
      context: { type: "string", description: "Additional context for the planner" },
      prompt: { type: "string", description: "Optional explicit planner prompt override" },
      outputVariable: { type: "string", description: "Optional context key to store planner output text" },
      projectId: { type: "string" },
      dedup: { type: "boolean", default: true },
    },
  },
  async execute(node, ctx, engine) {
    const count = node.config?.taskCount || 5;
    const context = ctx.resolve(node.config?.context || "");
    const explicitPrompt = ctx.resolve(node.config?.prompt || "");
    const outputVariable = ctx.resolve(node.config?.outputVariable || "");

    ctx.log(node.id, `Running planner for ${count} tasks`);

    // This delegates to the existing planner prompt flow
    const agentPool = engine.services?.agentPool;
    const plannerPrompt = engine.services?.prompts?.planner;
    const promptText = explicitPrompt ||
      (plannerPrompt
        ? `${plannerPrompt}\n\nGenerate exactly ${count} new tasks.\n${context}`
        : "");

    if (agentPool?.launchEphemeralThread && promptText) {
      let streamEventCount = 0;
      let lastStreamLog = "";
      const startedAt = Date.now();
      const launchExtra = {
        onEvent: (event) => {
          try {
            const line = summarizeAgentStreamEvent(event);
            if (!line || line === lastStreamLog) return;
            lastStreamLog = line;
            streamEventCount += 1;
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
          15 * 60 * 1000,
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
      return {
        success: result.success,
        output: result.output,
        taskCount: count,
        sdk: result.sdk,
        items: result.items,
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

// ═══════════════════════════════════════════════════════════════════════════
//  LOOP / ITERATION
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("loop.for_each", {
  describe: () => "Iterate over an array, executing downstream nodes for each item",
  schema: {
    type: "object",
    properties: {
      items: { type: "string", description: "Expression that resolves to an array" },
      variable: { type: "string", default: "item", description: "Variable name for current item" },
      maxIterations: { type: "number", default: 50 },
    },
    required: ["items"],
  },
  async execute(node, ctx) {
    const expr = node.config?.items || "[]";
    let items;
    try {
      const fn = new Function("$data", "$ctx", `return (${expr});`);
      items = fn(ctx.data, ctx);
    } catch {
      items = [];
    }
    if (!Array.isArray(items)) items = [items];
    const max = node.config?.maxIterations || 50;
    items = items.slice(0, max);
    const varName = node.config?.variable || "item";

    // Store items for downstream processing
    ctx.data[`_loop_${node.id}_items`] = items;
    ctx.data[`_loop_${node.id}_count`] = items.length;

    return { items, count: items.length, variable: varName };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  SESSION / AGENT MANAGEMENT — Direct session control
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("action.continue_session", {
  describe: () => "Re-attach to an existing agent session and send a continuation prompt",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID to continue (supports {{variables}})" },
      prompt: { type: "string", description: "Continuation prompt for the agent" },
      timeoutMs: { type: "number", default: 1800000, description: "Timeout for continuation in ms" },
      strategy: { type: "string", enum: ["continue", "retry", "refine", "finish_up"], default: "continue", description: "Continuation strategy" },
    },
    required: ["prompt"],
  },
  async execute(node, ctx, engine) {
    const sessionId = ctx.resolve(node.config?.sessionId || ctx.data?.sessionId || "");
    const prompt = ctx.resolve(node.config?.prompt || "Continue working on the current task.");
    const timeout = node.config?.timeoutMs || 1800000;
    const strategy = node.config?.strategy || "continue";

    ctx.log(node.id, `Continuing session ${sessionId} (strategy: ${strategy})`);

    const agentPool = engine.services?.agentPool;
    if (agentPool?.continueSession) {
      const result = await agentPool.continueSession(sessionId, prompt, { timeout, strategy });

      // Propagate session ID for downstream chaining
      const threadId = result.threadId || sessionId;
      ctx.data.sessionId = threadId;
      ctx.data.threadId = threadId;

      return { success: result.success, output: result.output, sessionId: threadId, strategy };
    }

    // Fallback: use ephemeral thread with continuation context
    if (agentPool?.launchEphemeralThread) {
      const continuation = strategy === "retry"
        ? `Start over on this task. Previous attempt failed.\n\n${prompt}`
        : strategy === "refine"
        ? `Refine your previous work. Specifically:\n\n${prompt}`
        : strategy === "finish_up"
        ? `Wrap up the current task. Commit, create PR, ensure tests pass.\n\n${prompt}`
        : `Continue where you left off.\n\n${prompt}`;

      const result = await agentPool.launchEphemeralThread(continuation, ctx.data?.worktreePath || process.cwd(), timeout);

      // Propagate new session ID from fallback
      const threadId = result.threadId || result.sessionId || sessionId;
      if (threadId) {
        ctx.data.sessionId = threadId;
        ctx.data.threadId = threadId;
      }

      return { success: result.success, output: result.output, sessionId: threadId, strategy, fallback: true };
    }

    return { success: false, error: "Agent pool not available" };
  },
});

registerNodeType("action.restart_agent", {
  describe: () => "Kill and restart an agent session from scratch",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID to restart" },
      reason: { type: "string", description: "Reason for restart (logged and given as context)" },
      sdk: { type: "string", enum: ["codex", "copilot", "claude", "auto"], default: "auto" },
      prompt: { type: "string", description: "New prompt for the restarted agent" },
      cwd: { type: "string", description: "Working directory" },
      timeoutMs: { type: "number", default: 3600000 },
    },
    required: ["prompt"],
  },
  async execute(node, ctx, engine) {
    const sessionId = ctx.resolve(node.config?.sessionId || ctx.data?.sessionId || "");
    const reason = ctx.resolve(node.config?.reason || "workflow restart");
    const prompt = ctx.resolve(node.config?.prompt || "");
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());

    ctx.log(node.id, `Restarting agent session ${sessionId}: ${reason}`);

    const agentPool = engine.services?.agentPool;

    // Try to kill existing session first
    if (sessionId && agentPool?.killSession) {
      try {
        await agentPool.killSession(sessionId);
        ctx.log(node.id, `Killed previous session ${sessionId}`);
      } catch (err) {
        ctx.log(node.id, `Could not kill session ${sessionId}: ${err.message}`, "warn");
      }
    }

    // Launch new session
    if (agentPool?.launchEphemeralThread) {
      const result = await agentPool.launchEphemeralThread(
        `Previous attempt failed (reason: ${reason}). Starting fresh.\n\n${prompt}`,
        cwd,
        node.config?.timeoutMs || 3600000
      );

      // Propagate new session/thread IDs for downstream chaining
      const newThreadId = result.threadId || result.sessionId || null;
      if (newThreadId) {
        ctx.data.sessionId = newThreadId;
        ctx.data.threadId = newThreadId;
      }

      return { success: result.success, output: result.output, newSessionId: newThreadId, previousSessionId: sessionId, threadId: newThreadId };
    }

    return { success: false, error: "Agent pool not available" };
  },
});

registerNodeType("action.bosun_cli", {
  describe: () => "Run a bosun CLI command (task, monitor, agent, etc.)",
  schema: {
    type: "object",
    properties: {
      subcommand: { type: "string", enum: [
        "task list", "task create", "task get", "task update", "task delete",
        "task stats", "task plan", "task import",
        "agent list", "agent continue", "agent kill",
        "--daemon-status", "--echo-logs",
        "config show", "config doctor",
      ], description: "Bosun CLI subcommand" },
      args: { type: "string", description: "Additional arguments (e.g., --status todo --json)" },
      parseJson: { type: "boolean", default: true, description: "Parse JSON output automatically" },
    },
    required: ["subcommand"],
  },
  async execute(node, ctx) {
    const sub = node.config?.subcommand || "";
    const args = ctx.resolve(node.config?.args || "");
    const cmd = `bosun ${sub} ${args}`.trim();

    ctx.log(node.id, `Running: ${cmd}`);
    try {
      const output = execSync(cmd, { encoding: "utf8", timeout: 60000, stdio: "pipe" });
      let parsed = output?.trim();
      if (node.config?.parseJson !== false) {
        try { parsed = JSON.parse(parsed); } catch { /* not JSON, keep as string */ }
      }
      return { success: true, output: parsed, command: cmd };
    } catch (err) {
      return { success: false, error: err.message, command: cmd };
    }
  },
});

registerNodeType("action.handle_rate_limit", {
  describe: () => "Intelligently handle API rate limits with exponential backoff and provider rotation",
  schema: {
    type: "object",
    properties: {
      provider: { type: "string", description: "API provider that was rate limited (auto-detected if empty)" },
      baseDelayMs: { type: "number", default: 60000, description: "Base delay before retry (ms)" },
      maxDelayMs: { type: "number", default: 600000, description: "Maximum delay cap (ms)" },
      maxRetries: { type: "number", default: 5, description: "Maximum retry attempts" },
      fallbackProvider: { type: "string", enum: ["codex", "copilot", "claude", "none"], default: "none", description: "Alternative provider to try" },
      strategy: { type: "string", enum: ["wait", "rotate", "skip"], default: "wait", description: "Rate limit strategy" },
    },
  },
  async execute(node, ctx) {
    const attempt = ctx.data?._rateLimitAttempt || 0;
    const maxRetries = node.config?.maxRetries || 5;
    const strategy = node.config?.strategy || "wait";

    if (attempt >= maxRetries) {
      ctx.log(node.id, `Rate limit: exhausted ${maxRetries} retries`, "error");
      return { success: false, action: "exhausted", attempts: attempt };
    }

    if (strategy === "skip") {
      ctx.log(node.id, "Rate limit: skipping (strategy=skip)");
      return { success: true, action: "skipped" };
    }

    if (strategy === "rotate" && node.config?.fallbackProvider && node.config.fallbackProvider !== "none") {
      ctx.log(node.id, `Rate limit: rotating to ${node.config.fallbackProvider}`);
      ctx.data._activeProvider = node.config.fallbackProvider;
      return { success: true, action: "rotated", provider: node.config.fallbackProvider };
    }

    // Exponential backoff
    const baseDelay = node.config?.baseDelayMs || 60000;
    const maxDelay = node.config?.maxDelayMs || 600000;
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

    ctx.log(node.id, `Rate limit: waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise((r) => setTimeout(r, delay));

    ctx.data._rateLimitAttempt = attempt + 1;
    return { success: true, action: "waited", delayMs: delay, attempt: attempt + 1 };
  },
});

registerNodeType("action.ask_user", {
  describe: () => "Pause workflow and ask the user for input via Telegram or UI",
  schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Question to ask the user" },
      options: { type: "array", items: { type: "string" }, description: "Quick-reply options (optional)" },
      timeoutMs: { type: "number", default: 3600000, description: "How long to wait for response" },
      channel: { type: "string", enum: ["telegram", "ui", "both"], default: "both", description: "Where to ask" },
      variable: { type: "string", default: "userResponse", description: "Variable name to store the response" },
    },
    required: ["question"],
  },
  async execute(node, ctx, engine) {
    const question = ctx.resolve(node.config?.question || "");
    const options = node.config?.options || [];
    const channel = node.config?.channel || "both";
    const timeout = node.config?.timeoutMs || 3600000;

    ctx.log(node.id, `Asking user: ${question}`);

    // Send via Telegram if configured
    if ((channel === "telegram" || channel === "both") && engine.services?.telegram?.sendMessage) {
      const optionsText = options.length ? `\n\nOptions: ${options.join(" | ")}` : "";
      await engine.services.telegram.sendMessage(undefined, `❓ **Workflow Question**\n\n${question}${optionsText}`);
    }

    // Store question for UI polling
    ctx.data._pendingQuestion = { question, options, askedAt: Date.now(), timeout };

    // In real implementation, this would await a response
    // For now, return the question for the UI to handle
    const varName = node.config?.variable || "userResponse";
    const response = ctx.data[varName] || null;

    return {
      asked: true,
      question,
      options,
      response,
      variable: varName,
      channel,
    };
  },
});

registerNodeType("action.analyze_errors", {
  describe: () => "Run the error detector on recent logs and classify failures",
  schema: {
    type: "object",
    properties: {
      logSource: { type: "string", enum: ["agent", "build", "test", "all"], default: "all", description: "Which logs to analyze" },
      timeWindowMs: { type: "number", default: 3600000, description: "How far back to look (ms)" },
      minSeverity: { type: "string", enum: ["info", "warn", "error", "fatal"], default: "error" },
      outputVariable: { type: "string", default: "errorAnalysis", description: "Variable to store analysis" },
    },
  },
  async execute(node, ctx, engine) {
    const source = node.config?.logSource || "all";
    const timeWindow = node.config?.timeWindowMs || 3600000;
    const minSeverity = node.config?.minSeverity || "error";

    ctx.log(node.id, `Analyzing errors from ${source} (last ${timeWindow}ms)`);

    // Try to use the anomaly detector service
    const detector = engine.services?.anomalyDetector;
    if (detector?.analyzeRecent) {
      const analysis = await detector.analyzeRecent({ source, timeWindow, minSeverity });
      if (node.config?.outputVariable) {
        ctx.data[node.config.outputVariable] = analysis;
      }
      return { success: true, ...analysis };
    }

    // Fallback: check for recent error files in .bosun/
    const errorDir = resolve(process.cwd(), ".bosun", "errors");
    const errors = [];
    if (existsSync(errorDir)) {
      const { readdirSync, statSync } = await import("node:fs");
      const cutoff = Date.now() - timeWindow;
      for (const file of readdirSync(errorDir)) {
        const filePath = resolve(errorDir, file);
        const stat = statSync(filePath);
        if (stat.mtimeMs > cutoff) {
          try {
            const content = readFileSync(filePath, "utf8");
            errors.push({ file, content: content.slice(0, 2000), time: stat.mtimeMs });
          } catch { /* skip unreadable */ }
        }
      }
    }

    const analysis = {
      errorCount: errors.length,
      errors: errors.slice(0, 10),
      source,
      timeWindow,
      analyzedAt: Date.now(),
    };

    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = analysis;
    }

    return { success: true, ...analysis };
  },
});

registerNodeType("action.refresh_worktree", {
  describe: () => "Refresh git worktree state — fetch, pull, or reset to clean state",
  schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["fetch", "pull", "reset_hard", "clean", "checkout_main"], default: "fetch" },
      cwd: { type: "string", description: "Working directory" },
      branch: { type: "string", description: "Branch to operate on" },
    },
    required: ["operation"],
  },
  async execute(node, ctx) {
    const op = node.config?.operation || "fetch";
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const branch = ctx.resolve(node.config?.branch || "main");

    const commands = {
      fetch: "git fetch --all --prune",
      pull: `git pull origin ${branch} --rebase`,
      reset_hard: "git reset --hard HEAD && git clean -fd",
      clean: "git clean -fd",
      checkout_main: `git checkout ${branch} && git pull origin ${branch}`,
    };

    const cmd = commands[op];
    if (!cmd) throw new Error(`Unknown worktree operation: ${op}`);

    ctx.log(node.id, `Refreshing worktree (${op}): ${cmd}`);
    try {
      const output = execSync(cmd, { cwd, encoding: "utf8", timeout: 120000, shell: true });
      return { success: true, output: output?.trim(), operation: op };
    } catch (err) {
      return { success: false, error: err.message, operation: op };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  MCP Tool Call — execute a tool on an installed MCP server
// ═══════════════════════════════════════════════════════════════════════════

// Lazy-import MCP registry — cached at module scope per AGENTS.md rules.
let _mcpRegistry = null;
async function getMcpRegistry() {
  if (!_mcpRegistry) {
    _mcpRegistry = await import("./mcp-registry.mjs");
  }
  return _mcpRegistry;
}

/**
 * Spawn a stdio MCP server, send a JSON-RPC request, and collect the response.
 * Implements the MCP stdio transport: newline-delimited JSON-RPC over stdin/stdout.
 *
 * @param {Object} server — resolved MCP server config (command, args, env)
 * @param {string} method — JSON-RPC method (e.g. "tools/call", "tools/list")
 * @param {Object} params — JSON-RPC params
 * @param {number} timeoutMs — max wait time
 * @returns {Promise<Object>} — JSON-RPC result
 */
function mcpStdioRequest(server, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(server.env || {}) };
    const child = spawn(server.command, server.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: process.platform === "win32",
      timeout: timeoutMs + 5000,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const requestId = randomUUID();

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`MCP stdio request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      // Try to parse complete JSON-RPC responses (newline-delimited)
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          // Handle initialize response — send the actual tool call
          if (msg.id === `${requestId}-init` && msg.result) {
            // Send initialized notification
            const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
            child.stdin.write(initialized);
            // Now send the actual tool call
            const toolCall = JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              method,
              params,
            }) + "\n";
            child.stdin.write(toolCall);
          }
          // Handle the actual tool call response
          if (msg.id === requestId && !settled) {
            settled = true;
            clearTimeout(timer);
            child.kill("SIGTERM");
            if (msg.error) {
              reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              resolve(msg.result);
            }
          }
        } catch {
          // Not valid JSON yet — partial line, keep accumulating
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`MCP stdio spawn error: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`MCP server exited with code ${code}: ${stderr.slice(0, 500)}`));
        } else {
          reject(new Error("MCP server closed without responding"));
        }
      }
    });

    // Send initialize request first (MCP protocol handshake)
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: `${requestId}-init`,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "bosun-workflow", version: "1.0.0" },
      },
    }) + "\n";
    child.stdin.write(initRequest);
  });
}

/**
 * Send an HTTP JSON-RPC request to a URL-based MCP server.
 *
 * @param {string} url — MCP server URL
 * @param {string} method — JSON-RPC method
 * @param {Object} params — JSON-RPC params
 * @param {number} timeoutMs — max wait time
 * @returns {Promise<Object>} — JSON-RPC result
 */
async function mcpUrlRequest(url, method, params, timeoutMs = 30000) {
  const requestId = randomUUID();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`MCP URL request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

registerNodeType("action.mcp_tool_call", {
  describe: () => "Call a tool on an installed MCP server from the library",
  schema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server ID from the library (e.g. 'github', 'filesystem', 'context7')",
      },
      tool: {
        type: "string",
        description: "Tool name to invoke on the MCP server",
      },
      input: {
        type: "object",
        description: "Tool input arguments (server-specific)",
        additionalProperties: true,
      },
      timeoutMs: {
        type: "number",
        default: 30000,
        description: "Timeout in ms for the MCP tool call",
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store the result in ctx.data",
      },
    },
    required: ["server", "tool"],
  },
  async execute(node, ctx) {
    const serverId = ctx.resolve(node.config?.server || "");
    const toolName = ctx.resolve(node.config?.tool || "");
    const input = node.config?.input || {};
    const timeoutMs = node.config?.timeoutMs || 30000;

    if (!serverId) throw new Error("action.mcp_tool_call: 'server' is required");
    if (!toolName) throw new Error("action.mcp_tool_call: 'tool' is required");

    ctx.log(node.id, `MCP tool call: ${serverId}/${toolName}`);

    // Resolve the MCP server from the library/catalog
    const registry = await getMcpRegistry();
    const rootDir = ctx.data?.worktreePath || ctx.data?.repoRoot || process.cwd();
    const resolved = await registry.resolveMcpServersForAgent(rootDir, [serverId]);

    if (!resolved || !resolved.length) {
      throw new Error(
        `action.mcp_tool_call: MCP server "${serverId}" not found. ` +
        `Install it first via the library: installMcpServer("${serverId}")`,
      );
    }

    const server = resolved[0];
    ctx.log(node.id, `Resolved server: ${server.name} (${server.transport})`);

    // Resolve any {{variable}} references in tool input
    const resolvedInput = {};
    for (const [key, value] of Object.entries(input)) {
      resolvedInput[key] = typeof value === "string" ? ctx.resolve(value) : value;
    }

    let result;
    try {
      if (server.transport === "url" && server.url) {
        // URL-based MCP server — direct HTTP JSON-RPC
        result = await mcpUrlRequest(server.url, "tools/call", {
          name: toolName,
          arguments: resolvedInput,
        }, timeoutMs);
      } else if (server.command) {
        // Stdio-based MCP server — spawn process and communicate via JSON-RPC
        result = await mcpStdioRequest(server, "tools/call", {
          name: toolName,
          arguments: resolvedInput,
        }, timeoutMs);
      } else {
        throw new Error(
          `MCP server "${serverId}" has no command or url configured`,
        );
      }
    } catch (err) {
      ctx.log(node.id, `MCP tool call failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
        server: serverId,
        tool: toolName,
      };
    }

    ctx.log(node.id, `MCP tool call completed successfully`);

    // Extract content from MCP tool call result
    const content = result?.content || result;
    const textContent = Array.isArray(content)
      ? content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n")
      : typeof content === "string"
        ? content
        : JSON.stringify(content);

    const output = {
      success: true,
      server: serverId,
      tool: toolName,
      result: content,
      text: textContent,
      isError: result?.isError || false,
    };

    // Store in ctx.data if outputVariable is set
    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = output;
    }

    return output;
  },
});

registerNodeType("action.mcp_list_tools", {
  describe: () => "List available tools on an installed MCP server",
  schema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server ID from the library",
      },
      timeoutMs: {
        type: "number",
        default: 30000,
        description: "Timeout in ms",
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store the tool list in ctx.data",
      },
    },
    required: ["server"],
  },
  async execute(node, ctx) {
    const serverId = ctx.resolve(node.config?.server || "");
    const timeoutMs = node.config?.timeoutMs || 30000;

    if (!serverId) throw new Error("action.mcp_list_tools: 'server' is required");

    ctx.log(node.id, `Listing tools for MCP server: ${serverId}`);

    const registry = await getMcpRegistry();
    const rootDir = ctx.data?.worktreePath || ctx.data?.repoRoot || process.cwd();
    const resolved = await registry.resolveMcpServersForAgent(rootDir, [serverId]);

    if (!resolved || !resolved.length) {
      throw new Error(`action.mcp_list_tools: MCP server "${serverId}" not found`);
    }

    const server = resolved[0];
    let result;

    try {
      if (server.transport === "url" && server.url) {
        result = await mcpUrlRequest(server.url, "tools/list", {}, timeoutMs);
      } else if (server.command) {
        result = await mcpStdioRequest(server, "tools/list", {}, timeoutMs);
      } else {
        throw new Error(`MCP server "${serverId}" has no command or url`);
      }
    } catch (err) {
      ctx.log(node.id, `Failed to list tools: ${err.message}`);
      return { success: false, error: err.message, server: serverId, tools: [] };
    }

    const tools = result?.tools || [];
    ctx.log(node.id, `Found ${tools.length} tool(s) on ${serverId}`);

    const output = { success: true, server: serverId, tools };
    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = output;
    }
    return output;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  Export all registered types for introspection
// ═══════════════════════════════════════════════════════════════════════════

export { registerNodeType, getNodeType, listNodeTypes } from "./workflow-engine.mjs";
