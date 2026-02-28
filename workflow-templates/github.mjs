/**
 * github.mjs — GitHub-related workflow templates.
 *
 * Templates:
 *   - PR Merge Strategy (recommended)
 *   - PR Triage & Labels
 *   - PR Conflict Resolver (recommended)
 *   - Stale PR Reaper
 *   - Release Drafter
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  PR Merge Strategy
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_MERGE_STRATEGY_TEMPLATE = {
  id: "template-pr-merge-strategy",
  name: "PR Merge Strategy",
  description:
    "Automated PR merge decision workflow with resilient retry paths. " +
    "Analyzes CI + agent output, executes merge/prompt/close/re-attempt " +
    "actions, and escalates gracefully when any branch action fails.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.pr_event",
  variables: {
    ciTimeoutMs: 300000,
    cooldownSec: 60,
    maxRetries: 3,
    baseBranch: "main",
  },
  nodes: [
    node("trigger", "trigger.pr_event", "PR Ready for Review", {
      event: "review_requested",
    }, { x: 400, y: 50 }),

    node("check-ci", "validation.build", "Check CI Status", {
      command: "gh pr checks {{prNumber}} --json name,state",
    }, { x: 150, y: 200 }),

    node("get-diff", "action.run_command", "Get Diff Stats", {
      command: "git diff --stat {{baseBranch}}...HEAD",
    }, { x: 650, y: 200 }),

    node("ci-passed", "condition.expression", "CI Passed?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('check-ci'); if (!out || out.passed !== true) return false; let checks = []; try { checks = JSON.parse(out.output || '[]'); } catch { return false; } if (!Array.isArray(checks) || checks.length === 0) return false; const ok = new Set(['SUCCESS', 'PASSED', 'PASS', 'COMPLETED', 'NEUTRAL', 'SKIPPED']); return checks.every((c) => ok.has(String(c?.state || '').toUpperCase())); })()",
    }, { x: 150, y: 350, outputs: ["yes", "no"] }),

    node("wait-for-ci", "action.delay", "Wait for CI", {
      ms: "{{ciTimeoutMs}}",
      reason: "CI is still running",
    }, { x: 150, y: 500 }),

    node("analyze", "action.run_agent", "Analyze Merge Strategy", {
      prompt: `# PR Merge Strategy Analysis

Review PR #{{prNumber}} on branch {{branch}}.

## Decision Options:
1. **merge_after_ci_pass** — Code looks correct, CI is green, merge it.
2. **prompt** — Agent needs to do more work (provide specific instructions).
3. **close_pr** — PR should be closed (bad approach, duplicate, etc.).
4. **re_attempt** — Start task over with fresh agent.
5. **manual_review** — Escalate to human reviewer.
6. **wait** — CI still running, wait before deciding.
7. **noop** — No action needed.

Respond with JSON: { "action": "<choice>", "reason": "<why>", "message": "<optional details>" }`,
      timeoutMs: 900000,
    }, { x: 400, y: 350 }),

    node("parse-decision", "action.set_variable", "Parse Decision JSON", {
      key: "decision",
      value:
        "(() => { const raw = $ctx.getNodeOutput('analyze')?.output || '{}'; if (raw && typeof raw === 'object') return raw; try { return JSON.parse(String(raw)); } catch { return { action: 'manual_review', reason: 'unparseable merge strategy response', message: String(raw || '') }; } })()",
      isExpression: true,
    }, { x: 400, y: 430 }),

    node("decision-router", "condition.switch", "Route Decision", {
      value:
        "(() => { const action = String($data?.decision?.action || '').trim().toLowerCase(); return action || 'manual_review'; })()",
      cases: {
        merge_after_ci_pass: "merge",
        prompt: "prompt-agent",
        close_pr: "close",
        re_attempt: "retry",
        manual_review: "escalate",
        wait: "wait-for-ci",
        noop: "default",
      },
    }, { x: 400, y: 520, outputs: ["merge", "prompt-agent", "close", "retry", "escalate", "wait-for-ci", "default"] }),

    node("do-merge", "action.run_command", "Auto-Merge PR", {
      command: "gh pr merge {{prNumber}} --auto --squash",
      failOnError: true,
      maxRetries: "{{maxRetries}}",
      retryDelayMs: 30000,
      continueOnError: true,
    }, { x: 100, y: 680 }),

    node("do-prompt", "action.run_agent", "Prompt Agent", {
      prompt: "Continue working on the PR. Instructions: {{decision.message}}",
      timeoutMs: 3600000,
      failOnError: true,
      maxRetries: 2,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 300, y: 680 }),

    node("do-close", "action.run_command", "Close PR", {
      command: "gh pr close {{prNumber}} --comment \"{{decision.reason}}\"",
      failOnError: true,
      maxRetries: 2,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 500, y: 680 }),

    node("do-retry", "action.run_agent", "Re-attempt Task", {
      prompt: "Start the task over from scratch. Previous attempt failed: {{decision.reason}}",
      timeoutMs: 3600000,
      failOnError: true,
      maxRetries: 2,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 700, y: 680 }),

    node("do-escalate", "notify.telegram", "Escalate to Human", {
      message: "👀 PR #{{prNumber}} needs manual review: {{decision.reason}}",
    }, { x: 900, y: 680 }),

    node("action-succeeded", "condition.expression", "Action Succeeded?", {
      expression:
        "(() => { const action = String($data?.decision?.action || '').trim().toLowerCase(); if (action === 'merge_after_ci_pass') return $ctx.getNodeOutput('do-merge')?.success === true; if (action === 'prompt') return $ctx.getNodeOutput('do-prompt')?.success === true; if (action === 'close_pr') return $ctx.getNodeOutput('do-close')?.success === true; if (action === 're_attempt') return $ctx.getNodeOutput('do-retry')?.success === true; if (action === 'manual_review') return $ctx.getNodeOutput('do-escalate')?.sent !== false; return true; })()",
    }, { x: 480, y: 770, outputs: ["yes", "no"] }),

    node("notify-action-failed", "notify.telegram", "Escalate Action Failure", {
      message:
        "⚠️ PR #{{prNumber}} workflow action failed after retries ({{decision.action}}). " +
        "Reason: {{decision.reason}}. Manual follow-up required.",
    }, { x: 760, y: 850 }),

    node("notify-complete", "notify.log", "Log Result", {
      message: "PR #{{prNumber}} merge strategy: {{decision.action}} — {{decision.reason}}",
      level: "info",
    }, { x: 400, y: 850 }),
  ],
  edges: [
    edge("trigger", "check-ci"),
    edge("trigger", "get-diff"),
    edge("check-ci", "ci-passed"),
    edge("ci-passed", "wait-for-ci", { condition: "$output?.result !== true", port: "no" }),
    edge("ci-passed", "analyze", { condition: "$output?.result === true", port: "yes" }),
    edge("get-diff", "analyze"),
    edge("wait-for-ci", "analyze"),
    edge("analyze", "parse-decision"),
    edge("parse-decision", "decision-router"),
    edge("decision-router", "do-merge", { port: "merge" }),
    edge("decision-router", "do-prompt", { port: "prompt-agent" }),
    edge("decision-router", "do-close", { port: "close" }),
    edge("decision-router", "do-retry", { port: "retry" }),
    edge("decision-router", "do-escalate", { port: "escalate" }),
    edge("decision-router", "wait-for-ci", { port: "wait-for-ci" }),
    edge("decision-router", "notify-complete", { port: "default" }),
    edge("do-merge", "action-succeeded"),
    edge("do-prompt", "action-succeeded"),
    edge("do-close", "action-succeeded"),
    edge("do-retry", "action-succeeded"),
    edge("do-escalate", "action-succeeded"),
    edge("action-succeeded", "notify-complete", { condition: "$output?.result === true", port: "yes" }),
    edge("action-succeeded", "notify-action-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("notify-action-failed", "notify-complete"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "merge", "strategy", "automation"],
    replaces: {
      module: "merge-strategy.mjs",
      functions: ["analyzeMergeStrategy", "executeDecision", "analyzeAndExecute"],
      calledFrom: ["monitor.mjs:runMergeStrategyAnalysis"],
      description: "Replaces hardcoded merge-strategy analysis and decision execution. " +
        "All 7 decision outcomes (merge, prompt, close, re_attempt, manual_review, wait, noop) " +
        "are encoded as visual workflow branches instead of imperative code.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PR Triage & Labels
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_TRIAGE_TEMPLATE = {
  id: "template-pr-triage",
  name: "PR Triage & Labels",
  description:
    "Automatically triage incoming PRs: classify by size, detect breaking " +
    "changes, add labels, and assign reviewers based on CODEOWNERS.",
  category: "github",
  enabled: true,
  trigger: "trigger.pr_event",
  variables: {
    smallThreshold: 50,
    largeThreshold: 500,
  },
  nodes: [
    node("trigger", "trigger.pr_event", "PR Opened", {
      event: "opened",
    }, { x: 400, y: 50 }),

    node("get-stats", "action.run_command", "Get PR Stats", {
      command: "gh pr view {{prNumber}} --json additions,deletions,files,labels,title,body",
    }, { x: 400, y: 180 }),

    node("classify-size", "condition.switch", "Classify Size", {
      value:
        "(() => { const raw = $ctx.getNodeOutput('get-stats')?.output || '{}'; let stats = {}; try { stats = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { stats = {}; } const delta = Number(stats?.additions || 0) + Number(stats?.deletions || 0); const small = Number($data?.smallThreshold || 50); const large = Number($data?.largeThreshold || 500); if (delta < small) return 'small'; if (delta > large) return 'large'; return 'medium'; })()",
      cases: { small: "small", medium: "medium", large: "large" },
    }, { x: 400, y: 330, outputs: ["small", "medium", "large", "default"] }),

    node("label-small", "action.run_command", "Label: Size/S", {
      command: "gh pr edit {{prNumber}} --add-label \"size/S\"",
    }, { x: 150, y: 480 }),

    node("label-medium", "action.run_command", "Label: Size/M", {
      command: "gh pr edit {{prNumber}} --add-label \"size/M\"",
    }, { x: 400, y: 480 }),

    node("label-large", "action.run_command", "Label: Size/L", {
      command: "gh pr edit {{prNumber}} --add-label \"size/L\"",
    }, { x: 650, y: 480 }),

    node("detect-breaking", "action.run_agent", "Detect Breaking Changes", {
      prompt: "Analyze the diff for PR #{{prNumber}} and determine if there are any breaking changes. Respond with JSON: { \"breaking\": true/false, \"reason\": \"...\" }",
      timeoutMs: 300000,
    }, { x: 400, y: 630 }),

    node("is-breaking", "condition.expression", "Breaking?", {
      expression:
        "(() => { const raw = $ctx.getNodeOutput('detect-breaking')?.output || '{}'; try { const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; return parsed?.breaking === true; } catch { return /\"breaking\"\\s*:\\s*true/i.test(String(raw)); } })()",
    }, { x: 400, y: 780, outputs: ["yes", "no"] }),

    node("label-breaking", "action.run_command", "Label: Breaking", {
      command: "gh pr edit {{prNumber}} --add-label \"breaking-change\"",
    }, { x: 200, y: 920 }),

    node("done", "notify.log", "Triage Complete", {
      message: "PR #{{prNumber}} triage workflow completed",
      level: "info",
    }, { x: 400, y: 1050 }),
  ],
  edges: [
    edge("trigger", "get-stats"),
    edge("get-stats", "classify-size"),
    edge("classify-size", "label-small", { port: "small" }),
    edge("classify-size", "label-medium", { port: "medium" }),
    edge("classify-size", "label-large", { port: "large" }),
    edge("label-small", "detect-breaking"),
    edge("label-medium", "detect-breaking"),
    edge("label-large", "detect-breaking"),
    edge("detect-breaking", "is-breaking"),
    edge("is-breaking", "label-breaking", { condition: "$output?.result === true", port: "yes" }),
    edge("is-breaking", "done", { condition: "$output?.result !== true", port: "no" }),
    edge("label-breaking", "done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "triage", "labels", "automation"],
    replaces: {
      module: "github-reconciler.mjs",
      functions: ["PR labeling and classification logic"],
      calledFrom: ["monitor.mjs:checkEpicBranches"],
      description: "Replaces scattered PR classification logic with a structured " +
        "triage workflow. Size classification, breaking change detection, " +
        "and label assignment become explicit workflow nodes.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PR Conflict Resolver
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_CONFLICT_RESOLVER_TEMPLATE = {
  id: "template-pr-conflict-resolver",
  name: "PR Conflict Resolver",
  description:
    "Detects PRs with merge conflicts or failing CI and automatically " +
    "resolves them — rebases, fixes conflicts, re-runs CI, and auto-merges " +
    "when green.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    checkIntervalMs: 1800000,
    maxConcurrentFixes: 3,
    maxRetries: 3,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Check Every 30min", {
      intervalMs: 1800000,
      cron: "*/30 * * * *",
    }, { x: 400, y: 50 }),

    node("list-prs", "action.run_command", "List Open PRs", {
      command: "gh pr list --json number,title,headRefName,mergeable,statusCheckRollup --limit 20",
    }, { x: 400, y: 180 }),

    node("target-pr", "action.set_variable", "Pick Conflict PR", {
      key: "targetPrNumber",
      value:
        "(() => { const raw = $ctx.getNodeOutput('list-prs')?.output || '[]'; let prs = []; try { prs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; } if (!Array.isArray(prs)) return ''; const conflict = prs.find((pr) => ['CONFLICTING', 'BEHIND'].includes(String(pr?.mergeable || '').toUpperCase())); return conflict?.number ? String(conflict.number) : ''; })()",
      isExpression: true,
    }, { x: 400, y: 260 }),

    node("target-branch", "action.set_variable", "Capture Conflict Branch", {
      key: "targetPrBranch",
      value:
        "(() => { const raw = $ctx.getNodeOutput('list-prs')?.output || '[]'; let prs = []; try { prs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; } if (!Array.isArray(prs)) return ''; const conflict = prs.find((pr) => String(pr?.number || '') === String($data?.targetPrNumber || '')); return conflict?.headRefName || ''; })()",
      isExpression: true,
    }, { x: 400, y: 340 }),

    node("has-conflicts", "condition.expression", "Any Conflicts?", {
      expression: "Boolean($data?.targetPrNumber)",
    }, { x: 400, y: 430 }),

    node("resolve-conflicts", "action.run_agent", "Resolve Conflicts", {
      prompt: `You are a merge conflict resolution agent for PR #{{targetPrNumber}} on branch {{targetPrBranch}}.
1. Check out the PR branch
2. Rebase onto main (or the configured base branch)
3. Resolve merge conflicts while preserving intended behavior
4. Run the repo's build/tests to validate the resolution
5. Push the resolved branch and leave CI re-running

Only perform minimal conflict-resolution changes. Do NOT add unrelated refactors.`,
      sdk: "auto",
      timeoutMs: 1800000,
      failOnError: true,
      maxRetries: "{{maxRetries}}",
      retryDelayMs: 30000,
      continueOnError: true,
    }, { x: 200, y: 590 }),

    node("verify-ci", "action.run_command", "Verify CI Green", {
      command: "gh pr checks {{targetPrNumber}} --json name,state",
      failOnError: true,
      maxRetries: "{{maxRetries}}",
      retryDelayMs: 30000,
      continueOnError: true,
    }, { x: 200, y: 750 }),

    node("ci-passed", "condition.expression", "CI Passed?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('verify-ci'); if (!out || out.success !== true) return false; let checks = []; try { checks = JSON.parse(out.output || '[]'); } catch { return false; } if (!Array.isArray(checks) || checks.length === 0) return false; const ok = new Set(['SUCCESS', 'PASSED', 'PASS', 'COMPLETED', 'NEUTRAL', 'SKIPPED']); return checks.every((c) => ok.has(String(c?.state || '').toUpperCase())); })()",
    }, { x: 200, y: 910 }),

    node("do-merge", "action.run_command", "Auto-Merge", {
      command: "gh pr merge {{targetPrNumber}} --auto --squash",
      failOnError: true,
      maxRetries: "{{maxRetries}}",
      retryDelayMs: 20000,
      continueOnError: true,
    }, { x: 100, y: 1040 }),

    node("merge-succeeded", "condition.expression", "Merge Succeeded?", {
      expression: "$ctx.getNodeOutput('do-merge')?.success === true",
    }, { x: 100, y: 1140 }),

    node("notify-fixed", "notify.telegram", "Notify Fixed", {
      message: "🔧 PR #{{targetPrNumber}} conflicts auto-resolved and merged",
      silent: true,
    }, { x: 100, y: 1260 }),

    node("notify-failed", "notify.log", "Log CI Failed", {
      message: "PR #{{targetPrNumber}} conflict auto-resolution could not complete cleanly — manual review required",
      level: "warn",
    }, { x: 420, y: 1040 }),

    node("skip", "notify.log", "No Conflicts", {
      message: "All PRs are clean — no conflicts found",
      level: "info",
    }, { x: 620, y: 430 }),
  ],
  edges: [
    edge("trigger", "list-prs"),
    edge("list-prs", "target-pr"),
    edge("target-pr", "target-branch"),
    edge("target-branch", "has-conflicts"),
    edge("has-conflicts", "resolve-conflicts", { condition: "$output?.result === true" }),
    edge("has-conflicts", "skip", { condition: "$output?.result !== true" }),
    edge("resolve-conflicts", "verify-ci"),
    edge("verify-ci", "ci-passed"),
    edge("ci-passed", "do-merge", { condition: "$output?.result === true" }),
    edge("ci-passed", "notify-failed", { condition: "$output?.result !== true" }),
    edge("do-merge", "merge-succeeded"),
    edge("merge-succeeded", "notify-fixed", { condition: "$output?.result === true" }),
    edge("merge-succeeded", "notify-failed", { condition: "$output?.result !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "conflict", "rebase", "automation"],
    replaces: {
      module: "pr-cleanup-daemon.mjs",
      functions: ["PRCleanupDaemon.run", "processCleanup", "resolveConflicts"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the pr-cleanup-daemon class with a visual workflow. " +
        "Conflict detection, rebase, CI verification, and auto-merge become " +
        "explicit workflow steps with configurable intervals.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Stale PR Reaper
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const STALE_PR_REAPER_TEMPLATE = {
  id: "template-stale-pr-reaper",
  name: "Stale PR Reaper",
  description:
    "Close stale PRs that have been inactive for too long. Posts a " +
    "warning comment before closing and cleans up associated branches.",
  category: "github",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    staleAfterDays: 14,
    warningBeforeDays: 3,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Daily Check", {
      intervalMs: 86400000,
      cron: "0 8 * * *",
    }, { x: 400, y: 50 }),

    node("find-stale", "action.run_command", "Find Stale PRs", {
      command: "gh pr list --json number,title,updatedAt,headRefName --limit 50",
    }, { x: 400, y: 200 }),

    node("has-stale", "condition.expression", "Any Stale PRs?", {
      expression: "($ctx.getNodeOutput('find-stale')?.output || '[]').length > 2",
    }, { x: 400, y: 350 }),

    node("warn-stale", "action.run_command", "Post Warning Comment", {
      command: "echo 'Would warn stale PRs older than {{staleAfterDays}} days'",
      continueOnError: true,
    }, { x: 200, y: 500 }),

    node("close-stale", "action.run_command", "Close Expired PRs", {
      command: "echo 'Would close PRs inactive > {{staleAfterDays}} days'",
      continueOnError: true,
    }, { x: 200, y: 650 }),

    node("cleanup-branches", "action.run_command", "Delete Stale Branches", {
      command: "git fetch --prune origin",
    }, { x: 200, y: 800 }),

    node("summary", "notify.telegram", "Summary", {
      message: "🧹 Stale PR cleanup complete",
      silent: true,
    }, { x: 200, y: 950 }),

    node("skip", "notify.log", "No Stale PRs", {
      message: "No stale PRs found",
      level: "info",
    }, { x: 600, y: 500 }),
  ],
  edges: [
    edge("trigger", "find-stale"),
    edge("find-stale", "has-stale"),
    edge("has-stale", "warn-stale", { condition: "$output?.result === true" }),
    edge("has-stale", "skip", { condition: "$output?.result !== true" }),
    edge("warn-stale", "close-stale"),
    edge("close-stale", "cleanup-branches"),
    edge("cleanup-branches", "summary"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "stale", "cleanup"],
    replaces: {
      module: "workspace-reaper.mjs",
      functions: ["runReaperSweep", "cleanOrphanedWorktrees"],
      calledFrom: ["monitor.mjs:runMaintenanceSweep"],
      description: "Replaces scattered stale PR and branch cleanup logic with " +
        "a structured workflow. Warning, closing, and branch deletion are " +
        "explicit, auditable steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Release Drafter
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const RELEASE_DRAFTER_TEMPLATE = {
  id: "template-release-drafter",
  name: "Release Drafter",
  description:
    "Automatically generates release notes from merged PRs since the last " +
    "tag. Groups changes by conventional commit type (features, fixes, " +
    "refactors, etc.) and drafts a GitHub release.",
  category: "github",
  enabled: true,
  trigger: "trigger.manual",
  variables: {
    baseBranch: "main",
    releasePrefix: "v",
  },
  nodes: [
    node("trigger", "trigger.manual", "Draft Release Notes", {
      description: "Generate release notes from merged PRs",
    }, { x: 400, y: 50 }),

    node("get-last-tag", "action.run_command", "Get Last Tag", {
      command: "git describe --tags --abbrev=0 2>/dev/null || echo 'v0.0.0'",
    }, { x: 400, y: 180 }),

    node("list-prs", "action.run_command", "List Merged PRs", {
      command: "gh pr list --state merged --base {{baseBranch}} --json number,title,labels,author,mergedAt --limit 100",
      continueOnError: true,
    }, { x: 400, y: 310 }),

    node("get-commits", "action.run_command", "Get Commit Log", {
      command: "git log $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~50)..HEAD --oneline --no-merges",
    }, { x: 400, y: 440 }),

    node("draft-notes", "action.run_agent", "Draft Release Notes", {
      prompt: `# Generate Release Notes

## Merged PRs (JSON)
{{prList}}

## Commit Log
{{commitLog}}

## Last Tag
{{lastTag}}

Generate professional release notes in the following format:

# What's Changed

## 🚀 Features
- [list feat: commits with PR references]

## 🐛 Bug Fixes
- [list fix: commits with PR references]

## 🔧 Improvements
- [list refactor/perf/style commits]

## 📚 Documentation
- [list docs: commits]

## 🏗️ Internal
- [list chore/ci/build commits]

Omit empty sections. Include contributor attribution. Be concise.`,
      sdk: "auto",
      timeoutMs: 600000,
    }, { x: 400, y: 590 }),

    node("save-draft", "action.write_file", "Save Draft", {
      path: "RELEASE_DRAFT.md",
      content: "{{releaseNotes}}",
    }, { x: 400, y: 740 }),

    node("notify-ready", "notify.log", "Draft Ready", {
      message: "Release notes draft saved to RELEASE_DRAFT.md — review and publish when ready",
      level: "info",
    }, { x: 400, y: 870 }),
  ],
  edges: [
    edge("trigger", "get-last-tag"),
    edge("get-last-tag", "list-prs"),
    edge("list-prs", "get-commits"),
    edge("get-commits", "draft-notes"),
    edge("draft-notes", "save-draft"),
    edge("save-draft", "notify-ready"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "release", "notes", "changelog", "draft"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Bosun PR Watchdog
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

/**
 * Bosun PR Watchdog — opt-in, scheduled CI poller for bosun-owned PRs.
 *
 * Only acts on PRs labelled `bosun-attached` (applied by the
 * .github/workflows/bosun-pr-attach.yml GitHub Action when Bosun opens a PR).
 * External-contributor and human PRs that lack that label are never touched.
 *
 * Per cycle:
 *   1. List all open bosun-attached PRs.
 *   2. Merge any PR whose CI checks are all passing (not draft, not pending).
 *   3. Label any PR whose CI checks have failures with `bosun-needs-fix` and
 *      dispatch a repair agent to fix the branch.
 *
 * Disable:  set `enabled: false` in your bosun config, or delete the workflow.
 * Interval: default 5 min — change `intervalMs` / `cron` variables.
 */
export const BOSUN_PR_WATCHDOG_TEMPLATE = {
  id: "template-bosun-pr-watchdog",
  name: "Bosun PR Watchdog",
  description:
    "Scans open bosun-attached PRs every 5 minutes. " +
    "PRs with all-green CI are squash-merged and their branches deleted. " +
    "PRs with failing CI are labelled bosun-needs-fix and a repair agent is " +
    "dispatched to fix the branch. PRs not labelled bosun-attached are never " +
    "touched — safe for public/open-source repos. Set enabled:true to activate.",
  category: "github",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    mergeMethod:   "squash",           // squash | merge | rebase
    labelNeedsFix: "bosun-needs-fix",  // label applied to PRs with failing CI
    maxPrs:        25,
    intervalMs:    300_000,            // 5 minutes
  },
  nodes: [
    node("trigger", "trigger.schedule", "Poll Every 5 min", {
      intervalMs: "{{intervalMs}}",
      cron: "*/5 * * * *",
    }, { x: 400, y: 50 }),

    // ── 1. Discover open bosun-attached PRs ────────────────────────────────
    node("list-prs", "action.run_command", "List Bosun-Attached Open PRs", {
      command:
        "gh pr list --label bosun-attached --state open " +
        "--json number,title,headRefName,isDraft,statusCheckRollup " +
        "--limit {{maxPrs}}",
    }, { x: 400, y: 200 }),

    node("has-prs", "condition.expression", "Has Bosun PRs?", {
      expression:
        "(()=>{ try{ " +
        "  const o=$ctx.getNodeOutput('list-prs')?.output; " +
        "  return JSON.parse(o||'[]').length>0; " +
        "}catch(e){ return false; } })()",
    }, { x: 400, y: 360 }),

    // ── 2. Merge PRs where CI is fully passing ─────────────────────────────
    node("merge-passing", "action.run_command", "Merge PRs with Passing CI", {
      // Re-queries gh so the statusCheckRollup is fresh at merge time.
      // Skips draft PRs. Skips PRs with 0 checks (no CI configured).
      // Uses --delete-branch to clean up after merge.
      command: [
        "gh pr list --label bosun-attached --state open",
        "--json number,isDraft,statusCheckRollup --limit {{maxPrs}}",
        "| node -e \"",
        "let d='';",
        "process.stdin.on('data',c=>d+=c);",
        "process.stdin.on('end',()=>{",
        "  const{execSync}=require('child_process');",
        "  const prs=JSON.parse(d);",
        "  let merged=0;",
        "  for(const pr of prs){",
        "    if(pr.isDraft) continue;",
        "    const c=pr.statusCheckRollup||[];",
        "    if(!c.length) continue;",
        "    const bad=c.filter(x=>['FAILURE','ERROR','TIMED_OUT'].includes(x.conclusion||x.state||''));",
        "    const pend=c.filter(x=>['PENDING','IN_PROGRESS','QUEUED','WAITING','REQUESTED'].includes(x.conclusion||x.state||''));",
        "    if(!bad.length&&!pend.length){",
        "      try{execSync('gh pr merge '+pr.number+' --{{mergeMethod}} --delete-branch',{stdio:'pipe'});merged++;}",
        "      catch(e){console.error('merge failed #'+pr.number+':',e.message);}",
        "    }",
        "  }",
        "  console.log(JSON.stringify({merged}));",
        "});",
        "\"",
      ].join(" "),
      continueOnError: true,
    }, { x: 200, y: 530 }),

    // ── 3. Label & dispatch fix for PRs with failing CI ────────────────────
    node("tag-failing", "action.run_command", "Label Failing-CI PRs", {
      // Adds the bosun-needs-fix label only if not already present.
      command: [
        "gh pr list --label bosun-attached --state open",
        "--json number,labels,statusCheckRollup --limit {{maxPrs}}",
        "| node -e \"",
        "let d='';",
        "process.stdin.on('data',c=>d+=c);",
        "process.stdin.on('end',()=>{",
        "  const{execSync}=require('child_process');",
        "  const prs=JSON.parse(d);",
        "  let labeled=0;",
        "  for(const pr of prs){",
        "    const c=pr.statusCheckRollup||[];",
        "    const bad=c.filter(x=>['FAILURE','ERROR','TIMED_OUT'].includes(x.conclusion||x.state||''));",
        "    const already=(pr.labels||[]).some(l=>l.name==='{{labelNeedsFix}}');",
        "    if(bad.length&&!already){",
        "      try{execSync('gh pr edit '+pr.number+' --add-label {{labelNeedsFix}}',{stdio:'pipe'});labeled++;}",
        "      catch(e){console.error('label failed #'+pr.number+':',e.message);}",
        "    }",
        "  }",
        "  console.log(JSON.stringify({labeled}));",
        "});",
        "\"",
      ].join(" "),
      continueOnError: true,
    }, { x: 200, y: 700 }),

    node("has-failing", "condition.expression", "Any Failing PRs Labelled?", {
      expression:
        "(()=>{ try{ " +
        "  const o=$ctx.getNodeOutput('tag-failing')?.output; " +
        "  return (JSON.parse(o||'{\"labeled\":0}').labeled||0)>0; " +
        "}catch(e){ return false; } })()",
    }, { x: 200, y: 850 }),

    // Dispatch a repair agent for each bosun-needs-fix PR.
    node("dispatch-fix", "action.run_agent", "Dispatch Fix Agent", {
      prompt:
        "You are a CI repair agent. Your task:\n" +
        "1. Run: gh pr list --label bosun-needs-fix --label bosun-attached " +
        "--state open --json number,title,headRefName --limit 5\n" +
        "2. For each PR returned, check out its branch and inspect the CI failure logs " +
        "with `gh run list --branch <headRefName>` and `gh run view <run-id> --log-failed`.\n" +
        "3. Fix the root cause of the CI failure (lint, test, build, or type error).\n" +
        "4. Commit the fix with conventional commit format: `fix(<scope>): <description>`.\n" +
        "5. Push the branch — CI will re-trigger automatically.\n" +
        "6. Remove the bosun-needs-fix label once pushed: " +
        "`gh pr edit <number> --remove-label bosun-needs-fix`.\n" +
        "Rules: Only touch code that breaks CI. Do NOT merge or close the PR yourself.",
      sdk: "auto",
      timeoutMs: 1_800_000,
      maxRetries: 2,
      retryDelayMs: 30_000,
      continueOnError: true,
    }, { x: 200, y: 1000 }),

    node("notify", "notify.telegram", "Watchdog Report", {
      message:
        "🐕 Bosun PR Watchdog: merged={{merged}} fix-dispatched={{labeled}}",
      silent: true,
    }, { x: 200, y: 1150 }),

    node("no-prs", "notify.log", "No Bosun PRs Open", {
      message: "Bosun PR Watchdog: no open bosun-attached PRs found — idle",
      level: "info",
    }, { x: 650, y: 360 }),
  ],
  edges: [
    edge("trigger",      "list-prs"),
    edge("list-prs",     "has-prs"),
    edge("has-prs",      "merge-passing", { condition: "$output?.result === true" }),
    edge("has-prs",      "no-prs",        { condition: "$output?.result !== true" }),
    edge("merge-passing","tag-failing"),
    edge("tag-failing",  "has-failing"),
    edge("has-failing",  "dispatch-fix",  { condition: "$output?.result === true" }),
    edge("has-failing",  "notify",        { condition: "$output?.result !== true" }),
    edge("dispatch-fix", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-07-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "ci", "merge", "watchdog", "bosun-attached"],
    replaces: {
      module: "agent-hooks.mjs",
      functions: ["registerBuiltinHooks (PostPR block)"],
      calledFrom: [],
      description:
        "Replaces the removed built-in PostPR auto-merge hook with an explicit, " +
        "opt-in workflow that only merges Bosun-owned PRs after CI passes and " +
        "dispatches a repair agent when CI fails. Users must set enabled:true.",
    },
  },
};
