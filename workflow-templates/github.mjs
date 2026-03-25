/**
 * github.mjs — GitHub-related workflow templates.
 *
 * Templates:
 *   - PR Merge Strategy (recommended)
 *   - PR Triage & Labels (recommended)
 *   - PR Conflict Resolver (superseded by Watchdog)
 *   - Stale PR Reaper (recommended)
 *   - Release Drafter
 *   - Bosun PR Watchdog (recommended — replaces pr-cleanup-daemon.mjs)
 *   - GitHub ↔ Kanban Sync (recommended — replaces github-reconciler.mjs)
 *   - SDK Conflict Resolver (recommended — replaces sdk-conflict-resolver.mjs)
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
    requireBosunCreatedPr: true,
  },
  nodes: [
    node("trigger", "trigger.pr_event", "PR Ready for Merge Decision", {
      event: "review_requested",
      events: ["review_requested", "approved", "opened"],
    }, { x: 400, y: 50 }),

    node("load-pr-context", "action.run_command", "Load PR Context", {
      command: "gh pr view {{prNumber}} --json body,author,title,labels",
    }, { x: 400, y: 140 }),

    node("automation-eligible", "condition.expression", "Bosun-Created PR?", {
      expression:
        "(() => { if ($data?.requireBosunCreatedPr !== true && String($data?.requireBosunCreatedPr || '').toLowerCase() !== 'true') return true; const raw = $ctx.getNodeOutput('load-pr-context')?.output || '{}'; let pr = {}; try { pr = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return false; } const labels = Array.isArray(pr?.labels) ? pr.labels.map((entry) => typeof entry === 'string' ? entry : entry?.name).filter(Boolean) : []; return labels.includes('bosun-pr-bosun-created'); })()",
    }, { x: 400, y: 230, outputs: ["yes", "no"] }),

    node("check-ci", "validation.build", "Check CI Status", {
      command: "gh pr checks {{prNumber}} --json name,state",
    }, { x: 150, y: 320 }),

    node("get-diff", "action.run_command", "Get Diff Stats", {
      command: "git diff --stat {{baseBranch}}...HEAD",
    }, { x: 650, y: 320 }),

    node("ci-passed", "condition.expression", "CI Passed?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('check-ci'); if (!out || out.passed !== true) return false; let checks = []; try { checks = JSON.parse(out.output || '[]'); } catch { return false; } if (!Array.isArray(checks) || checks.length === 0) return false; const ok = new Set(['SUCCESS', 'PASSED', 'PASS', 'COMPLETED', 'NEUTRAL', 'SKIPPED']); return checks.every((c) => ok.has(String(c?.state || '').toUpperCase())); })()",
    }, { x: 150, y: 470, outputs: ["yes", "no"] }),

    node("wait-for-ci", "action.delay", "Wait for CI", {
      ms: "{{ciTimeoutMs}}",
      seconds: "{{cooldownSec}}",
      reason: "CI is still running",
    }, { x: 150, y: 620 }),

    node("skip-untrusted-pr", "notify.log", "Skip Non-Bosun PR", {
      message: "PR Merge Strategy: skipping PR #{{prNumber}} because it is attached but not Bosun-created",
      level: "info",
    }, { x: 730, y: 230 }),

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
      command: "gh pr merge {{prNumber}} --auto --merge",
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
      message: ":eye: PR #{{prNumber}} needs manual review: {{decision.reason}}",
    }, { x: 900, y: 680 }),

    node("action-succeeded", "condition.expression", "Action Succeeded?", {
      expression:
        "(() => { const action = String($data?.decision?.action || '').trim().toLowerCase(); if (action === 'merge_after_ci_pass') return $ctx.getNodeOutput('do-merge')?.success === true; if (action === 'prompt') return $ctx.getNodeOutput('do-prompt')?.success === true; if (action === 'close_pr') return $ctx.getNodeOutput('do-close')?.success === true; if (action === 're_attempt') return $ctx.getNodeOutput('do-retry')?.success === true; if (action === 'manual_review') return $ctx.getNodeOutput('do-escalate')?.sent !== false; return true; })()",
    }, { x: 480, y: 770, outputs: ["yes", "no"] }),

    node("notify-action-failed", "notify.telegram", "Escalate Action Failure", {
      message:
        ":alert: PR #{{prNumber}} workflow action failed after retries ({{decision.action}}). " +
        "Reason: {{decision.reason}}. Manual follow-up required.",
    }, { x: 760, y: 850 }),

    node("notify-complete", "notify.log", "Log Result", {
      message: "PR #{{prNumber}} merge strategy: {{decision.action}} — {{decision.reason}}",
      level: "info",
    }, { x: 400, y: 850 }),

    node("end", "flow.end", "End Merge Strategy", {
      status: "completed",
      message: "PR merge strategy flow completed for PR #{{prNumber}}",
      output: {
        prNumber: "{{prNumber}}",
        action: "{{decision.action}}",
      },
    }, { x: 400, y: 950 }),
  ],
  edges: [
    edge("trigger", "load-pr-context"),
    edge("load-pr-context", "automation-eligible"),
    edge("automation-eligible", "check-ci", { condition: "$output?.result === true", port: "yes" }),
    edge("automation-eligible", "get-diff", { condition: "$output?.result === true", port: "yes" }),
    edge("automation-eligible", "skip-untrusted-pr", { condition: "$output?.result !== true", port: "no" }),
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
    edge("notify-complete", "end"),
    edge("skip-untrusted-pr", "end"),
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
  recommended: true,
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

    node("detect-breaking", "condition.expression", "Detect Breaking Changes", {
      expression:
        "(() => {" +
        "  const raw=$ctx.getNodeOutput('get-stats')?.output||'{}';" +
        "  let stats={};" +
        "  try{stats=typeof raw==='string'?JSON.parse(raw):raw;}catch{return false;}" +
        "  const title=String(stats?.title||'').toLowerCase();" +
        "  const body=String(stats?.body||'').toLowerCase();" +
        "  const files=Array.isArray(stats?.files)?stats.files.map((f)=>String(f?.path||f?.filename||f||'').toLowerCase()):[];" +
        "  const text=title+'\\n'+body;" +
        "  const explicit=/\\bbreaking\\b|\\bbreaking change\\b|\\bmajor\\b|\\bbackward incompatible\\b/.test(text);" +
        "  const apiTouch=files.some((f)=>f.includes('api/')||f.includes('/proto/')||f.includes('openapi')||f.includes('schema'));" +
        "  const contractWords=/\\bremove\\b|\\brename\\b|\\bdeprecate\\b|\\bdrop\\b/.test(text);" +
        "  return explicit || (apiTouch && contractWords);" +
        "})()",
    }, { x: 400, y: 630 }),

    node("is-breaking", "condition.expression", "Breaking?", {
      expression:
        "(() => { return $ctx.getNodeOutput('detect-breaking')?.result === true; })()",
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
    ":alert: SUPERSEDED for bosun-managed repos — use the Bosun PR Watchdog " +
    "(template-bosun-pr-watchdog) instead. The Watchdog consolidates conflict " +
    "resolution, CI-failure repair, diff-safety review, and merge into one " +
    "cycle with a single gh API call and a mandatory review gate before any merge. " +
    "This template is kept for repos that do not use the assistive bosun-attached label " +
    "convention. It only touches Bosun-created PRs and never " +
    "auto-merges directly — it resolves conflicts and then defers to the " +
    "Watchdog's review gate for the actual merge decision.",
  category: "github",
  enabled: false,
  recommended: false,
  trigger: "trigger.schedule",
  variables: {
    checkIntervalMs: 1800000,
    maxConcurrentFixes: 3,
    maxRetries: 3,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Check Every 30min", {
      intervalMs: "{{checkIntervalMs}}",
      cron: "*/30 * * * *",
    }, { x: 400, y: 50 }),

    // Fetch all open PRs and narrow to Bosun-created provenance.
    // Includes labels so we can skip PRs already tagged bosun-needs-fix (watchdog owns those).
    node("list-prs", "action.run_command", "List Bosun-Created Conflicting PRs", {
      command:
        "gh pr list --state open " +
        "--json number,title,body,headRefName,baseRefName,mergeable,labels --limit {{maxConcurrentFixes}}",
    }, { x: 400, y: 180 }),

    node("target-pr", "action.set_variable", "Pick Conflict PR", {
      key: "targetPrNumber",
      value:
        "(() => {" +
        "  const raw = $ctx.getNodeOutput('list-prs')?.output || '[]';" +
        "  let prs = [];" +
        "  try { prs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }" +
        "  if (!Array.isArray(prs)) return '';" +
        "  const CONFLICT = new Set(['CONFLICTING', 'BEHIND', 'DIRTY']);" +
        "  const BOSUN_CREATED_LABEL = 'bosun-pr-bosun-created';" +
        "  const readLabelNames = (pr) => Array.isArray(pr?.labels) ? pr.labels.map((entry) => typeof entry === 'string' ? entry : entry?.name).filter(Boolean) : [];" +
        "  const isBosunCreated = (pr) => readLabelNames(pr).includes(BOSUN_CREATED_LABEL);" +
        "  /* Skip PRs already owned by the watchdog fix agent */" +
        "  const pr = prs.find((p) =>" +
        "    isBosunCreated(p) &&" +
        "    CONFLICT.has(String(p?.mergeable || '').toUpperCase()) &&" +
        "    !(p.labels || []).some((l) => l.name === 'bosun-needs-fix')" +
        "  );" +
        "  return pr?.number ? String(pr.number) : '';" +
        "})()",
      isExpression: true,
    }, { x: 400, y: 260 }),

    node("target-branch", "action.set_variable", "Capture Conflict Branch", {
      key: "targetPrBranch",
      value:
        "(() => {" +
        "  const raw = $ctx.getNodeOutput('list-prs')?.output || '[]';" +
        "  let prs = [];" +
        "  try { prs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }" +
        "  if (!Array.isArray(prs)) return '';" +
        "  const pr = prs.find((p) => String(p?.number || '') === String($data?.targetPrNumber || ''));" +
        "  return pr?.headRefName || '';" +
        "})()",
      isExpression: true,
    }, { x: 400, y: 340 }),

    node("target-base", "action.set_variable", "Capture Base Branch", {
      key: "targetPrBase",
      value:
        "(() => {" +
        "  const raw = $ctx.getNodeOutput('list-prs')?.output || '[]';" +
        "  let prs = [];" +
        "  try { prs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return 'main'; }" +
        "  if (!Array.isArray(prs)) return 'main';" +
        "  const pr = prs.find((p) => String(p?.number || '') === String($data?.targetPrNumber || ''));" +
        "  return pr?.baseRefName || 'main';" +
        "})()",
      isExpression: true,
    }, { x: 400, y: 420 }),

    node("has-conflicts", "condition.expression", "Any Conflicts?", {
      expression: "Boolean($data?.targetPrNumber)",
    }, { x: 400, y: 510 }),

    // Label the PR so the watchdog knows it is being worked on
    node("label-fixing", "action.run_command", "Label bosun-needs-fix", {
      command: "gh pr edit {{targetPrNumber}} --add-label bosun-needs-fix",
      continueOnError: true,
    }, { x: 200, y: 650 }),

    node("resolve-conflicts", "action.run_agent", "Resolve Conflicts", {
      prompt:
        "You are a merge conflict resolution agent for PR #{{targetPrNumber}} " +
        "on branch {{targetPrBranch}} (base: {{targetPrBase}}).\n\n" +
        "Steps:\n" +
        "1. git fetch origin\n" +
        "2. git checkout {{targetPrBranch}}\n" +
        "3. git rebase origin/{{targetPrBase}}   (fall back to merge if rebase is too complex)\n" +
        "4. Resolve all merge conflicts, preserving the intent of both sides.\n" +
        "5. Run the repo's build and test suite to confirm nothing is broken.\n" +
        "6. git push --force-with-lease origin {{targetPrBranch}}\n" +
        "7. Remove the bosun-needs-fix label: gh pr edit {{targetPrNumber}} --remove-label bosun-needs-fix\n\n" +
        "Rules:\n" +
        "- Only make minimal conflict-resolution changes. No unrelated refactors.\n" +
        "- Do NOT merge, close, or approve the PR — the Bosun PR Watchdog handles merging.\n" +
        "- Do NOT touch PRs that are not Bosun-created.",
      sdk: "auto",
      timeoutMs: 1800000,
      failOnError: true,
      maxRetries: "{{maxRetries}}",
      retryDelayMs: 30000,
      continueOnError: true,
    }, { x: 200, y: 800 }),

    node("notify-fixed", "notify.telegram", "Notify Resolved", {
      message: ":settings: PR #{{targetPrNumber}} conflict resolved — awaiting CI and Watchdog review before merge",
      silent: true,
    }, { x: 200, y: 960 }),

    node("notify-failed", "notify.log", "Log Resolution Failed", {
      message: "PR #{{targetPrNumber}} conflict could not be resolved cleanly — manual review required",
      level: "warn",
    }, { x: 450, y: 800 }),

    node("skip", "notify.log", "No Conflicts", {
      message: "PR Conflict Resolver: no unhandled Bosun-created conflicts found",
      level: "info",
    }, { x: 620, y: 510 }),
  ],
  edges: [
    edge("trigger",           "list-prs"),
    edge("list-prs",          "target-pr"),
    edge("target-pr",         "target-branch"),
    edge("target-branch",     "target-base"),
    edge("target-base",       "has-conflicts"),
    edge("has-conflicts",     "label-fixing",       { condition: "$output?.result === true" }),
    edge("has-conflicts",     "skip",               { condition: "$output?.result !== true" }),
    edge("label-fixing",      "resolve-conflicts"),
    edge("resolve-conflicts", "notify-fixed",       { condition: "$ctx.getNodeOutput('resolve-conflicts')?.success === true" }),
    edge("resolve-conflicts", "notify-failed",      { condition: "$ctx.getNodeOutput('resolve-conflicts')?.success !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 2,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "2.0.0",
    tags: ["github", "pr", "conflict", "rebase", "automation", "bosun-attached"],
    replaces: {
      module: "pr-cleanup-daemon.mjs",
      functions: ["PRCleanupDaemon.run", "processCleanup", "resolveConflicts"],
      calledFrom: ["monitor.mjs:startProcess"],
      description:
        "v2: Restricted to Bosun-created PRs only — never touches external-contributor PRs. " +
        "Removed direct auto-merge: this template now only resolves the conflict and pushes; " +
        "the Bosun PR Watchdog (template-bosun-pr-watchdog) owns the merge decision with its " +
        "diff-safety review gate. Skips PRs already tagged bosun-needs-fix (watchdog owns those). " +
        "Labels PR with bosun-needs-fix during resolution so watchdog knows it is in-flight.",
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
  enabled: true,
  recommended: true,
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
      command: "node -e \"const {execFileSync}=require('child_process');const stale=Number('{{staleAfterDays}}')||14;const warn=Number('{{warningBeforeDays}}')||3;const now=Date.now();const prs=JSON.parse(execFileSync('gh',['pr','list','--state','open','--json','number,updatedAt,labels','--limit','100'],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim()||'[]');let n=0;for(const pr of prs){const age=(now-new Date(pr.updatedAt))/864e5;if(age>=(stale-warn)&&age<stale){const lbl=(pr.labels||[]).some(l=>(typeof l==='string'?l:l?.name)==='stale-warning');if(!lbl){try{execFileSync('gh',['pr','comment',String(pr.number),'--body','\\u26a0\\ufe0f This PR has been inactive for '+Math.floor(age)+' day(s) and will be closed in '+Math.ceil(stale-age)+' day(s). Please update or close it if no longer needed.'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});execFileSync('gh',['pr','edit',String(pr.number),'--add-label','stale-warning'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});n++;}catch(e){}}}}console.log('Warned '+n+' PR(s).');\"",
      continueOnError: true,
    }, { x: 200, y: 500 }),

    node("close-stale", "action.run_command", "Close Expired PRs", {
      command: "node -e \"const {execFileSync}=require('child_process');const stale=Number('{{staleAfterDays}}')||14;const now=Date.now();const prs=JSON.parse(execFileSync('gh',['pr','list','--state','open','--json','number,title,updatedAt,headRefName','--limit','100'],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim()||'[]');let n=0;for(const pr of prs){const age=(now-new Date(pr.updatedAt))/864e5;if(age>=stale){try{execFileSync('gh',['pr','close',String(pr.number),'--comment','Automatically closed: inactive for '+Math.floor(age)+' days (threshold: '+stale+' days).','--delete-branch'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});n++;}catch(e){process.stderr.write('close #'+pr.number+': '+(e?.message||e)+'\\n');}}}console.log('Closed '+n+' stale PR(s).');\"",
      continueOnError: true,
    }, { x: 200, y: 650 }),

    node("cleanup-branches", "action.run_command", "Delete Stale Branches", {
      command: "git fetch --prune origin",
    }, { x: 200, y: 800 }),

    node("prune-worktrees", "action.run_command", "Prune Git Worktrees", {
      command: "git worktree prune --expire 7.days.ago 2>/dev/null && echo 'Worktree prune complete.' || echo 'Worktree prune skipped (not a git repo).'",
      continueOnError: true,
    }, { x: 200, y: 950 }),

    node("summary", "notify.telegram", "Summary", {
      message: ":trash: Stale PR cleanup complete",
      silent: true,
    }, { x: 200, y: 1100 }),

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
    edge("cleanup-branches", "prune-worktrees"),
    edge("prune-worktrees", "summary"),
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
      description:
        "Replaces workspace-reaper.mjs stale PR / orphaned worktree cleanup and " +
        "the pr-cleanup-daemon.mjs temporary worktree remnants. Warning, closing, " +
        "branch deletion, and worktree pruning are explicit, auditable steps.",
      also: ["pr-cleanup-daemon.mjs (temp worktree cleanup)"],
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
      command: "git describe --tags --abbrev=0 2>/dev/null || echo '{{releasePrefix}}0.0.0'",
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

## :rocket: Features
- [list feat: commits with PR references]

## :bug: Bug Fixes
- [list fix: commits with PR references]

## :settings: Improvements
- [list refactor/perf/style commits]

## :u1f4da: Documentation
- [list docs: commits]

## :hammer: Internal
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
//  Bosun PR Progressor
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const BOSUN_PR_PROGRESSOR_TEMPLATE = {
  id: "template-bosun-pr-progressor",
  name: "Bosun PR Progressor",
  description:
    "Direct per-PR progression workflow for bosun-managed tasks. Runs immediately " +
    "after PR handoff, evaluates a single PR, retries simple CI failures, " +
    "dispatches focused repair when needed, and performs the first merge-review pass " +
    "without waiting for the periodic watchdog.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.workflow_call",
  variables: {
    mergeMethod: "merge",
    labelNeedsFix: "bosun-needs-fix",
    labelNeedsReview: "bosun-needs-human-review",
    suspiciousDeletionRatio: 3,
    minDestructiveDeletions: 500,
  },
  nodes: [
    node("trigger", "trigger.workflow_call", "PR Handoff", {
      inputs: {
        taskId: { type: "string", required: false },
        taskTitle: { type: "string", required: false },
        branch: { type: "string", required: false },
        baseBranch: { type: "string", required: false, default: "main" },
        prNumber: { type: "number", required: false },
        prUrl: { type: "string", required: false },
        repo: { type: "string", required: false },
      },
    }, { x: 400, y: 50 }),

    node("normalize-context", "action.set_variable", "Normalize PR Context", {
      key: "prProgressContext",
      value:
        "(() => {" +
        "  const prOut = $ctx.getNodeOutput('create-pr') || $ctx.getNodeOutput('create-pr-retry') || {};" +
        "  const prUrl = String($data?.prUrl || prOut?.prUrl || prOut?.url || '').trim();" +
        "  const repoMatch = prUrl.match(/github\\.com\\/([^/]+\\/[^/?#]+)/i);" +
        "  const repo = String($data?.repo || (repoMatch ? repoMatch[1] : '')).trim();" +
        "  const rawPrNumber = $data?.prNumber ?? prOut?.prNumber ?? null;" +
        "  const parsedPrNumber = Number.parseInt(String(rawPrNumber || ''), 10);" +
        "  return {" +
        "    taskId: String($data?.taskId || '').trim() || null," +
        "    taskTitle: String($data?.taskTitle || '').trim() || null," +
        "    repo: repo || null," +
        "    branch: String($data?.branch || prOut?.branch || '').trim() || null," +
        "    baseBranch: String($data?.baseBranch || prOut?.base || 'main').trim() || 'main'," +
        "    prNumber: Number.isFinite(parsedPrNumber) && parsedPrNumber > 0 ? parsedPrNumber : null," +
        "    prUrl: prUrl || null," +
        "  };" +
        "})()",
      isExpression: true,
    }, { x: 400, y: 180 }),

    node("has-pr-target", "condition.expression", "Has PR Target?", {
      expression:
        "Boolean($data?.prProgressContext?.prNumber && ($data?.prProgressContext?.repo || $data?.prProgressContext?.prUrl))",
    }, { x: 400, y: 300 }),

    node("inspect-pr", "action.run_command", "Inspect Single PR", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const ctx=(()=>{try{return JSON.parse(String(process.env.BOSUN_PR_CONTEXT||'{}'))}catch{return {}}})();",
        "const repo=String(ctx.repo||'').trim();",
        "const branch=String(ctx.branch||'').trim();",
        "const baseBranch=String(ctx.baseBranch||'main').trim()||'main';",
        "const rawNumber=String(ctx.prNumber||'').trim();",
        "const prNumber=Number.parseInt(rawNumber,10);",
        "if(!repo||!Number.isFinite(prNumber)||prNumber<=0){",
        "  console.log(JSON.stringify({success:false,classification:'missing',reason:'missing_repo_or_pr',repo,prNumber:Number.isFinite(prNumber)?prNumber:null,branch,baseBranch}));",
        "  process.exit(0);",
        "}",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function safeGhJson(args,fallback){try{const out=gh(args);return out?JSON.parse(out):fallback;}catch{return fallback;}}",
        "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
        "function compactUser(user){const login=String(user?.login||user?.name||'').trim();return login?{login,url:String(user?.url||user?.html_url||'').trim()||null}:null;}",
        "function compactCheck(check){const name=String(check?.name||check?.context||check?.workflowName||'').trim();const state=String(check?.state||check?.conclusion||'').toUpperCase();const bucket=String(check?.bucket||'').toUpperCase();if(!name&&!state&&!bucket)return null;return {name:name||null,state:state||null,bucket:bucket||null,workflow:String(check?.workflowName||'').trim()||null};}",
        "function compactIssueComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,updatedAt:String(comment?.updated_at||comment?.updatedAt||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactReview(review){return {id:Number(review?.id||0)||null,author:compactUser(review?.user||review?.author),state:String(review?.state||'').trim()||null,submittedAt:String(review?.submitted_at||review?.submittedAt||'').trim()||null,commitId:String(review?.commit_id||review?.commitId||'').trim()||null,body:truncateText(review?.body,1200)};}",
        "function compactReviewComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),path:String(comment?.path||'').trim()||null,line:Number(comment?.line||0)||Number(comment?.original_line||0)||null,startLine:Number(comment?.start_line||0)||null,side:String(comment?.side||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactFile(file){const path=String(file?.filename||file?.path||'').trim();return path?{path,status:String(file?.status||'').trim()||null,additions:Number(file?.additions||0)||0,deletions:Number(file?.deletions||0)||0,changes:Number(file?.changes||0)||0}:null;}",
        "function collectPrDigest(fallback){",
        "  const pr=safeGhJson(['pr','view',String(prNumber),'--repo',repo,'--json','number,title,body,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,author,labels,reviewDecision'],{});",
        "  const issueComments=safeGhJson(['api','repos/'+repo+'/issues/'+prNumber+'/comments?per_page=100'],[]).map(compactIssueComment).slice(0,40);",
        "  const reviews=safeGhJson(['api','repos/'+repo+'/pulls/'+prNumber+'/reviews?per_page=100'],[]).map(compactReview).slice(0,40);",
        "  const reviewComments=safeGhJson(['api','repos/'+repo+'/pulls/'+prNumber+'/comments?per_page=100'],[]).map(compactReviewComment).slice(0,60);",
        "  const files=safeGhJson(['api','repos/'+repo+'/pulls/'+prNumber+'/files?per_page=100'],[]).map(compactFile).filter(Boolean).slice(0,80);",
        "  const requested=safeGhJson(['api','repos/'+repo+'/pulls/'+prNumber+'/requested_reviewers'],{});",
        "  const requestedReviewers=[...(Array.isArray(requested?.users)?requested.users:[]).map(compactUser),...(Array.isArray(requested?.teams)?requested.teams:[]).map((team)=>{const slug=String(team?.slug||team?.name||'').trim();return slug?{team:slug,url:String(team?.html_url||team?.url||'').trim()||null}:null;})].filter(Boolean);",
        "  const checks=(Array.isArray(pr.statusCheckRollup)?pr.statusCheckRollup:[]).map(compactCheck).filter(Boolean);",
        "  const labels=(Array.isArray(pr.labels)?pr.labels:[]).map((label)=>String(label?.name||label||'').trim()).filter(Boolean);",
        "  const passingChecks=checks.filter((check)=>check.state==='SUCCESS' || check.bucket==='PASS');",
        "  const failingChecks=checks.filter((check)=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(check.state)||check.bucket==='FAIL');",
        "  const pendingChecks=checks.filter((check)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(check.state));",
        "  const digestSummary=[",
        "    'PR #'+String(pr?.number||prNumber)+' '+String(pr?.title||fallback?.taskTitle||''),",
        "    'repo='+repo+' branch='+(String(pr?.headRefName||branch||'').trim()||'unknown')+' base='+(String(pr?.baseRefName||baseBranch||'main').trim()||'main'),",
        "    'mergeable='+(String(pr?.mergeable||'').trim()||'unknown')+' reviewDecision='+(String(pr?.reviewDecision||'').trim()||'none'),",
        "    'checks='+checks.length+' pass='+passingChecks.length+' fail='+failingChecks.length+' pending='+pendingChecks.length,",
        "    'comments='+issueComments.length+' reviews='+reviews.length+' reviewComments='+reviewComments.length+' files='+files.length,",
        "    labels.length?'labels='+labels.join(', '):'',",
        "  ].filter(Boolean).join('\\n');",
        "  return {core:{number:Number(pr?.number||prNumber)||prNumber,title:String(pr?.title||fallback?.taskTitle||''),url:String(pr?.url||ctx.prUrl||fallback?.prUrl||'').trim()||null,body:truncateText(pr?.body,4000),branch:String(pr?.headRefName||branch||'').trim()||null,baseBranch:String(pr?.baseRefName||baseBranch||'main').trim()||'main',isDraft:pr?.isDraft===true,mergeable:String(pr?.mergeable||'').trim()||null,author:compactUser(pr?.author),reviewDecision:String(pr?.reviewDecision||'').trim()||null},labels,requestedReviewers,checks,ciSummary:{total:checks.length,passing:passingChecks.length,failing:failingChecks.length,pending:pendingChecks.length},issueComments,reviews,reviewComments,files,digestSummary};",
        "}",
        "const prDigest=collectPrDigest(ctx||{});",
        "const pr=prDigest.core||{};",
        "const checks=Array.isArray(prDigest.checks)?prDigest.checks:[];",
        "const failStates=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const pendingStates=new Set(['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED']);",
        "const conflictMergeables=new Set(['CONFLICTING','DIRTY','UNKNOWN']);",
        "const failedCheckNames=checks.filter((c)=>{const s=String(c?.state||'').toUpperCase();const b=String(c?.bucket||'').toUpperCase();return failStates.has(s)||b==='FAIL';}).map((c)=>String(c?.name||'').trim()).filter(Boolean);",
        "const hasFailure=checks.some((c)=>{const s=String(c?.state||'').toUpperCase();const b=String(c?.bucket||'').toUpperCase();return failStates.has(s)||b==='FAIL';});",
        "const hasPending=checks.some((c)=>pendingStates.has(String(c?.state||'').toUpperCase()));",
        "let classification='ready';",
        "let reason='ready_for_review';",
        "let ciKicked=false;",
        "if(pr?.isDraft===true){classification='draft';reason='draft_pr';}",
        "else if(conflictMergeables.has(String(pr?.mergeable||'').toUpperCase())){classification='conflict';reason='merge_conflict';}",
        "else if(hasFailure){classification='ci_failure';reason='ci_failed';}",
        "else if(hasPending){classification='pending';reason='ci_pending';}",
        "else if(checks.length===0 && branch){",
        "  try{gh(['workflow','run','ci.yaml','--repo',repo,'--ref',branch]);ciKicked=true;classification='pending';reason='ci_kicked';}",
        "  catch{classification='ready';reason='ready_without_checks';}",
        "}",
        "console.log(JSON.stringify({success:true,repo,prNumber,url:String(pr?.url||ctx.prUrl||''),branch:String(pr?.branch||branch||''),baseBranch:String(pr?.baseBranch||baseBranch||'main'),title:String(pr?.title||ctx.taskTitle||''),mergeable:String(pr?.mergeable||''),reviewDecision:String(pr?.reviewDecision||'').trim()||null,labels:Array.isArray(prDigest.labels)?prDigest.labels:[],classification,reason,ciKicked,hasFailure,hasPending,failedCheckNames,checks,ciSummary:prDigest.ciSummary||null,prDigest,digestSummary:String(prDigest.digestSummary||'')}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_PR_CONTEXT:
          "{{$data?.prProgressContext ? JSON.stringify($data.prProgressContext) : '{}'}}",
      },
    }, { x: 400, y: 430 }),

    node("fix-needed", "condition.expression", "Needs Repair?", {
      expression:
        "(()=>{try{" +
        "const d=JSON.parse($ctx.getNodeOutput('inspect-pr')?.output||'{}');" +
        "return d?.classification==='ci_failure' || d?.classification==='conflict';" +
        "}catch{return false;}})()",
    }, { x: 220, y: 560 }),

    node("programmatic-fix", "action.run_command", "Repair Attempt", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const data=(()=>{try{return JSON.parse(String(process.env.BOSUN_PR_INSPECT||'{}'))}catch{return {}}})();",
        "const repo=String(data.repo||'').trim();",
        "const branch=String(data.branch||'').trim();",
        "const prNumber=Number.parseInt(String(data.prNumber||''),10);",
        "const classification=String(data.classification||'').trim();",
        "const failedCheckNames=Array.isArray(data.failedCheckNames)?data.failedCheckNames:[];",
        "const labelFix=String('{{labelNeedsFix}}'||'bosun-needs-fix');",
        "const FAIL_STATES=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const MAX_AUTO_RERUN_ATTEMPT=1;",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function normalizeRun(run){if(!run||typeof run!=='object')return null;return {databaseId:Number(run.databaseId||0)||null,attempt:Number(run.attempt||0)||0,conclusion:String(run.conclusion||''),status:String(run.status||''),workflowName:String(run.workflowName||run.name||''),displayTitle:String(run.displayTitle||run.name||''),url:String(run.url||''),createdAt:String(run.createdAt||''),updatedAt:String(run.updatedAt||'')}}",
        "function normalizeJob(job){if(!job||typeof job!=='object')return null;const steps=Array.isArray(job.steps)?job.steps:[];return {databaseId:Number(job.databaseId||0)||null,name:String(job.name||''),status:String(job.status||''),conclusion:String(job.conclusion||''),url:String(job.url||''),failedSteps:steps.filter((step)=>FAIL_STATES.has(String(step?.conclusion||step?.status||'').toUpperCase())).map((step)=>({name:String(step?.name||''),number:Number(step?.number||0)||null,status:String(step?.status||''),conclusion:String(step?.conclusion||'')})).filter((step)=>step.name).slice(0,10)}}",
        "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
        "function collectCiDiagnostics(run){const info={failedRun:normalizeRun(run),failedJobs:[],failedLogExcerpt:'',diagnosticsError:''};const runId=Number(run?.databaseId||0)||0;if(!runId)return info;try{const viewRaw=gh(['run','view',String(runId),'--repo',repo,'--json','attempt,conclusion,status,workflowName,displayTitle,url,createdAt,updatedAt,jobs']);const view=(()=>{try{return JSON.parse(viewRaw||'{}')}catch{return {}}})();info.failedRun=normalizeRun({...run,...view});const jobs=Array.isArray(view.jobs)?view.jobs:[];info.failedJobs=jobs.map(normalizeJob).filter((job)=>job&&(FAIL_STATES.has(String(job.conclusion||'').toUpperCase())||job.failedSteps.length>0)).slice(0,10);}catch(e){info.diagnosticsError=String(e?.message||e);}try{info.failedLogExcerpt=truncateText(gh(['run','view',String(runId),'--repo',repo,'--log-failed']),6000);}catch(e){const message=String(e?.message||e);if(message&&message!==info.diagnosticsError){info.diagnosticsError=info.diagnosticsError?info.diagnosticsError+' | '+message:message;}}return info;}",
        "if(repo&&Number.isFinite(prNumber)&&prNumber>0){",
        "  try{gh(['pr','edit',String(prNumber),'--repo',repo,'--add-label',labelFix]);}catch{}",
        "}",
        "if(classification==='ci_failure'&&repo&&branch){",
        "  try{",
        "    const listRaw=gh(['run','list','--repo',repo,'--branch',branch,'--json','databaseId,attempt,conclusion,status,workflowName,displayTitle,url,createdAt,updatedAt','--limit','8']);",
        "    const runs=(()=>{try{return JSON.parse(listRaw||'[]')}catch{return []}})();",
        "    const failed=(Array.isArray(runs)?runs:[]).find((r)=>FAIL_STATES.has(String(r?.conclusion||'').toUpperCase()));",
        "    const failedRun=normalizeRun(failed);",
        "    if(failedRun?.databaseId&&failedRun.attempt<=MAX_AUTO_RERUN_ATTEMPT){gh(['run','rerun',String(failedRun.databaseId),'--repo',repo]);console.log(JSON.stringify({success:true,rerunRequested:true,needsAgent:false,reason:'rerun_requested',failedCheckNames,failedRun}));process.exit(0);}",
        "    if(failedRun?.databaseId){const diagnostics=collectCiDiagnostics(failedRun);console.log(JSON.stringify({success:false,rerunRequested:false,needsAgent:true,reason:'auto_rerun_limit_reached',failedCheckNames,rerunAttempts:failedRun.attempt||0,...diagnostics}));process.exit(0);}",
        "    console.log(JSON.stringify({success:false,rerunRequested:false,needsAgent:true,reason:'no_rerunnable_failed_run_found',failedCheckNames,recentRuns:(Array.isArray(runs)?runs:[]).map(normalizeRun).filter(Boolean).slice(0,5)}));",
        "    process.exit(0);",
        "  }catch(e){",
        "    console.log(JSON.stringify({success:false,rerunRequested:false,needsAgent:true,reason:'ci_rerun_failed',failedCheckNames,error:String(e?.message||e)}));",
        "    process.exit(0);",
        "  }",
        "}",
        "if(classification==='conflict'&&repo&&Number.isFinite(prNumber)&&prNumber>0){",
        "  const mergeable=String(data.mergeable||'').toUpperCase();",
        "  if(mergeable==='BEHIND'){",
        "    try{",
        "      const headSha=JSON.parse(gh(['pr','view',String(prNumber),'--repo',repo,'--json','headRefOid'])).headRefOid;",
        "      gh(['api','-X','PUT','repos/'+repo+'/pulls/'+prNumber+'/update-branch','--field','expected_head_sha='+headSha]);",
        "      console.log(JSON.stringify({success:true,branchUpdated:true,needsAgent:false,reason:'branch_updated_from_base',mergeable}));",
        "      process.exit(0);",
        "    }catch(e){",
        "      console.log(JSON.stringify({success:false,needsAgent:true,reason:'branch_update_failed',mergeable,error:String(e?.message||e)}));",
        "      process.exit(0);",
        "    }",
        "  }",
        "}",
        "console.log(JSON.stringify({success:false,rerunRequested:false,needsAgent:true,reason:classification==='conflict'?'merge_conflict_requires_code_resolution':'repair_required',failedCheckNames}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_PR_INSPECT:
          "{{$ctx.getNodeOutput('inspect-pr')?.output || '{}'}}",
      },
    }, { x: 220, y: 690 }),

    node("fix-agent-needed", "condition.expression", "Needs Fix Agent?", {
      expression:
        "(()=>{try{" +
        "const d=JSON.parse($ctx.getNodeOutput('programmatic-fix')?.output||'{}');" +
        "return d?.needsAgent===true;" +
        "}catch{return false;}})()",
    }, { x: 220, y: 820 }),

    node("dispatch-fix-agent", "action.run_agent", "Dispatch Focused Fix Agent", {
      prompt:
        "You are a Bosun PR repair fallback agent working one PR only.\n\n" +
        "PR context:\n{{$ctx.getNodeOutput('inspect-pr')?.output}}\n\n" +
        "Repair attempt output:\n{{$ctx.getNodeOutput('programmatic-fix')?.output}}\n\n" +
        "Use prDigest.body, prDigest.files, prDigest.issueComments, prDigest.reviews, prDigest.reviewComments, prDigest.checks, and any failedLogExcerpt before making changes.\n\n" +
        "Rules:\n" +
        "- Only fix this PR's CI or merge-conflict issue.\n" +
        "- Do not merge, approve, or close the PR.\n" +
        "- Keep the patch minimal and scoped to the reported failure.\n" +
        "- If you repair the PR, remove the bosun-needs-fix label.\n",
      sdk: "auto",
      timeoutMs: 1_800_000,
      maxRetries: 2,
      retryDelayMs: 30_000,
      continueOnError: true,
    }, { x: 220, y: 950 }),

    node("review-needed", "condition.expression", "Ready For Review?", {
      expression:
        "(()=>{try{" +
        "const d=JSON.parse($ctx.getNodeOutput('inspect-pr')?.output||'{}');" +
        "return d?.classification==='ready';" +
        "}catch{return false;}})()",
    }, { x: 620, y: 560 }),

    node("programmatic-review", "action.run_command", "Review Gate: Merge Single PR", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const pr=(()=>{try{return JSON.parse(String(process.env.BOSUN_PR_INSPECT||'{}'))}catch{return {}}})();",
        "const repo=String(pr.repo||'').trim();",
        "const n=String(pr.prNumber||'').trim();",
        "const ratio=Number('{{suspiciousDeletionRatio}}')||3;",
        "const minDel=Number('{{minDestructiveDeletions}}')||500;",
        "const labelReview=String('{{labelNeedsReview}}'||'bosun-needs-human-review');",
        "const method=String('{{mergeMethod}}'||'merge').toLowerCase();",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "if(!repo||!n){console.log(JSON.stringify({mergedCount:0,heldCount:0,skippedCount:1,skipped:[{repo,number:n,reason:'missing_repo_or_pr'}]}));process.exit(0);}",
        "try{",
        "  const viewRaw=gh(['pr','view',n,'--repo',repo,'--json','number,title,additions,deletions,changedFiles,isDraft']);",
        "  const view=(()=>{try{return JSON.parse(viewRaw||'{}')}catch{return {}}})();",
        "  if(view?.isDraft===true){console.log(JSON.stringify({mergedCount:0,heldCount:0,skippedCount:1,skipped:[{repo,number:n,reason:'draft'}]}));process.exit(0);}",
        "  const add=Number(view?.additions||0);",
        "  const del=Number(view?.deletions||0);",
        "  const changed=Number(view?.changedFiles||0);",
        "  const destructive=(del>(add*ratio))&&(del>minDel);",
        "  const tooWide=changed>250;",
        "  if(destructive||tooWide){",
        "    gh(['pr','edit',n,'--repo',repo,'--add-label',labelReview]);",
        "    gh(['pr','comment',n,'--repo',repo,'--body',':warning: Bosun held this PR for human review due to suspicious diff footprint.']);",
        "    console.log(JSON.stringify({mergedCount:0,heldCount:1,skippedCount:0,held:[{repo,number:n,reason:destructive?'destructive_diff':'changed_files_too_large',additions:add,deletions:del,changedFiles:changed}]}));",
        "    process.exit(0);",
        "  }",
        "  const checksRaw=gh(['pr','checks',n,'--repo',repo,'--json','name,state,bucket']);",
        "  const checks=(()=>{try{return JSON.parse(checksRaw||'[]')}catch{return []}})();",
        "  const hasFailure=(Array.isArray(checks)?checks:[]).some((x)=>{const s=String(x?.state||'').toUpperCase();const b=String(x?.bucket||'').toUpperCase();return ['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(s)||b==='FAIL';});",
        "  const hasPending=(Array.isArray(checks)?checks:[]).some((x)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(String(x?.state||'').toUpperCase()));",
        "  if(hasFailure){console.log(JSON.stringify({mergedCount:0,heldCount:0,skippedCount:1,skipped:[{repo,number:n,reason:'ci_failed'}]}));process.exit(0);}",
        "  if(hasPending){console.log(JSON.stringify({mergedCount:0,heldCount:0,skippedCount:1,skipped:[{repo,number:n,reason:'ci_pending'}]}));process.exit(0);}",
        "  const mergeArgs=['pr','merge',n,'--repo',repo,'--delete-branch'];",
        "  if(method==='rebase') mergeArgs.push('--rebase');",
        "  else if(method==='merge') mergeArgs.push('--merge');",
        "  else mergeArgs.push('--squash');",
        "  try{gh(mergeArgs);}catch(directErr){mergeArgs.push('--auto');gh(mergeArgs);}",
        "  console.log(JSON.stringify({mergedCount:1,heldCount:0,skippedCount:0,merged:[{repo,number:n,title:String(view?.title||'')}] }));",
        "}catch(e){",
        "  console.log(JSON.stringify({mergedCount:0,heldCount:1,skippedCount:0,held:[{repo,number:n,reason:'merge_attempt_failed',error:String(e?.message||e)}]}));",
        "}",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_PR_INSPECT:
          "{{$ctx.getNodeOutput('inspect-pr')?.output || '{}'}}",
      },
    }, { x: 620, y: 690 }),

    node("log-deferred", "notify.log", "Deferred", {
      message:
        "Bosun PR Progressor deferred PR #{{prProgressContext.prNumber}}: {{$ctx.getNodeOutput('inspect-pr')?.output || '{}'}}",
      level: "info",
    }, { x: 620, y: 820 }),

    node("log-missing", "notify.log", "Missing PR Context", {
      message: "Bosun PR Progressor skipped: missing PR context for task {{taskId}}",
      level: "warn",
    }, { x: 400, y: 560 }),

    node("notify-complete", "notify.log", "Log Outcome", {
      message:
        "Bosun PR Progressor finished for task {{taskId}} / PR {{prProgressContext.prNumber}}",
      level: "info",
    }, { x: 400, y: 1090 }),
  ],
  edges: [
    edge("trigger", "normalize-context"),
    edge("normalize-context", "has-pr-target"),
    edge("has-pr-target", "inspect-pr", { condition: "$output?.result === true" }),
    edge("has-pr-target", "log-missing", { condition: "$output?.result !== true" }),
    edge("inspect-pr", "fix-needed"),
    edge("fix-needed", "programmatic-fix", { condition: "$output?.result === true" }),
    edge("fix-needed", "review-needed", { condition: "$output?.result !== true" }),
    edge("programmatic-fix", "fix-agent-needed"),
    edge("fix-agent-needed", "dispatch-fix-agent", { condition: "$output?.result === true" }),
    edge("fix-agent-needed", "notify-complete", { condition: "$output?.result !== true" }),
    edge("dispatch-fix-agent", "notify-complete"),
    edge("review-needed", "programmatic-review", { condition: "$output?.result === true" }),
    edge("review-needed", "log-deferred", { condition: "$output?.result !== true" }),
    edge("programmatic-review", "notify-complete"),
    edge("log-deferred", "notify-complete"),
    edge("log-missing", "notify-complete"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-13T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "handoff", "progression", "event-driven"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Bosun PR Watchdog
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

/**
 * Bosun PR Watchdog — opt-in, scheduled CI poller for Bosun-created PRs.
 *
 * Uses `bosun-attached` as the low-trust observation marker, but defaults all
 * high-risk actions to PRs with Bosun-created provenance in the PR body.
 * Human-authored PRs are only included when the operator explicitly trusts
 * their login in `prAutomation.trustedAuthors` and enables the relevant mode.
 *
 * Per cycle:
 *   1. List all open bosun-attached PRs.
 *   2. Merge any PR whose CI checks are all passing (not draft, not pending).
 *   3. Label any PR whose CI checks have failures with `bosun-needs-fix` and
 *      dispatch a repair agent to fix the branch.
 *   4. Route CodeQL/code-scanning failures through a dedicated security repair
 *      branch so security findings are fixed instead of treated as generic CI.
 *
 * Disable:  set `enabled: false` in your bosun config, or delete the workflow.
 * Interval: default 90s — change `intervalMs`.
 */
export const BOSUN_PR_WATCHDOG_TEMPLATE = {
  id: "template-bosun-pr-watchdog",
  name: "Bosun PR Watchdog",
  description:
    "Scans open bosun-attached PRs on a schedule. Makes one gh pr list call " +
    "per target repo to fetch and classify PRs, then: labels conflicting or failing-CI PRs " +
    "with bosun-needs-fix and dispatches a repair agent; sends merge candidates " +
    "through a MANDATORY agent review gate that checks diff stats before any " +
    "merge — preventing destructive PRs (e.g. -183k lines) from being silently " +
    "auto-merged. Attached PRs that are not Bosun-created are skipped by default unless explicitly trusted in config.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    mergeMethod:        "merge",                    // merge | squash | rebase
    labelNeedsFix:      "bosun-needs-fix",           // applied to CI failures and conflicts
    labelNeedsReview:   "bosun-needs-human-review",  // applied when review agent flags a suspicious diff
    // auto: active workspace repos from bosun.config.json (fallback current repo)
    // all/current/<owner/repo>/comma,list also supported.
    repoScope:          "auto",
    maxPrs:             25,
    intervalMs:         90_000,                     // 90 seconds
    // Merge-safety thresholds checked by the review agent:
    // If net deletions > additions × ratio AND deletions > minDestructiveDeletions → HOLD
    suspiciousDeletionRatio: 3,    // e.g. deletes 3× more lines than it adds
    minDestructiveDeletions: 500,  // absolute floor — small PRs are fine even if net negative
    autoApplySuggestions:   true,  // auto-commit review suggestions before merge
    trustedAuthors:         "",
    allowTrustedFixes:      false,
    allowTrustedMerges:     false,
    delegationWatchdogTimeoutMs: 300000,
    delegationWatchdogMaxRecoveries: 1,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Poll Every 90s", {
      intervalMs: "{{intervalMs}}",
    }, { x: 400, y: 50 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: One gh pr list per target repo, then classify+label in-memory.
    // This avoids duplicate fetches and keeps per-cycle gh traffic bounded.
    // ─────────────────────────────────────────────────────────────────────────
    node("fetch-and-classify", "action.run_command", "Fetch, Classify & Label PRs", {
      // Fetches all open bosun-attached PRs with every field needed for
      // classification. Runs one list call per target repo (auto-discovered
      // from bosun.config.json workspaces by default), then:
      //   • Classifies each PR into: ready | conflict | security_failure | ci_failure | pending | draft
      //   • Labels conflict/security_failure/ci_failure PRs with bosun-needs-fix (skips if already present)
      //   • Outputs a JSON summary used by all downstream nodes/agents
      // Total gh API calls this node makes: R list calls + N edits
      // (R = target repos, N = newly-broken PRs needing fix label).
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const {execFileSync}=require('child_process');",
        "const LABEL_FIX='{{labelNeedsFix}}';",
        "const MAX_PRS=Math.max(1,Number('{{maxPrs}}')||25);",
        "const REPO_SCOPE=String('{{repoScope}}'||'auto').trim();",
        "const FIELDS='number,title,body,author,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,labels,url';",
        "const FAIL_STATES=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const PEND_STATES=new Set(['PENDING','IN_PROGRESS','QUEUED','WAITING','REQUESTED','EXPECTED']);",
        "const CONFLICT_MERGEABLES=new Set(['CONFLICTING','DIRTY']);",
        "const BEHIND_MERGEABLES=new Set(['BEHIND']);",
        "const SECURITY_CHECK_RE=/(^|[^a-z])(codeql|code scanning|security|sarif|codacy)([^a-z]|$)/i;",
        "const BOSUN_CREATED_LABEL='bosun-pr-bosun-created';",
        "function readCheckName(check){return String(check?.name||check?.context||check?.workflowName||check?.displayTitle||'').trim();}",
        "function isFailedCheck(check){return FAIL_STATES.has(check?.conclusion||check?.state||'');}",
        "function isSecurityCheckName(name){return SECURITY_CHECK_RE.test(String(name||''));}",
        "function ghJson(args){const out=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();return out?JSON.parse(out):[];}",
        "function normalizeList(value){if(Array.isArray(value)) return value.map((entry)=>String(entry||'').trim().toLowerCase()).filter(Boolean); return String(value||'').split(',').map((entry)=>entry.trim().toLowerCase()).filter(Boolean);}",
        "function parseBool(value,fallback){if(value===undefined||value===null||value==='') return fallback; const raw=String(value).trim().toLowerCase(); if(['1','true','yes','on'].includes(raw)) return true; if(['0','false','no','off'].includes(raw)) return false; return fallback;}",
        "function matchesCheckPattern(name,pattern){const text=String(name||'').trim().toLowerCase();const token=String(pattern||'').trim().toLowerCase();if(!text||!token)return false;if(token==='*')return true;if(!token.includes('*'))return text.includes(token);const parts=token.split('*').filter(Boolean);if(parts.length===0)return true;let cursor=0;for(const part of parts){const idx=text.indexOf(part,cursor);if(idx===-1)return false;cursor=idx+part.length;}if(!token.startsWith('*')&&!text.startsWith(parts[0]||''))return false;if(!token.endsWith('*')&&!text.endsWith(parts[parts.length-1]||''))return false;return true;}",
        "function matchesAnyPattern(name,patterns){return (Array.isArray(patterns)?patterns:[]).some((pattern)=>matchesCheckPattern(name,pattern));}",
        "function readCheckState(check){return String(check?.conclusion||check?.state||check?.status||check?.bucket||'').trim().toUpperCase();}",
        "function isPassingCheckState(state,treatNeutralAsPass){if(!state)return true;if(['SUCCESS','PASS','PASSED','COMPLETED'].includes(state))return true;if(treatNeutralAsPass&&['NEUTRAL','SKIPPED'].includes(state))return true;return !FAIL_STATES.has(state)&&!PEND_STATES.has(state);}",
        "function evaluateCheckGates(checks,policy){const normalized=(Array.isArray(checks)?checks:[]).map((check)=>({raw:check,name:readCheckName(check),state:readCheckState(check)})).filter((check)=>check.name);const considered=normalized.filter((check)=>!matchesAnyPattern(check.name,policy.ignorePatterns));let required=considered;if(policy.mode==='required-only'){required=considered.filter((check)=>matchesAnyPattern(check.name,policy.requiredPatterns));}if((Array.isArray(policy.optionalPatterns)?policy.optionalPatterns:[]).length>0){required=required.filter((check)=>!matchesAnyPattern(check.name,policy.optionalPatterns));}const missingRequired=policy.requireAnyRequiredCheck&&required.length===0;const failedRequiredChecks=required.filter((check)=>FAIL_STATES.has(check.state));const pendingRequiredChecks=required.filter((check)=>PEND_STATES.has(check.state));const hasRequiredFailure=failedRequiredChecks.length>0;const hasBlockingPending=policy.treatPendingRequiredAsBlocking&&pendingRequiredChecks.length>0;const isReady=!missingRequired&&!hasRequiredFailure&&!hasBlockingPending&&required.every((check)=>isPassingCheckState(check.state,policy.treatNeutralAsPass));return {consideredCount:considered.length,requiredCount:required.length,failedRequiredChecks:failedRequiredChecks.map((check)=>check.raw),pendingRequiredChecks:pendingRequiredChecks.map((check)=>check.raw),hasRequiredFailure,hasBlockingPending,blocksForMissingRequired:missingRequired,isReady,shouldKickCi:considered.length===0};}",
        "function readLabelNames(pr){return Array.isArray(pr?.labels)?pr.labels.map((entry)=>typeof entry==='string'?entry:entry?.name).filter(Boolean):[];}",
        "function isBosunCreated(pr){return readLabelNames(pr).includes(BOSUN_CREATED_LABEL);}",
        "function readAuthorLogin(pr){return String(pr?.author?.login||pr?.author?.name||'').trim().toLowerCase();}",
        "function configPath(){",
        "  const home=String(process.env.BOSUN_HOME||process.env.BOSUN_PROJECT_DIR||'').trim();",
        "  return home?path.join(home,'bosun.config.json'):path.join(process.cwd(),'bosun.config.json');",
        "}",
        "function readBosunConfig(){ try { return JSON.parse(fs.readFileSync(configPath(),'utf8')); } catch { return {}; } }",
        "function collectReposFromConfig(){",
        "  const repos=[];",
        "  try{",
        "    const cfg=readBosunConfig();",
        "    const workspaces=Array.isArray(cfg?.workspaces)?cfg.workspaces:[];",
        "    if(workspaces.length>0){",
        "      const active=String(cfg?.activeWorkspace||'').trim().toLowerCase();",
        "      const activeWs=active?workspaces.find(w=>String(w?.id||'').trim().toLowerCase()===active):null;",
        "      const wsList=activeWs?[activeWs]:workspaces;",
        "      for(const ws of wsList){",
        "        for(const repo of (Array.isArray(ws?.repos)?ws.repos:[])){",
        "          const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();",
        "          if(slug) repos.push(slug);",
        "        }",
        "      }",
        "    }",
        "    if(repos.length===0){",
        "      for(const repo of (Array.isArray(cfg?.repos)?cfg.repos:[])){",
        "        const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();",
        "        if(slug) repos.push(slug);",
        "      }",
        "    }",
        "  }catch{}",
        "  return repos;",
        "}",
        "function resolveRepoTargets(){",
        "  if(REPO_SCOPE&&REPO_SCOPE!=='auto'&&REPO_SCOPE!=='all'&&REPO_SCOPE!=='current'){",
        "    return [...new Set(REPO_SCOPE.split(',').map(v=>v.trim()).filter(Boolean))];",
        "  }",
        "  if(REPO_SCOPE==='current') return [''];",
        "  const fromConfig=collectReposFromConfig();",
        "  if(fromConfig.length>0) return [...new Set(fromConfig)];",
        "  const envRepo=String(process.env.GITHUB_REPOSITORY||'').trim();",
        "  if(envRepo) return [envRepo];",
        "  return [''];",
        "}",
        "const BOSUN_CONFIG=readBosunConfig();",
        "const PR_AUTOMATION=(BOSUN_CONFIG&&typeof BOSUN_CONFIG.prAutomation==='object')?BOSUN_CONFIG.prAutomation:{};",
        "const ATTACH_MODE=((String(PR_AUTOMATION?.attachMode||'all').trim().toLowerCase())||'all');",
        "const TRUSTED_AUTHORS=new Set([...normalizeList(PR_AUTOMATION?.trustedAuthors),...normalizeList('{{trustedAuthors}}')]);",
        "const ALLOW_TRUSTED_FIXES=parseBool(PR_AUTOMATION?.allowTrustedFixes ?? '{{allowTrustedFixes}}', false);",
        "const ALLOW_TRUSTED_MERGES=parseBool(PR_AUTOMATION?.allowTrustedMerges ?? '{{allowTrustedMerges}}', false);",
        "const CHECK_GATES=(BOSUN_CONFIG&&typeof BOSUN_CONFIG.gates==='object'&&BOSUN_CONFIG.gates&&typeof BOSUN_CONFIG.gates.checks==='object')?BOSUN_CONFIG.gates.checks:{};",
        "const CHECK_MODE=((String(CHECK_GATES?.mode||'all').trim().toLowerCase())||'all');",
        "const REQUIRED_CHECK_PATTERNS=normalizeList(CHECK_GATES?.requiredPatterns);",
        "const OPTIONAL_CHECK_PATTERNS=normalizeList(CHECK_GATES?.optionalPatterns);",
        "const IGNORE_CHECK_PATTERNS=normalizeList(CHECK_GATES?.ignorePatterns);",
        "const REQUIRE_ANY_REQUIRED_CHECK=parseBool(CHECK_GATES?.requireAnyRequiredCheck, true);",
        "const TREAT_PENDING_REQUIRED_AS_BLOCKING=parseBool(CHECK_GATES?.treatPendingRequiredAsBlocking, true);",
        "const TREAT_NEUTRAL_AS_PASS=parseBool(CHECK_GATES?.treatNeutralAsPass, false);",
        "function parseRepoFromUrl(url){",
        "  const raw=String(url||'');",
        "  const marker='github.com/';",
        "  const idx=raw.toLowerCase().indexOf(marker);",
        "  if(idx<0) return '';",
        "  const tail=raw.slice(idx+marker.length).split('/');",
        "  if(tail.length<2) return '';",
        "  const owner=String(tail[0]||'').trim();",
        "  const repo=String(tail[1]||'').trim();",
        "  return owner&&repo?(owner+'/'+repo):'';",
        "}",
        "const repoTargets=resolveRepoTargets();",
        "const prs=[];",
        "const repoErrors=[];",
        "for(const target of repoTargets){",
        "  const repo=String(target||'').trim();",
        "  const args=['pr','list','--state','open','--json',FIELDS,'--limit',String(MAX_PRS)];",
        "  if(repo) args.push('--repo',repo);",
        "  try{",
        "    const list=ghJson(args);",
        "    for(const pr of (Array.isArray(list)?list:[])){",
        "      const prRepo=repo||parseRepoFromUrl(pr?.url)||String(process.env.GITHUB_REPOSITORY||'').trim();",
        "      prs.push({...pr,__repo:prRepo});",
        "    }",
        "  }catch(e){",
        "    repoErrors.push({repo:repo||'current',error:String(e?.message||e)});",
        "  }",
        "}",
        "const readyCandidates=[],conflicts=[],securityFailures=[],ciFailures=[],pending=[],drafted=[],behindBranches=[],skippedUntrusted=[];",
        "let newlyLabeled=0,staleLabelCleared=0,ciKicked=0;",
        "for(const pr of prs){",
        "  const labels=(pr.labels||[]).map(l=>typeof l==='string'?l:l?.name).filter(Boolean);",
        "  const bosunCreated=isBosunCreated(pr);",
        "  const trustedAuthor=TRUSTED_AUTHORS.has(readAuthorLogin(pr));",
        "  const attachEligible=bosunCreated || ATTACH_MODE==='all' || (ATTACH_MODE==='trusted-only' && trustedAuthor);",
        "  const canFix=bosunCreated || (attachEligible && ALLOW_TRUSTED_FIXES && trustedAuthor);",
        "  const canMerge=bosunCreated || (attachEligible && ALLOW_TRUSTED_MERGES && trustedAuthor);",
        "  const hasFixLabel=labels.includes(LABEL_FIX);",
        "  const checks=pr.statusCheckRollup||[];",
        "  const gateVerdict=evaluateCheckGates(checks,{mode:CHECK_MODE,requiredPatterns:REQUIRED_CHECK_PATTERNS,optionalPatterns:OPTIONAL_CHECK_PATTERNS,ignorePatterns:IGNORE_CHECK_PATTERNS,requireAnyRequiredCheck:REQUIRE_ANY_REQUIRED_CHECK,treatPendingRequiredAsBlocking:TREAT_PENDING_REQUIRED_AS_BLOCKING,treatNeutralAsPass:TREAT_NEUTRAL_AS_PASS});",
        "  const failedChecks=gateVerdict.failedRequiredChecks;",
        "  const failedCheckNames=failedChecks.map(readCheckName).filter(Boolean);",
        "  const securityCheckNames=failedCheckNames.filter(isSecurityCheckName);",
        "  const hasFail=gateVerdict.hasRequiredFailure;",
        "  const hasSecurityFail=securityCheckNames.length>0;",
        "  const hasPend=gateVerdict.hasBlockingPending;",
        "  const isConflict=CONFLICT_MERGEABLES.has(String(pr.mergeable||'').toUpperCase());",
        "  const isBehind=BEHIND_MERGEABLES.has(String(pr.mergeable||'').toUpperCase());",
        "  const isDraft=pr.isDraft===true;",
        "  const repo=String(pr.__repo||'').trim();",
        "  if(isDraft){drafted.push({n:pr.number,repo});continue;}",
        "  if(!bosunCreated && !attachEligible){skippedUntrusted.push({n:pr.number,repo,reason:'attach_policy_excluded'});continue;}",
        "  if(!bosunCreated && !trustedAuthor){skippedUntrusted.push({n:pr.number,repo,reason:'public_observation_only'});continue;}",
        "  if(isBehind&&!isConflict){",
        "    if(canFix) behindBranches.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url});",
        "  }",
        "  if(isConflict){",
        "    if(!canFix){skippedUntrusted.push({n:pr.number,repo,reason:'fix_not_allowed'});continue;}",
        "    conflicts.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url,mergeable:String(pr.mergeable||'').toUpperCase()});",
        "    if(!hasFixLabel){",
        "      try{const editArgs=['pr','edit',String(pr.number),'--add-label',LABEL_FIX];if(repo)editArgs.push('--repo',repo);execFileSync('gh',editArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});newlyLabeled++;}",
        "      catch(e){process.stderr.write('label err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\\\n');}",
        "    }",
        "  } else if(hasSecurityFail){",
        "    if(!canFix){skippedUntrusted.push({n:pr.number,repo,reason:'security_fix_not_allowed'});continue;}",
        "    securityFailures.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url,title:pr.title,failedCheckNames,securityCheckNames});",
        "    if(!hasFixLabel){",
        "      try{const editArgs=['pr','edit',String(pr.number),'--add-label',LABEL_FIX];if(repo)editArgs.push('--repo',repo);execFileSync('gh',editArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});newlyLabeled++;}",
        "      catch(e){process.stderr.write('label err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\n');}",
        "    }",
        "  } else if(hasFail){",
        "    if(!canFix){skippedUntrusted.push({n:pr.number,repo,reason:'ci_fix_not_allowed'});continue;}",
        "    ciFailures.push({n:pr.number,repo,branch:pr.headRefName,url:pr.url,failedCheckNames});",
        "    if(!hasFixLabel){",
        "      try{const editArgs=['pr','edit',String(pr.number),'--add-label',LABEL_FIX];if(repo)editArgs.push('--repo',repo);execFileSync('gh',editArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});newlyLabeled++;}",
        "      catch(e){process.stderr.write('label err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\\\n');}",
        "    }",
        "  } else {",
        "    if(hasFixLabel&&!hasPend&&!gateVerdict.blocksForMissingRequired){",
        "      try{",
        "        const rmArgs=['pr','edit',String(pr.number),'--remove-label',LABEL_FIX];",
        "        if(repo)rmArgs.push('--repo',repo);",
        "        execFileSync('gh',rmArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});",
        "        staleLabelCleared++;",
        "      }catch(e){process.stderr.write('stale-label-rm err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\\\n');}",
        "    } else if(gateVerdict.isReady&&!hasFixLabel){",
        "      if(hasPend) pending.push({n:pr.number,repo});",
        "      if(canMerge){ readyCandidates.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url,title:pr.title,pendingChecks:hasPend}); } else { skippedUntrusted.push({n:pr.number,repo,reason:'merge_not_allowed'}); }",
        "    }",
        "    if(gateVerdict.shouldKickCi&&repo&&pr.headRefName&&!isDraft){",
        "      try{execFileSync('gh',['workflow','run','ci.yaml','--repo',repo,'--ref',pr.headRefName],{encoding:'utf8',stdio:['pipe','pipe','pipe']});ciKicked++;}",
        "      catch{}",
        "    }",
        "  }",
        "}",
        "console.log(JSON.stringify({",
        "  total:prs.length,",
        "  reposScanned:repoTargets.length,",
        "  repoErrors,",
        "  readyCandidates,",
        "  conflicts,",
        "  behindBranches,",
        "  securityFailures,",
        "  ciFailures,",
        "  pending:pending.length,",
        "  drafted:drafted.length,",
        "  skippedUntrusted,",
        "  newlyLabeled,",
        "  staleLabelCleared,",
        "  ciKicked,",
        "  fixNeeded:conflicts.length+securityFailures.length+ciFailures.length,",
        "  trustPolicy:{trustedAuthors:[...TRUSTED_AUTHORS],allowTrustedFixes:ALLOW_TRUSTED_FIXES,allowTrustedMerges:ALLOW_TRUSTED_MERGES}",
        "}));",
      ].join(" ")],
      continueOnError: false,
      failOnError: true,
    }, { x: 400, y: 200 }),

    node("has-prs", "condition.expression", "Any Bosun PRs?", {
      expression:
        "(()=>{try{" +
        "const r=$ctx.getNodeOutput('fetch-and-classify');" +
        "if(!r||r.success===false)return false;" +
        "const o=r.output;" +
        "return (JSON.parse(o||'{}').total||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 400, y: 370 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1b: Fast-path — update behind branches (no conflicts, just out-of-date)
    // ─────────────────────────────────────────────────────────────────────────
    node("has-behind", "condition.expression", "Behind Branches?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').behindBranches||[]).length>0;" +
        "}catch(e){return false;}})()",
    }, { x: 400, y: 450 }),

    node("update-behind-branches", "action.run_command", "Update Behind Branches", {
      command: [
        "node -e \"",
        "const {execFileSync}=require('child_process');",
        "const raw=String(process.env.BOSUN_FETCH_AND_CLASSIFY||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const behind=Array.isArray(payload.behindBranches)?payload.behindBranches:[];",
        "let updated=0,failed=0;",
        "for(const pr of behind){",
        "  const repo=String(pr.repo||'').trim();",
        "  if(!repo){console.log('skip PR '+pr.n+' — no repo slug');continue;}",
        "  try{",
        "    execFileSync('gh',['api','repos/'+repo+'/pulls/'+pr.n+'/update-branch','--method','PUT'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});",
        "    updated++;",
        "    console.log('Updated PR #'+pr.n+' ('+repo+')');",
        "  }catch(e){",
        "    failed++;",
        "    console.log('Failed to update PR #'+pr.n+' ('+repo+'): '+String(e.message||e).slice(0,200));",
        "  }",
        "}",
        "console.log(JSON.stringify({updated,failed,total:behind.length}));",
        "\"",
      ].join(" "),
      continueOnError: true,
      failOnError: false,
      timeout: 120000,
      env: {
        BOSUN_FETCH_AND_CLASSIFY:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    }, { x: 600, y: 450 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2a: Fix path — route security failures separately, then dispatch
    // the generic agent path for conflicts + non-security CI failures.
    // ─────────────────────────────────────────────────────────────────────────
    node("fix-needed", "condition.expression", "Fix Needed?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').fixNeeded||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 200, y: 530 }),

    node("security-fix-needed", "condition.expression", "Security Fix Needed?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').securityFailures||[]).length>0;" +
        "}catch(e){return false;}})()",
    }, { x: 120, y: 640 }),

    node("programmatic-security-fix", "action.run_command", "Collect Security Alerts", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const raw=String(process.env.BOSUN_FETCH_AND_CLASSIFY||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const securityFailures=Array.isArray(payload.securityFailures)?payload.securityFailures:[];",
        "const needsAgent=[];",
        "let alertsFetched=0;",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function safeGhJson(args,fallback){try{const out=gh(args);return out?JSON.parse(out):fallback;}catch{return fallback;}}",
        "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
        "function compactUser(user){const login=String(user?.login||user?.name||'').trim();return login?{login,url:String(user?.url||user?.html_url||'').trim()||null}:null;}",
        "function compactCheck(check){const name=String(check?.name||check?.context||check?.workflowName||'').trim();const state=String(check?.state||check?.conclusion||'').toUpperCase();const bucket=String(check?.bucket||'').toUpperCase();if(!name&&!state&&!bucket)return null;return {name:name||null,state:state||null,bucket:bucket||null,workflow:String(check?.workflowName||'').trim()||null};}",
        "function compactIssueComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactReview(review){return {id:Number(review?.id||0)||null,author:compactUser(review?.user||review?.author),state:String(review?.state||'').trim()||null,submittedAt:String(review?.submitted_at||review?.submittedAt||'').trim()||null,body:truncateText(review?.body,1200)};}",
        "function compactReviewComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),path:String(comment?.path||'').trim()||null,line:Number(comment?.line||0)||Number(comment?.original_line||0)||null,side:String(comment?.side||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactFile(file){const path=String(file?.filename||file?.path||'').trim();return path?{path,status:String(file?.status||'').trim()||null,additions:Number(file?.additions||0)||0,deletions:Number(file?.deletions||0)||0,changes:Number(file?.changes||0)||0}:null;}",
        "function collectPrDigest(repo,number,fallback){const pr=safeGhJson(['pr','view',String(number),'--repo',repo,'--json','number,title,body,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,author,labels,reviewDecision'],{});const issueComments=safeGhJson(['api','repos/'+repo+'/issues/'+number+'/comments?per_page=100'],[]).map(compactIssueComment).slice(0,40);const reviews=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/reviews?per_page=100'],[]).map(compactReview).slice(0,40);const reviewComments=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/comments?per_page=100'],[]).map(compactReviewComment).slice(0,60);const files=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/files?per_page=100'],[]).map(compactFile).filter(Boolean).slice(0,80);const requested=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/requested_reviewers'],{});const requestedReviewers=[...(Array.isArray(requested?.users)?requested.users:[]).map(compactUser),...(Array.isArray(requested?.teams)?requested.teams:[]).map((team)=>{const slug=String(team?.slug||team?.name||'').trim();return slug?{team:slug,url:String(team?.html_url||team?.url||'').trim()||null}:null;})].filter(Boolean);const checks=(Array.isArray(pr.statusCheckRollup)?pr.statusCheckRollup:[]).map(compactCheck).filter(Boolean);const labels=(Array.isArray(pr.labels)?pr.labels:[]).map((label)=>String(label?.name||label||'').trim()).filter(Boolean);const failingChecks=checks.filter((check)=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(check.state)||check.bucket==='FAIL');const pendingChecks=checks.filter((check)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(check.state));const digestSummary=['PR #'+String(pr?.number||number)+' '+String(pr?.title||fallback?.title||''),'repo='+repo+' branch='+(String(pr?.headRefName||fallback?.branch||'').trim()||'unknown'),'checks='+checks.length+' fail='+failingChecks.length+' pending='+pendingChecks.length,'comments='+issueComments.length+' reviews='+reviews.length+' reviewComments='+reviewComments.length+' files='+files.length,labels.length?'labels='+labels.join(', '):''].filter(Boolean).join('\\n');return {core:{number:Number(pr?.number||number)||number,title:String(pr?.title||fallback?.title||''),url:String(pr?.url||fallback?.url||'').trim()||null,body:truncateText(pr?.body,4000),branch:String(pr?.headRefName||fallback?.branch||'').trim()||null,baseBranch:String(pr?.baseRefName||fallback?.base||'').trim()||null,isDraft:pr?.isDraft===true,mergeable:String(pr?.mergeable||'').trim()||null,author:compactUser(pr?.author),reviewDecision:String(pr?.reviewDecision||'').trim()||null},labels,requestedReviewers,checks,ciSummary:{total:checks.length,failing:failingChecks.length,pending:pendingChecks.length,passing:Math.max(0,checks.length-failingChecks.length-pendingChecks.length)},issueComments,reviews,reviewComments,files,digestSummary};}",
        "function compactAlert(alert){",
        "  const instance=alert?.most_recent_instance||{};",
        "  const location=instance?.location||{};",
        "  const rule=alert?.rule||{};",
        "  const tool=alert?.tool||{};",
        "  return {",
        "    number: alert?.number ?? null,",
        "    state: String(alert?.state||''),",
        "    ruleId: String(rule?.id||alert?.rule_id||''),",
        "    ruleName: String(rule?.name||alert?.rule_name||''),",
        "    severity: String(rule?.severity||alert?.severity||''),",
        "    securitySeverity: String(rule?.security_severity_level||alert?.security_severity_level||''),",
        "    tool: String(tool?.name||alert?.tool_name||''),",
        "    path: String(location?.path||''),",
        "    startLine: Number(location?.start_line||0)||null,",
        "    url: String(alert?.html_url||''),",
        "  };",
        "}",
        "for(const item of securityFailures){",
        "  const repo=String(item?.repo||'').trim();",
        "  const branch=String(item?.branch||'').trim();",
        "  const n=String(item?.n||'').trim();",
        "  const securityCheckNames=Array.isArray(item?.securityCheckNames)?item.securityCheckNames:[];",
        "  const prDigest=repo&&n?collectPrDigest(repo,n,{branch,base:String(item?.base||'').trim(),title:String(item?.title||''),url:String(item?.url||'')}):null;",
        "  if(!repo||!branch){needsAgent.push({repo,number:n,branch,reason:'missing_repo_or_branch',securityCheckNames,alerts:[],prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  let alerts=[];",
        "  let fetchError='';",
        "  try{",
        "    const alertsRaw=gh(['api','--method','GET','repos/'+repo+'/code-scanning/alerts','--raw-field','state=open','--raw-field','per_page=20','--raw-field','ref=refs/heads/'+branch]);",
        "    const parsed=(()=>{try{return JSON.parse(alertsRaw||'[]')}catch{return []}})();",
        "    alerts=(Array.isArray(parsed)?parsed:[]).map(compactAlert).filter(a=>a.ruleId||a.ruleName||a.path).slice(0,10);",
        "    if(alerts.length>0) alertsFetched++;",
        "  }catch(e){fetchError=String(e?.message||e);}",
        "  needsAgent.push({repo,number:n,branch,base:String(item?.base||'').trim(),url:String(item?.url||''),title:String(item?.title||''),reason:'security_code_scanning_failure',securityCheckNames,failedCheckNames:Array.isArray(item?.failedCheckNames)?item.failedCheckNames:[],alerts,fetchError,prDigest,digestSummary:String(prDigest?.digestSummary||'')});",
        "}",
        "console.log(JSON.stringify({securityFailureCount:securityFailures.length,alertsFetched,needsAgentCount:needsAgent.length,needsAgent}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_FETCH_AND_CLASSIFY:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    }, { x: 120, y: 750 }),

    node("security-agent-needed", "condition.expression", "Needs Security Agent?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('programmatic-security-fix')?.output;" +
        "return (JSON.parse(o||'{}').needsAgentCount||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 120, y: 860 }),

    node("dispatch-security-fix-agent", "action.run_agent", "Dispatch Security Fix Agent", {
      prompt:
        "You are a Bosun PR security remediation agent. Work only the PRs in this JSON:\n\n" +
        "{{$ctx.getNodeOutput('programmatic-security-fix')?.output}}\n\n" +
        "Each item represents a Bosun-created or explicitly trusted PR blocked by CodeQL or GitHub code scanning.\n" +
        "Use the supplied alert data, prDigest.body, prDigest.files, prDigest.issueComments, prDigest.reviews, prDigest.reviewComments, and prDigest.checks to make the smallest safe code change that resolves the finding.\n" +
        "For each repaired PR: check out the branch, fix only the reported code-scanning issue, run targeted validation, push the branch, and remove bosun-needs-fix after success.\n\n" +
        "STRICT RULES:\n" +
        "- Only fix the listed code-scanning or CodeQL findings.\n" +
        "- No unrelated refactors, dependency churn, merges, approvals, or PR closure.\n" +
        "- If alert fetch failed, inspect the PR checks and relevant source to resolve the security failure directly.\n" +
        "- Do NOT touch PRs that are not Bosun-created or explicitly trusted by config.",
      sdk: "auto",
      timeoutMs: 1_800_000,
      maxRetries: 2,
      retryDelayMs: 30_000,
      continueOnError: true,
    }, { x: 120, y: 970 }),

    node("generic-fix-needed", "condition.expression", "Generic Fix Needed?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "const d=JSON.parse(o||'{}');" +
        "return ((d.conflicts||[]).length+(d.ciFailures||[]).length)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 280, y: 640 }),

    node("programmatic-fix", "action.run_command", "Programmatic Fix Pass", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const raw=String(process.env.BOSUN_FETCH_AND_CLASSIFY||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const ciFailures=Array.isArray(payload.ciFailures)?payload.ciFailures:[];",
        "const conflicts=Array.isArray(payload.conflicts)?payload.conflicts:[];",
        "const needsAgent=[];",
        "let rerunRequested=0;",
        "const FAIL_STATES=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const MAX_AUTO_RERUN_ATTEMPT=1;",
        "function runGh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function safeGhJson(args,fallback){try{const out=runGh(args);return out?JSON.parse(out):fallback;}catch{return fallback;}}",
        "function normalizeRun(run){if(!run||typeof run!=='object')return null;return {databaseId:Number(run.databaseId||0)||null,attempt:Number(run.attempt||0)||0,conclusion:String(run.conclusion||''),status:String(run.status||''),workflowName:String(run.workflowName||run.name||''),displayTitle:String(run.displayTitle||run.name||''),url:String(run.url||''),createdAt:String(run.createdAt||''),updatedAt:String(run.updatedAt||'')}}",
        "function normalizeJob(job){if(!job||typeof job!=='object')return null;const steps=Array.isArray(job.steps)?job.steps:[];return {databaseId:Number(job.databaseId||0)||null,name:String(job.name||''),status:String(job.status||''),conclusion:String(job.conclusion||''),url:String(job.url||''),failedSteps:steps.filter((step)=>FAIL_STATES.has(String(step?.conclusion||step?.status||'').toUpperCase())).map((step)=>({name:String(step?.name||''),number:Number(step?.number||0)||null,status:String(step?.status||''),conclusion:String(step?.conclusion||'')})).filter((step)=>step.name).slice(0,10)}}",
        "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
        "function compactUser(user){const login=String(user?.login||user?.name||'').trim();return login?{login,url:String(user?.url||user?.html_url||'').trim()||null}:null;}",
        "function compactCheck(check){const name=String(check?.name||check?.context||check?.workflowName||'').trim();const state=String(check?.state||check?.conclusion||'').toUpperCase();const bucket=String(check?.bucket||'').toUpperCase();if(!name&&!state&&!bucket)return null;return {name:name||null,state:state||null,bucket:bucket||null,workflow:String(check?.workflowName||'').trim()||null};}",
        "function compactIssueComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactReview(review){return {id:Number(review?.id||0)||null,author:compactUser(review?.user||review?.author),state:String(review?.state||'').trim()||null,submittedAt:String(review?.submitted_at||review?.submittedAt||'').trim()||null,body:truncateText(review?.body,1200)};}",
        "function compactReviewComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),path:String(comment?.path||'').trim()||null,line:Number(comment?.line||0)||Number(comment?.original_line||0)||null,side:String(comment?.side||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactFile(file){const path=String(file?.filename||file?.path||'').trim();return path?{path,status:String(file?.status||'').trim()||null,additions:Number(file?.additions||0)||0,deletions:Number(file?.deletions||0)||0,changes:Number(file?.changes||0)||0}:null;}",
        "function collectPrDigest(repo,number,fallback){const pr=safeGhJson(['pr','view',String(number),'--repo',repo,'--json','number,title,body,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,author,labels,reviewDecision'],{});const issueComments=safeGhJson(['api','repos/'+repo+'/issues/'+number+'/comments?per_page=100'],[]).map(compactIssueComment).slice(0,40);const reviews=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/reviews?per_page=100'],[]).map(compactReview).slice(0,40);const reviewComments=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/comments?per_page=100'],[]).map(compactReviewComment).slice(0,60);const files=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/files?per_page=100'],[]).map(compactFile).filter(Boolean).slice(0,80);const requested=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/requested_reviewers'],{});const requestedReviewers=[...(Array.isArray(requested?.users)?requested.users:[]).map(compactUser),...(Array.isArray(requested?.teams)?requested.teams:[]).map((team)=>{const slug=String(team?.slug||team?.name||'').trim();return slug?{team:slug,url:String(team?.html_url||team?.url||'').trim()||null}:null;})].filter(Boolean);const checks=(Array.isArray(pr.statusCheckRollup)?pr.statusCheckRollup:[]).map(compactCheck).filter(Boolean);const failingChecks=checks.filter((check)=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(check.state)||check.bucket==='FAIL');const pendingChecks=checks.filter((check)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(check.state));const labels=(Array.isArray(pr.labels)?pr.labels:[]).map((label)=>String(label?.name||label||'').trim()).filter(Boolean);const digestSummary=['PR #'+String(pr?.number||number)+' '+String(pr?.title||fallback?.title||''),'repo='+repo+' branch='+(String(pr?.headRefName||fallback?.branch||'').trim()||'unknown'),'checks='+checks.length+' fail='+failingChecks.length+' pending='+pendingChecks.length,'comments='+issueComments.length+' reviews='+reviews.length+' reviewComments='+reviewComments.length+' files='+files.length,labels.length?'labels='+labels.join(', '):''].filter(Boolean).join('\\n');return {core:{number:Number(pr?.number||number)||number,title:String(pr?.title||fallback?.title||''),url:String(pr?.url||fallback?.url||'').trim()||null,body:truncateText(pr?.body,4000),branch:String(pr?.headRefName||fallback?.branch||'').trim()||null,baseBranch:String(pr?.baseRefName||fallback?.base||'').trim()||null,isDraft:pr?.isDraft===true,mergeable:String(pr?.mergeable||'').trim()||null,author:compactUser(pr?.author),reviewDecision:String(pr?.reviewDecision||'').trim()||null},labels,requestedReviewers,checks,ciSummary:{total:checks.length,failing:failingChecks.length,pending:pendingChecks.length,passing:Math.max(0,checks.length-failingChecks.length-pendingChecks.length)},issueComments,reviews,reviewComments,files,digestSummary};}",
        "function collectCiDiagnostics(repo,run){const info={failedRun:normalizeRun(run),failedJobs:[],failedLogExcerpt:'',diagnosticsError:''};const runId=Number(run?.databaseId||0)||0;if(!runId)return info;try{const viewRaw=runGh(['run','view',String(runId),'--repo',repo,'--json','attempt,conclusion,status,workflowName,displayTitle,url,createdAt,updatedAt,jobs']);const view=(()=>{try{return JSON.parse(viewRaw||'{}')}catch{return {}}})();info.failedRun=normalizeRun({...run,...view});const jobs=Array.isArray(view.jobs)?view.jobs:[];info.failedJobs=jobs.map(normalizeJob).filter((job)=>job&&(FAIL_STATES.has(String(job.conclusion||'').toUpperCase())||job.failedSteps.length>0)).slice(0,10);}catch(e){info.diagnosticsError=String(e?.message||e);}try{info.failedLogExcerpt=truncateText(runGh(['run','view',String(runId),'--repo',repo,'--log-failed']),6000);}catch(e){const message=String(e?.message||e);if(message&&message!==info.diagnosticsError){info.diagnosticsError=info.diagnosticsError?info.diagnosticsError+' | '+message:message;}}return info;}",
        "for(const item of ciFailures){",
        "  const repo=String(item?.repo||'').trim();",
        "  const branch=String(item?.branch||'').trim();",
        "  const n=String(item?.n||'').trim();",
        "  const failedCheckNames=Array.isArray(item?.failedCheckNames)?item.failedCheckNames:[];",
        "  const url=String(item?.url||'').trim();",
        "  const title=String(item?.title||'').trim();",
        "  const prDigest=repo&&n?collectPrDigest(repo,n,{branch,title,url}):null;",
        "  if(!repo||!branch){needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'missing_repo_or_branch',prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  let runs=[];",
        "  try{",
        "    const listRaw=runGh(['run','list','--repo',repo,'--branch',branch,'--json','databaseId,attempt,conclusion,status,workflowName,displayTitle,url,createdAt,updatedAt','--limit','8']);",
        "    const parsedRuns=(()=>{try{return JSON.parse(listRaw||'[]')}catch{return []}})();",
        "    runs=Array.isArray(parsedRuns)?parsedRuns:[];",
        "  }catch(e){needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'ci_run_listing_failed',error:String(e?.message||e),prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  const failed=runs.find((r)=>FAIL_STATES.has(String(r?.conclusion||'').toUpperCase()));",
        "  const failedRun=normalizeRun(failed);",
        "  if(failedRun?.databaseId&&failedRun.attempt<=MAX_AUTO_RERUN_ATTEMPT){",
        "    try{runGh(['run','rerun',String(failedRun.databaseId),'--repo',repo]);rerunRequested++;continue;}",
        "    catch(e){needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'ci_rerun_failed',error:String(e?.message||e),prDigest,digestSummary:String(prDigest?.digestSummary||''),...collectCiDiagnostics(repo,failedRun)});continue;}",
        "  }",
        "  if(failedRun?.databaseId){needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'auto_rerun_limit_reached',rerunAttempts:failedRun.attempt||0,prDigest,digestSummary:String(prDigest?.digestSummary||''),...collectCiDiagnostics(repo,failedRun)});continue;}",
        "  needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'no_rerunnable_failed_run_found',recentRuns:runs.map(normalizeRun).filter(Boolean).slice(0,5),prDigest,digestSummary:String(prDigest?.digestSummary||'')});",
        "}",
        "let branchUpdated=0;",
        "for(const item of conflicts){",
        "  const repo=String(item?.repo||'').trim();",
        "  const n=String(item?.n||'').trim();",
        "  const branch=String(item?.branch||'').trim();",
        "  const base=String(item?.base||'').trim();",
        "  const mergeable=String(item?.mergeable||'').toUpperCase();",
        "  const prDigest=repo&&n?collectPrDigest(repo,n,{branch,base,url:String(item?.url||'')}):null;",
        "  if(!repo||!n){needsAgent.push({...item,reason:'missing_repo_or_pr',prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  if(mergeable==='BEHIND'){",
        "    try{",
        "      const headSha=JSON.parse(runGh(['pr','view',n,'--repo',repo,'--json','headRefOid'])).headRefOid;",
        "      const apiArgs=['api','-X','PUT','repos/'+repo+'/pulls/'+n+'/update-branch','--field','expected_head_sha='+headSha];",
        "      runGh(apiArgs);",
        "      branchUpdated++;",
        "    }catch(e){needsAgent.push({repo,number:n,branch,base,mergeable,reason:'branch_update_failed',error:String(e?.message||e),prDigest,digestSummary:String(prDigest?.digestSummary||'')});}",
        "    continue;",
        "  }",
        "  needsAgent.push({repo,number:n,branch,base,mergeable,reason:'merge_conflict_requires_code_resolution',prDigest,digestSummary:String(prDigest?.digestSummary||'')});",
        "}",
        "console.log(JSON.stringify({rerunRequested,branchUpdated,ciFailureCount:ciFailures.length,conflictCount:conflicts.length,needsAgentCount:needsAgent.length,needsAgent}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_FETCH_AND_CLASSIFY:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    }, { x: 280, y: 750 }),

    node("fix-agent-needed", "condition.expression", "Needs Agent Fix?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('programmatic-fix')?.output;" +
        "return (JSON.parse(o||'{}').needsAgentCount||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 280, y: 860 }),

    node("dispatch-fix-agent", "action.run_agent", "Dispatch Fix Agent (Fallback)", {
      prompt:
        "You are a Bosun PR repair fallback agent. A deterministic CLI fix pass has already run. " +
        "Only work unresolved items from this JSON:\n\n" +
        "{{$ctx.getNodeOutput('programmatic-fix')?.output}}\n\n" +
        "Each unresolved item includes prDigest with the PR body, files, issue comments, reviews, review comments, review requests, and check summaries. Use that context first.\n" +
        "For conflict items: rebase/merge branch onto base, resolve conflicts, run tests, push with --force-with-lease if needed.\n" +
        "For CI-failure items: start from failedCheckNames, failedRun, failedJobs, and failedLogExcerpt to identify the actual failing workflow step, then apply the minimal fix, commit, and push.\n" +
        "After successful repair remove bosun-needs-fix label.\n\n" +
        "STRICT RULES:\n" +
        "- Fix only CI/conflict issues. No scope creep.\n" +
        "- Do NOT merge/close/approve PRs.\n" +
        "- Do NOT touch PRs that are not Bosun-created or explicitly trusted by config.",
      sdk: "auto",
      timeoutMs: 1_800_000,
      maxRetries: 2,
      retryDelayMs: 30_000,
      continueOnError: true,
    }, { x: 280, y: 970 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2b: Review gate — MANDATORY before any merge.
    // The review agent checks diff stats per candidate and is the ONLY thing
    // that can call `gh pr merge`. It blocks suspicious/destructive diffs.
    // ─────────────────────────────────────────────────────────────────────────
    node("review-needed", "condition.expression", "Review Candidates?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').readyCandidates||[]).length>0;" +
        "}catch(e){return false;}})()",
    }, { x: 600, y: 530 }),

    node("programmatic-review", "action.run_command", "Review Gate: Programmatic Merge", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const {execFileSync}=require('child_process');",
        "const raw=String(process.env.BOSUN_FETCH_AND_CLASSIFY||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const candidates=Array.isArray(payload.readyCandidates)?payload.readyCandidates:[];",
        "const ratio=Number('{{suspiciousDeletionRatio}}')||3;",
        "const minDel=Number('{{minDestructiveDeletions}}')||500;",
        "const labelReview=String('{{labelNeedsReview}}'||'bosun-needs-human-review');",
        "const method=String('{{mergeMethod}}'||'merge').toLowerCase();",
        "const merged=[]; const held=[]; const skipped=[];",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function normalizeList(value){if(Array.isArray(value)) return value.map((entry)=>String(entry||'').trim().toLowerCase()).filter(Boolean); return String(value||'').split(',').map((entry)=>entry.trim().toLowerCase()).filter(Boolean);}",
        "function parseBool(value,fallback){if(value===undefined||value===null||value==='') return fallback; const raw=String(value).trim().toLowerCase(); if(['1','true','yes','on'].includes(raw)) return true; if(['0','false','no','off'].includes(raw)) return false; return fallback;}",
        "function matchesCheckPattern(name,pattern){const text=String(name||'').trim().toLowerCase();const token=String(pattern||'').trim().toLowerCase();if(!text||!token)return false;if(token==='*')return true;if(!token.includes('*'))return text.includes(token);const parts=token.split('*').filter(Boolean);if(parts.length===0)return true;let cursor=0;for(const part of parts){const idx=text.indexOf(part,cursor);if(idx===-1)return false;cursor=idx+part.length;}if(!token.startsWith('*')&&!text.startsWith(parts[0]||''))return false;if(!token.endsWith('*')&&!text.endsWith(parts[parts.length-1]||''))return false;return true;}",
        "function matchesAnyPattern(name,patterns){return (Array.isArray(patterns)?patterns:[]).some((pattern)=>matchesCheckPattern(name,pattern));}",
        "function readCheckState(check){return String(check?.state||check?.conclusion||check?.bucket||'').trim().toUpperCase();}",
        "function isPassingCheckState(state,treatNeutralAsPass){if(!state)return true;if(['SUCCESS','PASS','PASSED','COMPLETED'].includes(state))return true;if(treatNeutralAsPass&&['NEUTRAL','SKIPPED'].includes(state))return true;return !['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(state)&&!['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(state);}",
        "function evaluateCheckGates(checks,policy){const normalized=(Array.isArray(checks)?checks:[]).map((check)=>({name:String(check?.name||'').trim(),state:readCheckState(check)})).filter((check)=>check.name);const considered=normalized.filter((check)=>!matchesAnyPattern(check.name,policy.ignorePatterns));let required=considered;if(policy.mode==='required-only'){required=considered.filter((check)=>matchesAnyPattern(check.name,policy.requiredPatterns));}if((Array.isArray(policy.optionalPatterns)?policy.optionalPatterns:[]).length>0){required=required.filter((check)=>!matchesAnyPattern(check.name,policy.optionalPatterns));}const missingRequired=policy.requireAnyRequiredCheck&&required.length===0;const hasFailure=required.some((check)=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(check.state));const hasPending=policy.treatPendingRequiredAsBlocking&&required.some((check)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(check.state));return {hasFailure,hasPending,missingRequired,noConsideredChecks:considered.length===0,isReady:!missingRequired&&!hasFailure&&!hasPending&&required.every((check)=>isPassingCheckState(check.state,policy.treatNeutralAsPass))};}",
        "function configPath(){const home=String(process.env.BOSUN_HOME||process.env.BOSUN_PROJECT_DIR||'').trim();return home?path.join(home,'bosun.config.json'):path.join(process.cwd(),'bosun.config.json');}",
        "function readBosunConfig(){try{return JSON.parse(fs.readFileSync(configPath(),'utf8'));}catch{return {};}}",
        "const BOSUN_CONFIG=readBosunConfig();",
        "const CHECK_GATES=(BOSUN_CONFIG&&typeof BOSUN_CONFIG.gates==='object'&&BOSUN_CONFIG.gates&&typeof BOSUN_CONFIG.gates.checks==='object')?BOSUN_CONFIG.gates.checks:{};",
        "const CHECK_MODE=((String(CHECK_GATES?.mode||'all').trim().toLowerCase())||'all');",
        "const REQUIRED_CHECK_PATTERNS=normalizeList(CHECK_GATES?.requiredPatterns);",
        "const OPTIONAL_CHECK_PATTERNS=normalizeList(CHECK_GATES?.optionalPatterns);",
        "const IGNORE_CHECK_PATTERNS=normalizeList(CHECK_GATES?.ignorePatterns);",
        "const REQUIRE_ANY_REQUIRED_CHECK=parseBool(CHECK_GATES?.requireAnyRequiredCheck, true);",
        "const TREAT_PENDING_REQUIRED_AS_BLOCKING=parseBool(CHECK_GATES?.treatPendingRequiredAsBlocking, true);",
        "const TREAT_NEUTRAL_AS_PASS=parseBool(CHECK_GATES?.treatNeutralAsPass, false);",
        "for(const c of candidates){",
        "  const repo=String(c?.repo||'').trim();",
        "  const n=String(c?.n||'').trim();",
        "  if(!repo||!n){skipped.push({repo,number:n,reason:'missing_repo_or_pr'});continue;}",
        "  try{",
        "    const viewRaw=gh(['pr','view',n,'--repo',repo,'--json','number,title,additions,deletions,changedFiles,isDraft']);",
        "    const view=(()=>{try{return JSON.parse(viewRaw||'{}')}catch{return {}}})();",
        "    if(view?.isDraft===true){skipped.push({repo,number:n,reason:'draft'});continue;}",
        "    const add=Number(view?.additions||0);",
        "    const del=Number(view?.deletions||0);",
        "    const changed=Number(view?.changedFiles||0);",
        "    const destructive=(del>(add*ratio))&&(del>minDel);",
        "    const tooWide=changed>250;",
        "    if(destructive||tooWide){",
        "      gh(['pr','edit',n,'--repo',repo,'--add-label',labelReview]);",
        "      gh(['pr','comment',n,'--repo',repo,'--body',':warning: Bosun held this PR for human review due to suspicious diff footprint.']);",
        "      held.push({repo,number:n,reason:destructive?'destructive_diff':'changed_files_too_large',additions:add,deletions:del,changedFiles:changed});",
        "      continue;",
        "    }",
        "    const checksRaw=gh(['pr','checks',n,'--repo',repo,'--json','name,state,bucket']);",
        "    const checks=(()=>{try{return JSON.parse(checksRaw||'[]')}catch{return []}})();",
        "    const gateVerdict=evaluateCheckGates(checks,{mode:CHECK_MODE,requiredPatterns:REQUIRED_CHECK_PATTERNS,optionalPatterns:OPTIONAL_CHECK_PATTERNS,ignorePatterns:IGNORE_CHECK_PATTERNS,requireAnyRequiredCheck:REQUIRE_ANY_REQUIRED_CHECK,treatPendingRequiredAsBlocking:TREAT_PENDING_REQUIRED_AS_BLOCKING,treatNeutralAsPass:TREAT_NEUTRAL_AS_PASS});",
        "    if(gateVerdict.hasFailure){skipped.push({repo,number:n,reason:'ci_failed'});continue;}",
        "    if(gateVerdict.hasPending){skipped.push({repo,number:n,reason:'ci_pending'});continue;}",
        "    if(gateVerdict.missingRequired){skipped.push({repo,number:n,reason:'no_required_checks'});continue;}",
        "    if(gateVerdict.noConsideredChecks){skipped.push({repo,number:n,reason:'no_checks_yet'});continue;}",
        "    const doApplySuggestions=String('{{autoApplySuggestions}}'||'true')==='true'&&process.env.BOSUN_AUTO_APPLY_SUGGESTIONS!=='false';",
        "    if(doApplySuggestions){",
        "      try{",
        "        const toolPath=require('path').resolve(process.cwd(),'tools','apply-pr-suggestions.mjs');",
        "        if(require('fs').existsSync(toolPath)){",
        "          const sugOut=execFileSync('node',[toolPath,'--owner',repo.split('/')[0],'--repo',repo.split('/')[1],n,'--json'],{encoding:'utf8',timeout:60000,stdio:['pipe','pipe','pipe']});",
        "          const sugRes=(()=>{try{return JSON.parse(sugOut)}catch{return null}})();",
        "          if(sugRes?.commitSha){console.error('[watchdog] auto-applied '+sugRes.applied+' suggestion(s) on PR #'+n+' → '+sugRes.commitSha.slice(0,8));skipped.push({repo,number:n,reason:'suggestions_applied_awaiting_ci'});continue;}",
        "        }",
        "      }catch(sugErr){console.error('[watchdog] suggestion auto-apply skipped for PR #'+n+': '+String(sugErr?.message||sugErr).slice(0,120));}",
        "    }",
        "    const mergeArgs=['pr','merge',n,'--repo',repo,'--delete-branch'];",
        "    if(method==='rebase') mergeArgs.push('--rebase');",
        "    else if(method==='merge') mergeArgs.push('--merge');",
        "    else mergeArgs.push('--squash');",
        "    try{gh(mergeArgs);}catch(directErr){",
        "      mergeArgs.push('--auto');",
        "      gh(mergeArgs);",
        "    }",
        "    merged.push({repo,number:n,title:String(view?.title||'')});",
        "  }catch(e){",
        "    held.push({repo,number:n,reason:'merge_attempt_failed',error:String(e?.message||e)});",
        "  }",
        "}",
        "console.log(JSON.stringify({mergedCount:merged.length,heldCount:held.length,skippedCount:skipped.length,merged,held,skipped}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_FETCH_AND_CLASSIFY:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    }, { x: 600, y: 700 }),

    node("notify", "notify.log", "Watchdog Report", {
      message:
        "Bosun PR Watchdog cycle complete — see live digest/status board for streaming updates",
      level: "info",
    }, { x: 400, y: 900 }),

    node("no-prs", "notify.log", "No Bosun PRs Open", {
      message: "Bosun PR Watchdog: no open automation-eligible PRs found — idle",
      level: "info",
    }, { x: 700, y: 370 }),

    // ── Sweep: delete remote branches for already-merged PRs ────────────
    // Squash merges leave orphan branches because --auto defers deletion.
    // This node runs after the merge gate and prunes any lingering heads.
    node("cleanup-merged-branches", "action.run_command", "Prune Merged Branches", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "function gh(a){return execFileSync('gh',a,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "const repos=String(process.env.BOSUN_REPO_LIST||'').split(',').map(s=>s.trim()).filter(Boolean);",
        "let deleted=0;",
        "for(const repo of repos){",
        "  try{",
        "    const raw=gh(['pr','list','--repo',repo,'--state','merged','--json','number,headRefName,labels','--limit','50']);",
        "    const prs=(()=>{try{return JSON.parse(raw||'[]')}catch{return []}})();",
        "    for(const pr of prs){",
        "      const labels=Array.isArray(pr?.labels)?pr.labels.map((entry)=>typeof entry==='string'?entry:entry?.name).filter(Boolean):[];",
        "      if(!labels.includes('bosun-pr-bosun-created')) continue;",
        "      const branch=String(pr?.headRefName||'').trim();",
        "      if(!branch||branch==='main'||branch==='master')continue;",
        "      try{gh(['api','repos/'+repo+'/git/refs/heads/'+branch,'--method','DELETE','--silent']);deleted++;}catch(e){}",
        "    }",
        "  }catch(e){}",
        "}",
        "console.log(JSON.stringify({deletedBranches:deleted}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_REPO_LIST:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output ? (()=>{try{const o=JSON.parse($ctx.getNodeOutput('fetch-and-classify').output);return [...new Set([...(o.fixCandidates||[]),...(o.readyCandidates||[])].map(c=>c.repo).filter(Boolean))].join(',')}catch{return ''}})() : ''}}",
      },
    }, { x: 400, y: 1020 }),
  ],
  edges: [
    edge("trigger",          "fetch-and-classify"),
    edge("fetch-and-classify","has-prs"),
    edge("has-prs",          "has-behind",      { condition: "$output?.result === true" }),
    edge("has-prs",          "no-prs",          { condition: "$output?.result !== true" }),
    // Parallel merge path — review CLEAN PRs immediately, don't wait for fix agent
    edge("has-prs",          "review-needed",   { condition: "$output?.result === true" }),
    // Behind-branch fast-path: update out-of-date PRs without agent dispatch
    edge("has-behind",       "update-behind-branches", { condition: "$output?.result === true", port: "yes" }),
    edge("has-behind",       "fix-needed",      { condition: "$output?.result !== true", port: "no" }),
    edge("update-behind-branches", "fix-needed"),
    // Fix path (security failures, then conflicts + non-security CI failures)
    edge("fix-needed",       "security-fix-needed", { condition: "$output?.result === true" }),
    edge("fix-needed",       "review-needed",       { condition: "$output?.result !== true" }),
    edge("security-fix-needed","programmatic-security-fix", { condition: "$output?.result === true" }),
    edge("security-fix-needed","generic-fix-needed",       { condition: "$output?.result !== true" }),
    edge("programmatic-security-fix", "security-agent-needed"),
    edge("security-agent-needed", "dispatch-security-fix-agent", { condition: "$output?.result === true" }),
    edge("security-agent-needed", "generic-fix-needed",         { condition: "$output?.result !== true" }),
    edge("dispatch-security-fix-agent", "generic-fix-needed"),
    edge("generic-fix-needed", "programmatic-fix", { condition: "$output?.result === true" }),
    edge("generic-fix-needed", "review-needed",    { condition: "$output?.result !== true" }),
    edge("programmatic-fix", "fix-agent-needed"),
    edge("fix-agent-needed", "dispatch-fix-agent", { condition: "$output?.result === true" }),
    edge("fix-agent-needed", "review-needed",      { condition: "$output?.result !== true" }),
    edge("dispatch-fix-agent","review-needed"),
    // Review gate (merge candidates)
    edge("review-needed",    "programmatic-review", { condition: "$output?.result === true" }),
    edge("review-needed",    "notify",          { condition: "$output?.result !== true" }),
    edge("programmatic-review","notify"),
    // Post-merge cleanup
    edge("notify",           "cleanup-merged-branches"),
  ],
  metadata: {
    author: "bosun",
    version: 4,
    createdAt: "2025-07-01T00:00:00Z",
    templateVersion: "2.3.0",
    tags: ["github", "pr", "ci", "merge", "watchdog", "bosun-attached", "safety"],
    replaces: {
      module: "agent-hooks.mjs",
      functions: ["registerBuiltinHooks (PostPR block)"],
      calledFrom: [],
      description:
        "v2.3: Adds fast-path update-branch for out-of-date (BEHIND) PRs without conflicts. " +
        "Consolidates PR polling into one gh pr list fetch per target repo per cycle. " +
        "Uses deterministic-first remediation and review/merge command nodes; " +
        "agent execution is now fallback-only for unresolved conflicts or failed " +
        "automatic remediation attempts. All external PRs (no bosun-attached label) " +
        "remain untouched.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  GitHub ↔ Kanban Sync
//  Replaces github-reconciler.mjs — reconciles PR state with kanban board.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const GITHUB_KANBAN_SYNC_TEMPLATE = {
  id: "template-github-kanban-sync",
  name: "GitHub ↔ Kanban Sync",
  description:
    "Reconciles GitHub PR state with the bosun kanban board every 5 minutes. " +
    "Marks tasks as in-review when Bosun-created PRs open, moves them to done " +
    "when PRs are merged, and posts completion comments via the kanban API. " +
    "Replaces the legacy github-reconciler.mjs module.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    lookbackHours: 24,
    repoScope: "auto",
  },
  nodes: [
    node("trigger", "trigger.schedule", "Sync Every 5 min", {
      intervalMs: 300_000,
      cron: "*/5 * * * *",
    }, { x: 400, y: 50 }),

    node("fetch-pr-state", "action.run_command", "Fetch Bosun PR State", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const {execFileSync}=require('child_process');",
        "const hours=Number('{{lookbackHours}}')||24;",
        "const repoScope=String('{{repoScope}}'||'auto').trim();",
        "const since=new Date(Date.now()-hours*3600000).toISOString();",
        "function ghJson(args){",
        "  try{const o=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();return o?JSON.parse(o):[];}",
        "  catch{return [];}",
        "}",
        "function configPath(){",
        "  const home=String(process.env.BOSUN_HOME||process.env.BOSUN_PROJECT_DIR||'').trim();",
        "  return home?path.join(home,'bosun.config.json'):path.join(process.cwd(),'bosun.config.json');",
        "}",
        "function collectReposFromConfig(){",
        "  const repos=[];",
        "  try{",
        "    const cfg=JSON.parse(fs.readFileSync(configPath(),'utf8'));",
        "    const workspaces=Array.isArray(cfg?.workspaces)?cfg.workspaces:[];",
        "    if(workspaces.length>0){",
        "      const active=String(cfg?.activeWorkspace||'').trim().toLowerCase();",
        "      const activeWs=active?workspaces.find(w=>String(w?.id||'').trim().toLowerCase()===active):null;",
        "      const wsList=activeWs?[activeWs]:workspaces;",
        "      for(const ws of wsList){",
        "        for(const repo of (Array.isArray(ws?.repos)?ws.repos:[])){",
        "          const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();",
        "          if(slug) repos.push(slug);",
        "        }",
        "      }",
        "    }",
        "    if(repos.length===0){",
        "      for(const repo of (Array.isArray(cfg?.repos)?cfg.repos:[])){",
        "        const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();",
        "        if(slug) repos.push(slug);",
        "      }",
        "    }",
        "  }catch{}",
        "  return repos;",
        "}",
        "function resolveRepoTargets(){",
        "  if(repoScope&&repoScope!=='auto'&&repoScope!=='all'&&repoScope!=='current'){",
        "    return [...new Set(repoScope.split(',').map(v=>v.trim()).filter(Boolean))];",
        "  }",
        "  if(repoScope==='current') return [''];",
        "  const fromConfig=collectReposFromConfig();",
        "  if(fromConfig.length>0) return [...new Set(fromConfig)];",
        "  const envRepo=String(process.env.GITHUB_REPOSITORY||'').trim();",
        "  if(envRepo) return [envRepo];",
        "  return [''];",
        "}",
        "function parseRepoFromUrl(url){",
        "  const raw=String(url||'');",
        "  const marker='github.com/';",
        "  const idx=raw.toLowerCase().indexOf(marker);",
        "  if(idx<0) return '';",
        "  const tail=raw.slice(idx+marker.length).split('/');",
        "  if(tail.length<2) return '';",
        "  const owner=String(tail[0]||'').trim();",
        "  const repo=String(tail[1]||'').trim();",
        "  return owner&&repo?(owner+'/'+repo):'';",
        "}",
        "function extractTaskId(pr){",
        "  const src=String((pr.body||'')+'\\n'+(pr.title||''));",
        "  const m=src.match(/(?:Bosun-Task|VE-Task|Task-ID|task[_-]?id)[:\\s]+([a-zA-Z0-9_-]{4,64})/i);",
        "  return m?m[1].trim():null;",
        "}",
        "function shouldSyncTaskPr(pr){ return Boolean(extractTaskId(pr)); }",
        "const repoTargets=resolveRepoTargets();",
        "const merged=[];",
        "const open=[];",
        "for(const target of repoTargets){",
        "  const repo=String(target||'').trim();",
        "  const mergedArgs=['pr','list','--state','merged','--json','number,title,body,headRefName,mergedAt,url','--limit','50'];",
        "  const openArgs=['pr','list','--state','open','--json','number,title,body,headRefName,isDraft,url','--limit','50'];",
        "  if(repo){ mergedArgs.push('--repo',repo); openArgs.push('--repo',repo); }",
        "  for(const pr of ghJson(mergedArgs)){ if(shouldSyncTaskPr(pr)) merged.push({...pr,__repo:repo||parseRepoFromUrl(pr?.url)||String(process.env.GITHUB_REPOSITORY||'').trim()}); }",
        "  for(const pr of ghJson(openArgs)){ if(shouldSyncTaskPr(pr)) open.push({...pr,__repo:repo||parseRepoFromUrl(pr?.url)||String(process.env.GITHUB_REPOSITORY||'').trim()}); }",
        "}",
        "const recentMerged=merged.filter(p=>!p.mergedAt||new Date(p.mergedAt)>=new Date(since));",
        "console.log(JSON.stringify({",
        "  repoScope,",
        "  reposScanned: repoTargets.length,",
        "  merged:recentMerged.map(p=>({n:p.number,repo:p.__repo||'',title:p.title,branch:p.headRefName,taskId:extractTaskId(p)})),",
        "  open:open.filter(p=>!p.isDraft).map(p=>({n:p.number,repo:p.__repo||'',title:p.title,branch:p.headRefName,taskId:extractTaskId(p)})),",
        "}));",
      ].join(" ")],
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("has-updates", "condition.expression", "Any Updates?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-pr-state')?.output;" +
        "const d=JSON.parse(o||'{}');" +
        "return (d.merged||[]).length>0||(d.open||[]).length>0;" +
        "}catch{return false;}})()",
    }, { x: 400, y: 370 }),

    node("sync-programmatic", "action.run_command", "Sync PR State → Kanban (Programmatic)", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const fs=require('fs');",
        "const raw=String(process.env.BOSUN_FETCH_PR_STATE||'');",
        "const data=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const merged=Array.isArray(data.merged)?data.merged:[];",
        "const open=Array.isArray(data.open)?data.open:[];",
        "const updates=[]; const unresolved=[];",
        "const maxBuffer=25*1024*1024;",
        "const cliPath=fs.existsSync('cli.mjs')?'cli.mjs':'';",
        "const taskCli=['task/task-cli.mjs','task-cli.mjs'].find(p=>fs.existsSync(p))||'';",
        "const taskRunner=cliPath?'cli':(taskCli?'task-cli':'');",
        "if(!taskRunner){",
        "  console.log(JSON.stringify({updated:0,unresolved:[{reason:'task_command_missing'}],needsAgent:true}));",
        "  process.exit(0);",
        "}",
        "function runTask(args){const cmdArgs=taskRunner==='cli'?['cli.mjs','task',...args,'--config-dir','.bosun','--repo-root','.']:[taskCli,...args];return execFileSync('node',cmdArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer}).trim();}",
        "function parseJsonObject(raw){const txt=String(raw||'').trim();if(!txt)return null;try{return JSON.parse(txt);}catch{}const lines=txt.split(/\\r?\\n/);for(let start=0;start<lines.length;start++){const token=lines[start].trim();if(!(token==='['||token==='{'||token.startsWith('[{')||token.startsWith('{\"')||token.startsWith('[\"')))continue;const candidate=lines.slice(start).join('\\n').trim();try{return JSON.parse(candidate);}catch{}}const compact=lines.map(s=>s.trim()).filter(Boolean);for(let i=compact.length-1;i>=0;i--){const line=compact[i];if(!(line.startsWith('{')||line.startsWith('[')))continue;try{return JSON.parse(line);}catch{}}const start=txt.indexOf('{');const end=txt.lastIndexOf('}');if(start>=0&&end>start){try{return JSON.parse(txt.slice(start,end+1));}catch{}}return null;}",
        "let taskListCache=null;",
        "function normalizeRepo(value){return String(value||'').trim().toLowerCase();}",
        "function listTasks(){",
        "  if(Array.isArray(taskListCache)) return taskListCache;",
        "  try{const raw=runTask(['list','--json']);const tasks=parseJsonObject(raw);taskListCache=Array.isArray(tasks)?tasks:[];return taskListCache;}catch{taskListCache=[];return taskListCache;}",
        "}",
        "function resolveTaskId(item){",
        "  const explicit=String(item?.taskId||'').trim();",
        "  if(explicit) return explicit;",
        "  const branch=String(item?.branch||'').trim();",
        "  if(!branch) return '';",
        "  const repo=normalizeRepo(item?.repo);",
        "  const matches=listTasks().filter((task)=>{",
        "    const taskBranch=String(task?.branchName||'').trim();",
        "    if(taskBranch!==branch) return false;",
        "    const taskRepo=normalizeRepo(task?.repository||'');",
        "    if(!repo || !taskRepo) return true;",
        "    return taskRepo===repo;",
        "  });",
        "  if(matches.length===1) return String(matches[0]?.id||'').trim();",
        "  const exactRepo=matches.find((task)=>normalizeRepo(task?.repository||'')===repo);",
        "  return exactRepo?String(exactRepo?.id||'').trim():'';",
        "}",
        "function getTaskSnapshot(id){",
        "  try{const raw=runTask(['get',id,'--json']);const task=parseJsonObject(raw);return {status:task?.status||null,reviewStatus:task?.reviewStatus||null};}catch{return {status:null,reviewStatus:null};}",
        "}",
        "for(const item of merged){",
        "  const id=resolveTaskId(item);",
        "  if(!id){unresolved.push({taskId:null,repo:String(item?.repo||''),branch:String(item?.branch||''),status:'done',reason:'task_lookup_failed'});continue;}",
        "  try{runTask(['update',id,'--status','done']);updates.push({taskId:id,status:'done'});}catch(e){unresolved.push({taskId:id,status:'done',error:String(e?.message||e)});}",
        "}",
        "for(const item of open){",
        "  const id=resolveTaskId(item);",
        "  if(!id){unresolved.push({taskId:null,repo:String(item?.repo||''),branch:String(item?.branch||''),status:'inreview',reason:'task_lookup_failed'});continue;}",
        "  try{const snap=getTaskSnapshot(id);const current=String(snap?.status||'').trim().toLowerCase();const review=String(snap?.reviewStatus||'').toLowerCase();if(current==='inreview'||current==='done'){updates.push({taskId:id,status:current,skipped:true});continue;}runTask(['update',id,'--status','inreview']);updates.push({taskId:id,status:'inreview',fromStatus:current||null,reviewStatus:review||null});}catch(e){unresolved.push({taskId:id,status:'inreview',error:String(e?.message||e)});}",
        "}",
        "const actionableUnresolved=unresolved.filter((item)=>String(item?.taskId||'').trim());",
        "console.log(JSON.stringify({updated:updates.length,updates,unresolved,needsAgent:actionableUnresolved.length>0}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_FETCH_PR_STATE:
          "{{$ctx.getNodeOutput('fetch-pr-state')?.output || '{}'}}",
      },
    }, { x: 400, y: 530 }),

    node("sync-agent-needed", "condition.expression", "Needs Agent Sync?", {
      expression:
        "(()=>{try{" +
        "const raw=$ctx.getNodeOutput('sync-programmatic')?.output||'{}';" +
        "const d=JSON.parse(raw);" +
        "const actionable=Array.isArray(d?.unresolved)?d.unresolved.some((item)=>String(item?.taskId||'').trim()):false;" +
        "return d?.needsAgent===true || actionable;" +
        "}catch{return true;}})()",
    }, { x: 400, y: 615 }),

    node("sync-agent", "action.run_agent", "Sync PR State → Kanban (Fallback)", {
      prompt:
        "You are the Bosun GitHub-Kanban sync fallback agent. A deterministic sync pass already ran.\n\n" +
        "Programmatic sync output:\n" +
        "{{$ctx.getNodeOutput('sync-programmatic')?.output}}\n\n" +
        "Now complete only unresolved updates.\n\n" +
        "GitHub PR state:\n" +
        "PR state (JSON from fetch-pr-state node output):\n" +
        "{{$ctx.getNodeOutput('fetch-pr-state')?.output}}\n\n" +
        "RULES:\n" +
        "1. For each MERGED PR entry with a taskId: update the kanban task to done.\n" +
        "   Use the available bosun CLI, for example:\n" +
        "     node task/task-cli.mjs update <taskId> --status done\n" +
        "   Or inspect available commands with a shell-native file listing.\n" +
        "2. For each OPEN (non-draft) PR entry with a taskId: if the task is not\n" +
        "   already in inreview or done status, update it to inreview.\n" +
        "3. Only act on entries that have a non-null taskId.\n" +
        "4. Log each update and whether it succeeded.\n" +
        "5. Do NOT close, merge, or modify any PR.\n" +
        "6. Do NOT create new tasks — only update existing ones.",
      sdk: "auto",
      timeoutMs: 300_000,
      continueOnError: true,
    }, { x: 400, y: 700 }),

    node("done", "notify.log", "Sync Complete", {
      message: "GitHub ↔ Kanban sync cycle complete",
      level: "info",
    }, { x: 400, y: 700 }),

    node("skip", "notify.log", "No PR Updates", {
      message: "No bosun PR changes to sync this cycle",
      level: "debug",
    }, { x: 650, y: 450 }),
  ],
  edges: [
    edge("trigger", "fetch-pr-state"),
    edge("fetch-pr-state", "has-updates"),
    edge("has-updates", "sync-programmatic", { condition: "$output?.result === true" }),
    edge("has-updates", "skip", { condition: "$output?.result !== true" }),
    edge("sync-programmatic", "sync-agent-needed"),
    edge("sync-agent-needed", "sync-agent", { condition: "$output?.result === true" }),
    edge("sync-agent-needed", "done", { condition: "$output?.result !== true" }),
    edge("sync-agent", "done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-07-10T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "kanban", "sync", "reconcile", "pr", "automation"],
    replaces: {
      module: "github-reconciler.mjs",
      functions: [
        "startGitHubReconciler",
        "stopGitHubReconciler",
        "GitHubReconciler (setInReview, syncMergedPRs, reconcileTaskStatuses)",
      ],
      calledFrom: ["monitor.mjs:restartGitHubReconciler"],
      description:
        "Replaces the legacy github-reconciler.mjs module that polled GitHub PRs " +
        "and updated kanban task statuses (inreview/done) every N minutes. " +
        "This template runs the same reconciliation as an auditable, configurable " +
        "workflow with an agent-driven sync step.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  SDK Conflict Resolver
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const SDK_CONFLICT_RESOLVER_TEMPLATE = {
  id: "template-sdk-conflict-resolver",
  name: "SDK Conflict Resolver",
  description:
    "Intelligent merge-conflict resolution using SDK agents. " +
    "Auto-resolves lockfiles and generated files mechanically, then " +
    "launches an agent with full context to resolve semantic conflicts " +
    "in code, configs, and imports. Verifies resolution and pushes.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    timeoutMs: 600000,
    cooldownMs: 1800000,
    maxAttempts: 4,
    baseBranch: "main",
  },
  nodes: [
    node("trigger", "trigger.event", "Merge Conflict Detected", {
      eventType: "pr.conflict_detected",
      description: "Fires when a PR has merge conflicts that need resolution",
    }, { x: 400, y: 50 }),

    node("check-cooldown", "condition.expression", "On Cooldown?", {
      expression:
        "(() => { " +
        "const last = Number($data?.lastAttemptAt || 0); " +
        "if (!last) return false; " +
        "return (Date.now() - last) < ($data?.cooldownMs || 1800000); " +
        "})()",
    }, { x: 400, y: 200, outputs: ["yes", "no"] }),

    node("check-attempts", "condition.expression", "Attempts Exhausted?", {
      expression:
        "Number($data?.attemptCount || 0) >= Number($data?.maxAttempts || 4)",
    }, { x: 400, y: 350, outputs: ["yes", "no"] }),

    node("get-conflicts", "action.run_command", "List Conflicted Files", {
      command: "git diff --name-only --diff-filter=U",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 500 }),

    node("classify-files", "action.set_variable", "Classify Files", {
      key: "fileClassification",
      value:
        "(() => { " +
        "const output = $ctx.getNodeOutput('get-conflicts')?.output || ''; " +
        "const files = output.split('\\n').map(f => f.trim()).filter(Boolean); " +
        "const auto = []; const manual = []; " +
        "const AUTO_THEIRS = ['pnpm-lock.yaml','package-lock.json','yarn.lock','go.sum']; " +
        "const AUTO_OURS = ['CHANGELOG.md','coverage.txt','results.txt']; " +
        "for (const f of files) { " +
        "  const name = f.split('/').pop(); " +
        "  if (AUTO_THEIRS.includes(name) || name.endsWith('.lock')) auto.push({file:f,strategy:'theirs'}); " +
        "  else if (AUTO_OURS.includes(name)) auto.push({file:f,strategy:'ours'}); " +
        "  else manual.push(f); " +
        "} " +
        "return {auto, manual, total: files.length}; " +
        "})()",
      isExpression: true,
    }, { x: 400, y: 650 }),

    node("auto-resolve", "action.run_command", "Auto-Resolve Trivial Files", {
      command:
        "node -e \"" +
        "const files = JSON.parse(process.env.AUTO_FILES || '[]'); " +
        "const {execSync} = require('child_process'); " +
        "let resolved = 0; " +
        "for (const {file, strategy} of files) { " +
        "  try { execSync('git checkout --' + strategy + ' -- ' + file, {cwd: process.env.CWD}); " +
        "  execSync('git add ' + file, {cwd: process.env.CWD}); resolved++; } catch {} " +
        "} " +
        "console.log(JSON.stringify({resolved}));\" ",
      env: {
        AUTO_FILES: "{{fileClassification.auto}}",
        CWD: "{{worktreePath}}",
      },
      continueOnError: true,
    }, { x: 200, y: 800 }),

    node("has-manual", "condition.expression", "Manual Conflicts Remain?", {
      expression:
        "(() => { const c = $data?.fileClassification; return c?.manual?.length > 0; })()",
    }, { x: 400, y: 800, outputs: ["yes", "no"] }),

    node("launch-agent", "action.run_agent", "SDK Agent: Resolve Conflicts", {
      prompt:
        "# Merge Conflict Resolution\n\n" +
        "You are resolving merge conflicts in a git worktree.\n\n" +
        "## Context\n" +
        "- **Working directory**: `{{worktreePath}}`\n" +
        "- **PR branch** (HEAD): `{{branch}}`\n" +
        "- **Base branch** (incoming): `origin/{{baseBranch}}`\n" +
        "- **PR**: #{{prNumber}}\n" +
        "- **Task**: {{taskTitle}}\n\n" +
        "## Conflicted files needing manual resolution:\n" +
        "{{manualFiles}}\n\n" +
        "## Instructions\n" +
        "1. Read both sides of each conflict carefully\n" +
        "2. Understand the INTENT of each change (feature vs upstream)\n" +
        "3. Write a correct resolution that preserves both intents\n" +
        "4. `git add` each resolved file\n" +
        "5. Run `git commit --no-edit` to finalize the merge\n" +
        "6. Do NOT use `--theirs` or `--ours` for code files\n" +
        "7. Ensure no conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) remain",
      sdk: "auto",
      timeoutMs: "{{timeoutMs}}",
      delegationWatchdogTimeoutMs: "{{delegationWatchdogTimeoutMs}}",
      delegationWatchdogMaxRecoveries: "{{delegationWatchdogMaxRecoveries}}",
      failOnError: true,
      continueOnError: true,
    }, { x: 200, y: 950 }),

    node("verify-clean", "action.run_command", "Verify No Markers", {
      command: "git grep -rl '^<<<<<<<\\|^=======\\|^>>>>>>>' -- . || echo CLEAN",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 200, y: 1100 }),

    node("markers-clean", "condition.expression", "Markers Clean?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('verify-clean')?.output || ''; " +
        "return out.trim() === 'CLEAN' || out.trim() === ''; })()",
    }, { x: 200, y: 1250, outputs: ["yes", "no"] }),

    node("push-result", "action.run_command", "Push Resolution", {
      command: "git push origin HEAD:{{branch}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
      maxRetries: 2,
      retryDelayMs: 10000,
    }, { x: 200, y: 1400 }),

    node("commit-auto-only", "action.run_command", "Commit Auto-Only Resolution", {
      command: "git commit --no-edit",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 600, y: 950 }),

    node("push-auto", "action.run_command", "Push Auto Resolution", {
      command: "git push origin HEAD:{{branch}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 600, y: 1100 }),

    node("notify-resolved", "notify.log", "Conflict Resolved", {
      message: "SDK conflict resolution succeeded for PR #{{prNumber}} on {{branch}}",
      level: "info",
    }, { x: 400, y: 1550 }),

    node("escalate-cooldown", "notify.log", "On Cooldown", {
      message: "SDK conflict resolution skipped — cooldown active for {{branch}}",
      level: "warn",
    }, { x: 700, y: 200 }),

    node("escalate-exhausted", "notify.telegram", "Max Attempts Reached", {
      message:
        ":warning: Merge conflicts on **{{branch}}** (PR #{{prNumber}}) " +
        "could not be resolved after {{maxAttempts}} SDK attempts. " +
        "Manual intervention required.",
    }, { x: 700, y: 350 }),

    node("escalate-markers", "notify.telegram", "Markers Still Present", {
      message:
        ":alert: SDK agent resolved conflicts on **{{branch}}** but conflict " +
        "markers remain. Manual review needed for PR #{{prNumber}}.",
    }, { x: 500, y: 1400 }),

    node("chain-merge-strategy", "action.execute_workflow", "Re-evaluate Merge", {
      workflowId: "template-pr-merge-strategy",
      mode: "dispatch",
      input: "({prNumber: $data?.prNumber, branch: $data?.branch, baseBranch: $data?.baseBranch})",
    }, { x: 200, y: 1550 }),
  ],
  edges: [
    edge("trigger", "check-cooldown"),
    edge("check-cooldown", "escalate-cooldown", { condition: "$output?.result === true", port: "yes" }),
    edge("check-cooldown", "check-attempts", { condition: "$output?.result !== true", port: "no" }),
    edge("check-attempts", "escalate-exhausted", { condition: "$output?.result === true", port: "yes" }),
    edge("check-attempts", "get-conflicts", { condition: "$output?.result !== true", port: "no" }),
    edge("get-conflicts", "classify-files"),
    edge("classify-files", "auto-resolve"),
    edge("auto-resolve", "has-manual"),
    edge("has-manual", "launch-agent", { condition: "$output?.result === true", port: "yes" }),
    edge("has-manual", "commit-auto-only", { condition: "$output?.result !== true", port: "no" }),
    edge("launch-agent", "verify-clean"),
    edge("verify-clean", "markers-clean"),
    edge("markers-clean", "push-result", { condition: "$output?.result === true", port: "yes" }),
    edge("markers-clean", "escalate-markers", { condition: "$output?.result !== true", port: "no" }),
    edge("push-result", "chain-merge-strategy"),
    edge("chain-merge-strategy", "notify-resolved"),
    edge("commit-auto-only", "push-auto"),
    edge("push-auto", "notify-resolved"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "merge", "conflict", "sdk", "agent", "resolution"],
    requiredTemplates: ["template-pr-merge-strategy"],
    replaces: {
      module: "sdk-conflict-resolver.mjs",
      functions: [
        "resolveConflictsWithSDK",
        "buildSDKConflictPrompt",
        "isSDKResolutionOnCooldown",
        "isSDKResolutionExhausted",
      ],
      calledFrom: [
        "conflict-resolver.mjs:resolveConflicts",
        "monitor.mjs:handleMergeConflict",
      ],
      description:
        "Replaces the imperative sdk-conflict-resolver.mjs with a visual " +
        "workflow. File classification, auto-resolve, SDK agent launch, " +
        "marker verification, and push become auditable nodes. Chains " +
        "into PR Merge Strategy after successful resolution.",
    },
  },
};



