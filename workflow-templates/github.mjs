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
      seconds: "{{cooldownSec}}",
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
    ":alert: SUPERSEDED for bosun-managed repos — use the Bosun PR Watchdog " +
    "(template-bosun-pr-watchdog) instead. The Watchdog consolidates conflict " +
    "resolution, CI-failure repair, diff-safety review, and merge into one " +
    "cycle with a single gh API call and a mandatory review gate before any merge. " +
    "This template is kept for repos that do not use the bosun-attached label " +
    "convention. It ONLY touches PRs labelled bosun-attached and never " +
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

    // Only fetch bosun-attached PRs — never touch external-contributor PRs.
    // Includes labels so we can skip PRs already tagged bosun-needs-fix (watchdog owns those).
    node("list-prs", "action.run_command", "List Bosun-Attached Conflicting PRs", {
      command:
        "gh pr list --label bosun-attached --state open " +
        "--json number,title,headRefName,baseRefName,mergeable,labels --limit {{maxConcurrentFixes}}",
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
        "  /* Skip PRs already owned by the watchdog fix agent */" +
        "  const pr = prs.find((p) =>" +
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
        "- Do NOT touch PRs that do not have the bosun-attached label.",
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
      message: "PR Conflict Resolver: no unhandled bosun-attached conflicts found",
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
        "v2: Restricted to bosun-attached PRs only — never touches external-contributor PRs. " +
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
    "Scans open bosun-attached PRs on a schedule. Makes one gh pr list call " +
    "per target repo to fetch and classify PRs, then: labels conflicting or failing-CI PRs " +
    "with bosun-needs-fix and dispatches a repair agent; sends merge candidates " +
    "through a MANDATORY agent review gate that checks diff stats before any " +
    "merge — preventing destructive PRs (e.g. -183k lines) from being silently " +
    "auto-merged. External-contributor PRs without bosun-attached are never touched.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    mergeMethod:        "squash",                   // squash | merge | rebase
    labelNeedsFix:      "bosun-needs-fix",           // applied to CI failures and conflicts
    labelNeedsReview:   "bosun-needs-human-review",  // applied when review agent flags a suspicious diff
    // auto: active workspace repos from bosun.config.json (fallback current repo)
    // all/current/<owner/repo>/comma,list also supported.
    repoScope:          "auto",
    maxPrs:             25,
    intervalMs:         300_000,                    // 5 minutes
    // Merge-safety thresholds checked by the review agent:
    // If net deletions > additions × ratio AND deletions > minDestructiveDeletions → HOLD
    suspiciousDeletionRatio: 3,    // e.g. deletes 3× more lines than it adds
    minDestructiveDeletions: 500,  // absolute floor — small PRs are fine even if net negative
  },
  nodes: [
    node("trigger", "trigger.schedule", "Poll Every 5 min", {
      intervalMs: "{{intervalMs}}",
      cron: "*/5 * * * *",
    }, { x: 400, y: 50 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: One gh pr list per target repo, then classify+label in-memory.
    // This avoids duplicate fetches and keeps per-cycle gh traffic bounded.
    // ─────────────────────────────────────────────────────────────────────────
    node("fetch-and-classify", "action.run_command", "Fetch, Classify & Label PRs", {
      // Fetches all open bosun-attached PRs with every field needed for
      // classification. Runs one list call per target repo (auto-discovered
      // from bosun.config.json workspaces by default), then:
      //   • Classifies each PR into: ready | conflict | ci_failure | pending | draft
      //   • Labels conflict/ci_failure PRs with bosun-needs-fix (skips if already present)
      //   • Outputs a JSON summary used by all downstream nodes/agents
      // Total gh API calls this node makes: R list calls + N edits
      // (R = target repos, N = newly-broken PRs needing fix label).
      command: [
        "node -e \"",
        "const fs=require('fs');",
        "const path=require('path');",
        "const {execFileSync}=require('child_process');",
        "const LABEL_FIX='{{labelNeedsFix}}';",
        "const MAX_PRS=Math.max(1,Number('{{maxPrs}}')||25);",
        "const REPO_SCOPE=String('{{repoScope}}'||'auto').trim();",
        "const FIELDS='number,title,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,labels,url';",
        "const FAIL_STATES=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const PEND_STATES=new Set(['PENDING','IN_PROGRESS','QUEUED','WAITING','REQUESTED','EXPECTED']);",
        "const CONFLICT_MERGEABLES=new Set(['CONFLICTING','BEHIND','DIRTY']);",
        "function ghJson(args){const out=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();return out?JSON.parse(out):[];}",
        "function configPath(){",
        "  const home=String(process.env.BOSUN_HOME||process.env.VK_PROJECT_DIR||'').trim();",
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
        "  const args=['pr','list','--label','bosun-attached','--state','open','--json',FIELDS,'--limit',String(MAX_PRS)];",
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
        "const readyCandidates=[],conflicts=[],ciFailures=[],pending=[],drafted=[];",
        "let newlyLabeled=0;",
        "for(const pr of prs){",
        "  const labels=(pr.labels||[]).map(l=>typeof l==='string'?l:l?.name).filter(Boolean);",
        "  const hasFixLabel=labels.includes(LABEL_FIX);",
        "  const checks=pr.statusCheckRollup||[];",
        "  const hasFail=checks.some(c=>FAIL_STATES.has(c.conclusion||c.state||''));",
        "  const hasPend=checks.some(c=>PEND_STATES.has(c.conclusion||c.state||''));",
        "  const isConflict=CONFLICT_MERGEABLES.has(String(pr.mergeable||'').toUpperCase());",
        "  const isDraft=pr.isDraft===true;",
        "  const repo=String(pr.__repo||'').trim();",
        "  if(isDraft){drafted.push({n:pr.number,repo});continue;}",
        "  if(isConflict){",
        "    conflicts.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url});",
        "    if(!hasFixLabel){",
        "      try{const editArgs=['pr','edit',String(pr.number),'--add-label',LABEL_FIX];if(repo)editArgs.push('--repo',repo);execFileSync('gh',editArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});newlyLabeled++;}",
        "      catch(e){process.stderr.write('label err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\\\n');}",
        "    }",
        "  } else if(hasFail){",
        "    ciFailures.push({n:pr.number,repo,branch:pr.headRefName,url:pr.url});",
        "    if(!hasFixLabel){",
        "      try{const editArgs=['pr','edit',String(pr.number),'--add-label',LABEL_FIX];if(repo)editArgs.push('--repo',repo);execFileSync('gh',editArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});newlyLabeled++;}",
        "      catch(e){process.stderr.write('label err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\\\n');}",
        "    }",
        "  } else if(hasPend){",
        "    pending.push({n:pr.number,repo});",
        "  } else if(checks.length>0&&!hasFixLabel){",
        "    readyCandidates.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url,title:pr.title});",
        "  }",
        "}",
        "console.log(JSON.stringify({",
        "  total:prs.length,",
        "  reposScanned:repoTargets.length,",
        "  repoErrors,",
        "  readyCandidates,",
        "  conflicts,",
        "  ciFailures,",
        "  pending:pending.length,",
        "  drafted:drafted.length,",
        "  newlyLabeled,",
        "  fixNeeded:conflicts.length+ciFailures.length",
        "}));",
        "\"",
      ].join(" "),
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
    // STEP 2a: Fix path — dispatch ONE agent for all conflicts + CI failures.
    // The agent handles rebase/conflict-resolution AND CI lint/test fixes.
    // ─────────────────────────────────────────────────────────────────────────
    node("fix-needed", "condition.expression", "Fix Needed?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').fixNeeded||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 200, y: 530 }),

    node("dispatch-fix", "action.run_agent", "Dispatch Fix Agent", {
      prompt:
        "You are a Bosun PR repair agent. A watchdog workflow has identified " +
        "bosun-attached PRs that need fixing.\n\n" +
        "For EACH target repo, list PRs needing work. Always include --repo <owner/repo>.\n" +
        "Example:\n" +
        "  gh pr list --repo <owner/repo> --label bosun-needs-fix --label bosun-attached --state open \\\n" +
        "    --json number,title,headRefName,baseRefName,mergeable,statusCheckRollup,labels,url \\\n" +
        "    --limit 10\n\n" +
        "For each PR returned, follow the appropriate path:\n\n" +
        "CONFLICT (mergeable is CONFLICTING, BEHIND, or DIRTY):\n" +
        "1. git fetch origin\n" +
        "2. git checkout <headRefName>\n" +
        "3. git rebase origin/<baseRefName>  (or git merge origin/<baseRefName> if rebase is too complex)\n" +
        "4. Resolve merge conflicts, preserving the intent of both sides.\n" +
        "5. Run the repo's build + test suite to confirm nothing is broken.\n" +
        "6. git push --force-with-lease origin <headRefName>\n\n" +
        "CI FAILURE (statusCheckRollup has FAILURE/ERROR/TIMED_OUT entries):\n" +
        "1. git checkout <headRefName>\n" +
        "2. Inspect CI logs: gh run list --repo <owner/repo> --branch <headRefName> --limit 3\n" +
        "   Then: gh run view <run-id> --repo <owner/repo> --log-failed\n" +
        "3. Fix the root cause (lint, type error, failing test, build error).\n" +
        "4. Commit: fix(<scope>): <description>  (conventional commit format)\n" +
        "5. Push the branch — CI will re-trigger automatically.\n\n" +
        "AFTER fixing either type:\n" +
        "- Remove the bosun-needs-fix label: gh pr edit <number> --repo <owner/repo> --remove-label bosun-needs-fix\n\n" +
        "STRICT RULES:\n" +
        "- Fix only what breaks CI or causes the conflict. No scope creep.\n" +
        "- Do NOT merge, close, or approve any PR.\n" +
        "- Do NOT touch PRs that do not have the bosun-attached label.\n" +
        "- If a conflict cannot be resolved cleanly, leave it labeled and add a comment explaining why.",
      sdk: "auto",
      timeoutMs: 1_800_000,
      maxRetries: 2,
      retryDelayMs: 30_000,
      continueOnError: true,
    }, { x: 200, y: 700 }),

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

    node("dispatch-review", "action.run_agent", "Review Gate: Inspect & Merge", {
      prompt:
        "You are the Bosun PR merge review agent — the LAST LINE OF DEFENCE before " +
        "any PR is merged. Your job is to inspect each merge candidate and decide " +
        "whether it is safe to merge.\n\n" +
        "MERGE CANDIDATES (CI passing, no conflicts, bosun-attached):\n" +
        "  Run per target repo: gh pr list --repo <owner/repo> --label bosun-attached --state open \\\n" +
        "    --json number,title,headRefName,isDraft,statusCheckRollup,labels,url \\\n" +
        "    --limit {{maxPrs}}\n" +
        "  Filter to PRs where: not isDraft, CI all-passing, no bosun-needs-fix label.\n\n" +
        "FOR EACH CANDIDATE — before merging, run:\n" +
        "  gh pr view <number> --repo <owner/repo> --json number,title,additions,deletions,changedFiles,body,baseRefName\n\n" +
        "SAFETY CHECKS (ALL must pass before merging):\n\n" +
        "1. DESTRUCTIVE DIFF CHECK:\n" +
        "   If (deletions > additions × {{suspiciousDeletionRatio}}) AND (deletions > {{minDestructiveDeletions}}):\n" +
        "   → This PR deletes far more than it adds — HOLD IT.\n" +
        "   → Run: gh pr edit <number> --repo <owner/repo> --add-label {{labelNeedsReview}}\n" +
        "   → Run: gh pr comment <number> --repo <owner/repo> --body ':alert: **Bosun Review Agent: merge held** — " +
        "This PR deletes significantly more lines than it adds (deletions: <X>, additions: <Y>). " +
        "A human should verify this is intentional before merging.'\n" +
        "   → Do NOT merge this PR. Move to next candidate.\n\n" +
        "2. DIFF SANITY CHECK (for PRs that pass the ratio check):\n" +
        "   Run: gh pr diff <number> --repo <owner/repo> | head -200\n" +
        "   Look for: mass file deletions, removal of entire modules/directories, " +
        "   files changed that are unrelated to the PR description.\n" +
        "   If something looks wrong → HOLD with bosun-needs-human-review label + comment.\n\n" +
        "3. CI STATUS RECONFIRM:\n" +
        "   Run: gh pr checks <number> --repo <owner/repo> --json name,state,conclusion\n" +
        "   Ensure ALL checks have conclusion SUCCESS/SKIPPED/NEUTRAL. " +
        "   If any are pending or failing → do NOT merge (CI may still be running).\n\n" +
        "MERGE (only if ALL checks pass):\n" +
        "   gh pr merge <number> --repo <owner/repo> --{{mergeMethod}} --delete-branch\n" +
        "   Log: :check: Merged PR #<number> — <title>\n\n" +
        "STRICT RULES:\n" +
        "- NEVER merge if ANY safety check fails. When in doubt, HOLD.\n" +
        "- NEVER merge PRs without the bosun-attached label.\n" +
        "- NEVER merge draft PRs.\n" +
        "- The bosun-needs-human-review label means a human must look at it before bosun touches it again.\n" +
        "- After processing all candidates, output a summary: { merged: N, held: N, skipped: N }",
      sdk: "auto",
      timeoutMs: 1_200_000,
      maxRetries: 1,
      retryDelayMs: 30_000,
      continueOnError: true,
    }, { x: 600, y: 700 }),

    node("notify", "notify.telegram", "Watchdog Report", {
      message:
        ":bug: Bosun PR Watchdog cycle complete — " +
        "fix-dispatched: {{fixNeeded}} | candidates-reviewed: {{readyCandidates}}",
      silent: true,
    }, { x: 400, y: 900 }),

    node("no-prs", "notify.log", "No Bosun PRs Open", {
      message: "Bosun PR Watchdog: no open bosun-attached PRs found — idle",
      level: "info",
    }, { x: 700, y: 370 }),
  ],
  edges: [
    edge("trigger",          "fetch-and-classify"),
    edge("fetch-and-classify","has-prs"),
    edge("has-prs",          "fix-needed",      { condition: "$output?.result === true" }),
    edge("has-prs",          "no-prs",          { condition: "$output?.result !== true" }),
    // Fix path (conflicts + CI failures)
    edge("fix-needed",       "dispatch-fix",    { condition: "$output?.result === true" }),
    edge("fix-needed",       "review-needed",   { condition: "$output?.result !== true" }),
    edge("dispatch-fix",     "review-needed"),
    // Review gate (merge candidates)
    edge("review-needed",    "dispatch-review", { condition: "$output?.result === true" }),
    edge("review-needed",    "notify",          { condition: "$output?.result !== true" }),
    edge("dispatch-review",  "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 3,
    createdAt: "2025-07-01T00:00:00Z",
    templateVersion: "2.1.0",
    tags: ["github", "pr", "ci", "merge", "watchdog", "bosun-attached", "safety"],
    replaces: {
      module: "agent-hooks.mjs",
      functions: ["registerBuiltinHooks (PostPR block)"],
      calledFrom: [],
      description:
        "v2: Consolidates PR polling into one gh pr list fetch per target repo per cycle. " +
        "Adds mandatory review gate agent that checks diff stats (additions/deletions " +
        "ratio) and diff content before any merge — preventing destructive PRs from " +
        "being auto-merged. Adds conflict detection via the 'mergeable' field. " +
        "Single fix agent handles both conflict resolution and CI failures. " +
        "All external PRs (no bosun-attached label) are never touched.",
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
    "Marks tasks as in-review when bosun-attached PRs open, moves them to done " +
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
      command: [
        "node -e \"",
        "const {execFileSync}=require('child_process');",
        "const hours=Number('{{lookbackHours}}')||24;",
        "const repoScope=String('{{repoScope}}'||'auto').trim();",
        "const since=new Date(Date.now()-hours*3600000).toISOString();",
        "function ghJson(args){",
        "  try{const o=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();return o?JSON.parse(o):[];}",
        "  catch{return [];}",
        "}",
        "const merged=ghJson(['pr','list','--state','merged','--label','bosun-attached','--json','number,title,body,headRefName,mergedAt','--limit','50']);",
        "const open=ghJson(['pr','list','--state','open','--label','bosun-attached','--json','number,title,body,headRefName,isDraft','--limit','50']);",
        "function extractTaskId(pr){",
        "  const src=String((pr.body||'')+'\\n'+(pr.title||''));",
        "  const m=src.match(/(?:Bosun-Task|VE-Task|Task-ID|task[_-]?id)[:\\s]+([a-zA-Z0-9_-]{4,64})/i);",
        "  return m?m[1].trim():null;",
        "}",
        "const recentMerged=merged.filter(p=>!p.mergedAt||new Date(p.mergedAt)>=new Date(since));",
        "console.log(JSON.stringify({",
        "  repoScope,",
        "  merged:recentMerged.map(p=>({n:p.number,title:p.title,branch:p.headRefName,taskId:extractTaskId(p)})),",
        "  open:open.filter(p=>!p.isDraft).map(p=>({n:p.number,title:p.title,branch:p.headRefName,taskId:extractTaskId(p)})),",
        "}));",
        "\"",
      ].join(" "),
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

    node("sync-agent", "action.run_agent", "Sync PR State → Kanban", {
      prompt:
        "You are the Bosun GitHub-Kanban sync agent. Sync the kanban board " +
        "to match the GitHub PR state shown below.\n\n" +
        "PR state (JSON from fetch-pr-state node output):\n" +
        "{{$ctx.getNodeOutput('fetch-pr-state')?.output}}\n\n" +
        "RULES:\n" +
        "1. For each MERGED PR entry with a taskId: update the kanban task to done.\n" +
        "   Use the available bosun/vk CLI, for example:\n" +
        "     node task-cli.mjs update <taskId> --status done\n" +
        "   Or check available commands: ls *.mjs | grep -i task\n" +
        "2. For each OPEN (non-draft) PR entry with a taskId: if the task is not\n" +
        "   already in inreview or done status, update it to inreview.\n" +
        "3. Only act on entries that have a non-null taskId.\n" +
        "4. Log each update and whether it succeeded.\n" +
        "5. Do NOT close, merge, or modify any PR.\n" +
        "6. Do NOT create new tasks — only update existing ones.",
      sdk: "auto",
      timeoutMs: 300_000,
      continueOnError: true,
    }, { x: 400, y: 530 }),

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
    edge("has-updates", "sync-agent", { condition: "$output?.result === true" }),
    edge("has-updates", "skip", { condition: "$output?.result !== true" }),
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
