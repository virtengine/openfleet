/**
 * task-assessment.mjs — Codex/Copilot SDK-powered task lifecycle assessment.
 *
 * Provides intelligent decision-making for task lifecycle events:
 *   1. Should we merge this PR?
 *   2. Should we reprompt the same agent session?
 *   3. Should we start a new session (same agent)?
 *   4. Should we start a completely new attempt (different agent)?
 *   5. What EXACTLY should the prompt say?
 *
 * Unlike merge-strategy.mjs (which only runs post-completion), this module
 * provides continuous assessment throughout the task lifecycle — including
 * during rebase failures, idle detection, and post-merge downstream effects.
 *
 * Decisions are structured JSON with dynamic prompt generation.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// ── Valid lifecycle actions ──────────────────────────────────────────────────

const VALID_ACTIONS = new Set([
  "merge", // PR is ready — merge when CI passes
  "reprompt_same", // Send follow-up to the SAME agent session
  "reprompt_new_session", // Kill current session, start fresh session (same attempt)
  "new_attempt", // Abandon attempt entirely, start fresh attempt with new agent
  "wait", // Wait N seconds then re-assess
  "manual_review", // Escalate to human
  "close_and_replan", // Close PR, move task back to todo for replanning
  "accept_with_debt", // Accept partial outcome and record explicit debt items
  "split_task", // Split oversized/failing scope into actionable child tasks
  "escalate_to_replan", // Escalate the task back to planner/replan lane
  "noop", // No action needed
]);

// ── Dedup / rate limiting ───────────────────────────────────────────────────

/** @type {Map<string, number>} taskId → last assessment timestamp */
const assessmentDedup = new Map();
const ASSESSMENT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min per task

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} TaskAssessmentContext
 * @property {string}   taskId            - Task UUID
 * @property {string}   taskTitle         - Task title
 * @property {string}   [taskDescription] - Task description
 * @property {string}   attemptId         - Attempt UUID
 * @property {string}   shortId           - Short ID for logging
 * @property {string}   trigger           - What triggered the assessment
 *   ("rebase_failed", "idle_detected", "pr_merged_downstream", "agent_completed",
 *    "agent_failed", "ci_failed", "conflict_detected", "manual_request")
 * @property {string}   [branch]          - Branch name
 * @property {string}   [upstreamBranch]  - Target/base branch
 * @property {string}   [agentLastMessage] - Last message from agent
 * @property {string}   [agentType]       - "codex" or "copilot"
 * @property {number}   [attemptCount]    - Number of attempts so far
 * @property {number}   [sessionRetries]  - Number of session retries
 * @property {number}   [prNumber]        - PR number if exists
 * @property {string}   [prState]         - PR state
 * @property {string}   [ciStatus]        - CI status
 * @property {string}   [rebaseError]     - Error message from failed rebase
 * @property {string[]} [conflictFiles]   - List of conflicted files
 * @property {string}   [diffStat]        - Git diff stats
 * @property {number}   [commitsAhead]    - Commits ahead of upstream
 * @property {number}   [commitsBehind]   - Commits behind upstream
 * @property {number}   [taskAgeHours]    - How old the task is in hours
 * @property {object}   [previousDecisions] - History of past decisions for this task
 */

/**
 * @typedef {object} TaskAssessmentDecision
 * @property {boolean} success    - Whether assessment completed
 * @property {string}  action     - One of VALID_ACTIONS
 * @property {string}  [prompt]   - Dynamic prompt to send (for reprompt_same/reprompt_new_session)
 * @property {string}  [reason]   - Explanation for the decision
 * @property {number}  [waitSeconds] - For "wait" action
 * @property {string}  [agentType]   - Preferred agent for new_attempt ("codex" | "copilot")
 * @property {Array<{type?: string, severity?: string, description?: string, criterion?: string}>} [debtItems]
 * @property {Array<{title: string, description?: string, acceptance_criteria?: string[], priority?: string, tags?: string[]}>} [splitTasks]
 * @property {string}  rawOutput  - Raw SDK output for audit
 */

// ── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Build the assessment prompt based on the trigger and context.
 */
function buildAssessmentPrompt(ctx) {
  const parts = [];

  parts.push(`# Task Lifecycle Assessment

You are an expert autonomous engineering orchestrator. You must decide the BEST next action
for a task based on the context below. Your goal is to maximize task completion rate while
minimizing wasted compute.

## Trigger
**Event:** ${ctx.trigger}
**Timestamp:** ${new Date().toISOString()}

## Task Context`);

  if (ctx.taskTitle) parts.push(`**Task:** ${ctx.taskTitle}`);
  if (ctx.taskDescription) {
    parts.push(`**Description:** ${ctx.taskDescription.slice(0, 3000)}`);
  }
  if (ctx.branch) parts.push(`**Branch:** ${ctx.branch}`);
  if (ctx.upstreamBranch)
    parts.push(`**Upstream/Base:** ${ctx.upstreamBranch}`);
  if (ctx.agentType) parts.push(`**Agent:** ${ctx.agentType}`);
  if (ctx.attemptCount != null)
    parts.push(`**Attempt #:** ${ctx.attemptCount}`);
  if (ctx.sessionRetries != null)
    parts.push(`**Session Retries:** ${ctx.sessionRetries}`);
  if (ctx.taskAgeHours != null)
    parts.push(`**Task Age:** ${ctx.taskAgeHours.toFixed(1)}h`);

  // Trigger-specific context
  if (ctx.trigger === "rebase_failed" && ctx.rebaseError) {
    parts.push(`
## Rebase Failure Details
\`\`\`
${ctx.rebaseError.slice(0, 4000)}
\`\`\``);
    if (ctx.conflictFiles?.length) {
      parts.push(`
### Conflicted Files
${ctx.conflictFiles.map((f) => `- ${f}`).join("\n")}`);
    }
  }

  if (ctx.trigger === "pr_merged_downstream") {
    parts.push(`
## Downstream Impact
A PR was just merged into the upstream branch (${ctx.upstreamBranch}).
This task's branch needs to be rebased to incorporate the changes.
The rebase ${ctx.rebaseError ? "FAILED" : "has not been attempted yet"}.`);
  }

  // Agent's last message
  if (ctx.agentLastMessage) {
    parts.push(`
## Agent's Last Message
\`\`\`
${ctx.agentLastMessage.slice(0, 6000)}
\`\`\``);
  }

  // PR details
  if (ctx.prNumber) {
    parts.push(`
## Pull Request
- PR #${ctx.prNumber}
- State: ${ctx.prState || "unknown"}
- CI: ${ctx.ciStatus || "unknown"}`);
  }

  // Diff context
  if (ctx.commitsAhead != null || ctx.commitsBehind != null) {
    parts.push(`
## Branch Status
- Commits ahead: ${ctx.commitsAhead ?? "unknown"}
- Commits behind: ${ctx.commitsBehind ?? "unknown"}`);
  }

  if (ctx.diffStat) {
    parts.push(`
### Diff Stats
\`\`\`
${ctx.diffStat.slice(0, 2000)}
\`\`\``);
  }

  // Decision history
  if (ctx.previousDecisions) {
    const history = JSON.stringify(ctx.previousDecisions, null, 2).slice(
      0,
      1500,
    );
    parts.push(`
## Previous Decisions
\`\`\`json
${history}
\`\`\``);
  }

  // Decision framework — adapted per trigger
  parts.push(`
## Decision Rules

Choose ONE action based on the trigger "${ctx.trigger}":

### Actions Available

1. **merge** — The PR is ready to merge. Agent completed the work, CI passing or expected to pass.
   Generate: \`{ "action": "merge", "reason": "..." }\`

2. **reprompt_same** — Send a SPECIFIC follow-up message to the same agent session.
   The agent is still running and can receive messages. Use when:
   - Small fix needed (lint error, missing test, typo)
   - Rebase conflict on files the agent can resolve
   - Agent needs to push their changes
   Generate: \`{ "action": "reprompt_same", "prompt": "SPECIFIC instructions for the agent...", "reason": "..." }\`

3. **reprompt_new_session** — Kill current session, start fresh with the same task.
   Use when:
   - Agent's context window is exhausted
   - Agent is stuck in a loop
   - Session has accumulated too many errors
   - Rebase failed and agent needs a clean start to resolve
   Generate: \`{ "action": "reprompt_new_session", "prompt": "SPECIFIC task instructions for fresh session...", "reason": "..." }\`

4. **new_attempt** — Completely fresh attempt, potentially different agent type.
   Use when:
   - Multiple session retries have failed (>2)
   - Agent consistently misunderstands the task
   - Need to switch between Codex and Copilot
   Generate: \`{ "action": "new_attempt", "reason": "...", "agentType": "codex"|"copilot" }\`

5. **wait** — Re-assess after N seconds.
   Use when: CI running, rebase in progress, agent actively working.
   Generate: \`{ "action": "wait", "waitSeconds": 300, "reason": "..." }\`

6. **manual_review** — Escalate to human.
   Use when: Security-sensitive changes, complex conflicts, repeated failures.
   Generate: \`{ "action": "manual_review", "reason": "..." }\`

7. **close_and_replan** — Close PR, move task back to backlog for replanning.
   Use when: Approach is fundamentally wrong, task needs rethinking.
   Generate: \`{ "action": "close_and_replan", "reason": "..." }\`

8. **accept_with_debt** — Mark task as acceptable but incomplete.
   Use when: Core objective is met but explicit gaps remain that should be tracked.
   Generate: \`{ "action": "accept_with_debt", "reason": "...", "debtItems": [{"type":"missing_functionality","severity":"medium","description":"..."}] }\`

9. **split_task** — Split into smaller sub-tasks and re-queue.
   Use when: Scope is too broad or repeated failures indicate decomposition is needed.
   Generate: \`{ "action": "split_task", "reason": "...", "splitTasks": [{"title":"...", "description":"...", "acceptance_criteria":["..."], "priority":"medium", "tags":["split"]}] }\`

10. **escalate_to_replan** — Escalate to planning lane for DAG-level changes.
   Use when: Local retries are exhausted and task needs a larger plan revision.
   Generate: \`{ "action": "escalate_to_replan", "reason": "..." }\`

11. **noop** — No action needed.
   Generate: \`{ "action": "noop", "reason": "..." }\`

### CRITICAL Rules for Prompt Generation

When generating prompts (for reprompt_same or reprompt_new_session), the prompt MUST:
- Be SPECIFIC — include file names, error messages, exact instructions
- Include the task context — the agent may have lost context
- For rebase failures: instruct the agent to resolve specific conflicts
- For CI failures: paste the error output and tell the agent what to fix
- NEVER be generic like "please fix the issues" — that wastes compute time

## Response Format

Respond with ONLY a JSON object:

\`\`\`json
{
  "action": "reprompt_same",
  "prompt": "The rebase onto origin/staging failed with conflicts in go.sum and pnpm-lock.yaml. Run 'git checkout --theirs go.sum pnpm-lock.yaml && git add go.sum pnpm-lock.yaml && git rebase --continue' to resolve. Then run tests and push.",
  "reason": "Rebase conflict on auto-resolvable lock files. Agent can fix in current session."
}
\`\`\`

RESPOND WITH ONLY THE JSON OBJECT.`);

  return parts.join("\n");
}

// ── JSON extraction (shared pattern with merge-strategy.mjs) ────────────────

function extractDecisionJson(raw) {
  if (!raw || typeof raw !== "string") return null;

  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed.action === "string") return parsed;
  } catch {
    /* not pure JSON */
  }

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed.action === "string") return parsed;
    } catch {
      /* bad JSON in fence */
    }
  }

  const braceMatch = raw.match(/\{[\s\S]*?"action"\s*:\s*"[^"]+?"[\s\S]*?\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      if (parsed && typeof parsed.action === "string") return parsed;
    } catch {
      /* partial match */
    }
  }

  return null;
}

function normalizeDebtItems(rawDebtItems) {
  if (!Array.isArray(rawDebtItems)) return [];
  return rawDebtItems
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const type = String(item.type || "").trim();
      const severity = String(item.severity || "").trim().toLowerCase();
      const description = String(
        item.description || item.detail || item.message || "",
      ).trim();
      const criterion = String(item.criterion || "").trim();
      if (!type && !description && !criterion) return null;
      return {
        type: type || "unspecified",
        severity:
          ["critical", "high", "medium", "low"].includes(severity)
            ? severity
            : "medium",
        description,
        criterion,
      };
    })
    .filter(Boolean);
}

function normalizeSplitTasks(rawSplitTasks) {
  if (!Array.isArray(rawSplitTasks)) return [];
  return rawSplitTasks
    .map((task) => {
      if (!task || typeof task !== "object") return null;
      const title = String(task.title || task.name || "").trim();
      if (!title) return null;
      const description = String(task.description || "").trim();
      const priority = String(task.priority || "").trim().toLowerCase();
      const tags = Array.isArray(task.tags)
        ? task.tags
          .map((tag) => String(tag || "").trim())
          .filter(Boolean)
        : [];
      const acceptanceCriteriaRaw =
        task.acceptance_criteria || task.acceptanceCriteria;
      const acceptance_criteria = Array.isArray(acceptanceCriteriaRaw)
        ? acceptanceCriteriaRaw
          .map((criterion) => String(criterion || "").trim())
          .filter(Boolean)
        : [];
      return {
        title,
        description,
        acceptance_criteria,
        priority:
          ["critical", "high", "medium", "low"].includes(priority)
            ? priority
            : undefined,
        tags,
      };
    })
    .filter(Boolean);
}

// ── Main assessment function ────────────────────────────────────────────────

/**
 * Assess a task and return a structured lifecycle decision.
 *
 * @param {TaskAssessmentContext} ctx
 * @param {object} opts
 * @param {function} opts.execCodex - Primary agent prompt executor
 * @param {number}   [opts.timeoutMs] - Timeout for SDK call
 * @param {string}   [opts.logDir] - Directory for audit logs
 * @param {function} [opts.onTelegram] - Telegram notification callback
 * @returns {Promise<TaskAssessmentDecision>}
 */
export async function assessTask(ctx, opts) {
  const tag = `assessment(${ctx.shortId})`;

  // ── Dedup check ─────────────────────────────────────────────
  const lastRun = assessmentDedup.get(ctx.taskId);
  if (lastRun && Date.now() - lastRun < ASSESSMENT_COOLDOWN_MS) {
    console.log(
      `[${tag}] skipping — assessed ${Math.round((Date.now() - lastRun) / 1000)}s ago`,
    );
    return { success: false, action: "noop", reason: "dedup", rawOutput: "" };
  }
  assessmentDedup.set(ctx.taskId, Date.now());

  const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;

  try {
    // ── Build prompt ──────────────────────────────────────────
    const prompt = buildAssessmentPrompt(ctx);

    // ── Execute via primary agent SDK ─────────────────────────
    console.log(`[${tag}] running assessment (trigger: ${ctx.trigger})`);
    const result = await opts.execCodex(prompt, { timeoutMs });

    const rawOutput = result?.finalResponse || result || "";
    const rawStr =
      typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);

    // ── Parse decision ────────────────────────────────────────
    const decision = extractDecisionJson(rawStr);

    if (!decision || !VALID_ACTIONS.has(decision.action)) {
      console.warn(
        `[${tag}] invalid/missing action in response — defaulting to manual_review`,
      );

      // Write audit log
      await writeAuditLog(opts.logDir, ctx, rawStr, {
        action: "manual_review",
        reason: "parse_failure",
      });

      return {
        success: false,
        action: "manual_review",
        reason: `Could not parse assessment response: ${rawStr.slice(0, 200)}`,
        rawOutput: rawStr,
      };
    }

    const result_ = {
      success: true,
      action: decision.action,
      prompt: decision.prompt || decision.message || undefined,
      reason: decision.reason || undefined,
      waitSeconds: decision.waitSeconds || decision.seconds || undefined,
      agentType: decision.agentType || undefined,
      debtItems: normalizeDebtItems(decision.debtItems || decision.debt_items),
      splitTasks: normalizeSplitTasks(decision.splitTasks || decision.subTasks || decision.sub_tasks),
      rawOutput: rawStr,
    };

    // ── Audit log ─────────────────────────────────────────────
    await writeAuditLog(opts.logDir, ctx, rawStr, result_);

    // ── Telegram notification ─────────────────────────────────
    if (opts.onTelegram) {
      const emoji =
        {
          merge: ":check:",
          reprompt_same: ":chat:",
          reprompt_new_session: ":refresh:",
          new_attempt: ":star:",
          wait: ":clock:",
          manual_review: ":eye:",
          close_and_replan: ":ban:",
          accept_with_debt: ":memo:",
          split_task: ":split:",
          escalate_to_replan: ":warning:",
          noop: ":dot:",
        }[decision.action] || ":help:";
      opts.onTelegram(
        `${emoji} Assessment [${ctx.shortId}] ${ctx.trigger}: **${decision.action}**\n${decision.reason || ""}`.slice(
          0,
          500,
        ),
      );
    }

    console.log(
      `[${tag}] decision: ${decision.action} — ${(decision.reason || "").slice(0, 100)}`,
    );
    return result_;
  } catch (err) {
    console.warn(`[${tag}] assessment error: ${err.message || err}`);
    return {
      success: false,
      action: "noop",
      reason: `Assessment error: ${err.message || err}`,
      rawOutput: "",
    };
  }
}

// ── Quick assessment (no SDK call) ──────────────────────────────────────────

/**
 * Fast heuristic-based assessment for common scenarios that don't need SDK.
 * Returns a decision if the scenario is clear-cut, or null if SDK is needed.
 *
 * @param {TaskAssessmentContext} ctx
 * @returns {TaskAssessmentDecision | null}
 */
export function quickAssess(ctx) {
  // ── Rebase failed on only auto-resolvable files ──────────
  if (ctx.trigger === "rebase_failed" && ctx.conflictFiles?.length) {
    const lockPatterns = [
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "go.sum",
      "CHANGELOG.md",
      "coverage.txt",
      "results.txt",
    ];
    const lockExts = [".lock"];
    const allAutoResolvable = ctx.conflictFiles.every((f) => {
      const name = f.split("/").pop();
      return (
        lockPatterns.includes(name) ||
        lockExts.some((ext) => name.endsWith(ext))
      );
    });

    if (allAutoResolvable) {
      const theirsFiles = ctx.conflictFiles.filter((f) => {
        const name = f.split("/").pop();
        return !["CHANGELOG.md", "coverage.txt", "results.txt"].includes(name);
      });
      const oursFiles = ctx.conflictFiles.filter((f) => {
        const name = f.split("/").pop();
        return ["CHANGELOG.md", "coverage.txt", "results.txt"].includes(name);
      });

      const instructions = [];
      if (theirsFiles.length) {
        instructions.push(
          `git checkout --theirs ${theirsFiles.join(" ")} && git add ${theirsFiles.join(" ")}`,
        );
      }
      if (oursFiles.length) {
        instructions.push(
          `git checkout --ours ${oursFiles.join(" ")} && git add ${oursFiles.join(" ")}`,
        );
      }

      return {
        success: true,
        action: "reprompt_same",
        prompt: `Rebase onto ${ctx.upstreamBranch || "upstream"} failed with conflicts in auto-resolvable files. Run:\n${instructions.join("\n")}\nThen run: git rebase --continue\nAfter that, run tests and push.`,
        reason: `All ${ctx.conflictFiles.length} conflicted files are auto-resolvable (lock files/generated)`,
        rawOutput: "quick_assess:auto_resolvable_conflicts",
      };
    }
  }

  // ── Too many attempts — escalate ─────────────────────────
  if (ctx.attemptCount != null && ctx.attemptCount >= 4) {
    return {
      success: true,
      action: "manual_review",
      reason: `Task has had ${ctx.attemptCount} attempts — escalating to human review`,
      rawOutput: "quick_assess:max_attempts",
    };
  }

  // ── Too many session retries — try new attempt ───────────
  if (ctx.sessionRetries != null && ctx.sessionRetries >= 3) {
    return {
      success: true,
      action: "new_attempt",
      reason: `${ctx.sessionRetries} session retries exhausted — starting fresh attempt with alternate agent`,
      agentType: ctx.agentType === "codex" ? "copilot" : "codex",
      rawOutput: "quick_assess:session_retries_exhausted",
    };
  }

  // ── PR merged downstream — always rebase first ───────────
  if (ctx.trigger === "pr_merged_downstream" && !ctx.rebaseError) {
    return {
      success: true,
      action: "reprompt_same",
      prompt: `A PR was just merged into your upstream branch (${ctx.upstreamBranch}). Please rebase your branch onto ${ctx.upstreamBranch} to incorporate the latest changes: git fetch origin && git rebase ${ctx.upstreamBranch}. Resolve any conflicts, then push.`,
      reason: "Upstream branch updated — agent should rebase",
      rawOutput: "quick_assess:downstream_rebase",
    };
  }

  // No quick assessment possible — caller should use full SDK assessment
  return null;
}

// ── Audit logging ───────────────────────────────────────────────────────────

async function writeAuditLog(logDir, ctx, rawOutput, decision) {
  if (!logDir) return;

  try {
    await mkdir(logDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const shortId = ctx.shortId || ctx.taskId?.substring(0, 8) || "unknown";
    const filename = `assessment-${shortId}-${ctx.trigger}-${timestamp}.log`;

    const content = [
      `Task Assessment Audit Log`,
      `========================`,
      `Timestamp: ${new Date().toISOString()}`,
      `Task: ${ctx.taskTitle || "unknown"} (${ctx.taskId || "unknown"})`,
      `Attempt: ${ctx.attemptId || "unknown"} (${ctx.shortId || "unknown"})`,
      `Trigger: ${ctx.trigger}`,
      `Branch: ${ctx.branch || "unknown"}`,
      `Upstream: ${ctx.upstreamBranch || "unknown"}`,
      `Agent: ${ctx.agentType || "unknown"}`,
      ``,
      `Decision:`,
      `  Action: ${decision.action}`,
      `  Reason: ${decision.reason || "none"}`,
      decision.prompt ? `  Prompt: ${decision.prompt.slice(0, 500)}` : "",
      ``,
      `Raw Output:`,
      `${rawOutput}`,
    ]
      .filter(Boolean)
      .join("\n");

    await writeFile(resolve(logDir, filename), content, "utf8");
  } catch {
    /* best-effort audit logging */
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────

export function resetAssessmentDedup() {
  assessmentDedup.clear();
}

export { VALID_ACTIONS, buildAssessmentPrompt, extractDecisionJson };
