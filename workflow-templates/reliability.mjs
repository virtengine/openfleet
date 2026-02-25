/**
 * reliability.mjs — Reliability & maintenance workflow templates.
 *
 * Templates:
 *   - Error Recovery (recommended)
 *   - Anomaly Watchdog (recommended)
 *   - Workspace Hygiene (recommended)
 *   - Health Check
 *   - Incident Response (recommended)
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Error Recovery
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const ERROR_RECOVERY_TEMPLATE = {
  id: "template-error-recovery",
  name: "Error Recovery",
  description:
    "Automated error recovery flow when an agent crashes or fails. " +
    "Analyzes logs, attempts auto-fix, and escalates if needed.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    maxRetries: 3,
  },
  nodes: [
    node("trigger", "trigger.event", "Agent Failed", {
      eventType: "task.failed",
    }, { x: 400, y: 50 }),

    node("check-retries", "condition.expression", "Retries Left?", {
      expression: "($data?.retryCount || 0) < ($data?.maxRetries || 3)",
    }, { x: 400, y: 180 }),

    node("analyze-error", "action.run_agent", "Analyze Failure", {
      prompt: "Analyze the following error and suggest a fix:\n\n{{lastError}}\n\nTask: {{taskTitle}}",
      timeoutMs: 300000,
    }, { x: 200, y: 330 }),

    node("retry-task", "action.run_agent", "Retry Task", {
      prompt: "{{taskExecutorRetryPrompt}}",
      timeoutMs: 3600000,
    }, { x: 200, y: 480 }),

    node("escalate", "notify.telegram", "Escalate to Human", {
      message: "🚨 Task **{{taskTitle}}** failed after {{maxRetries}} attempts. Manual intervention needed.\n\nLast error: {{lastError}}",
    }, { x: 600, y: 180 }),
  ],
  edges: [
    edge("trigger", "check-retries"),
    edge("check-retries", "analyze-error", { condition: "$output?.result === true" }),
    edge("check-retries", "escalate", { condition: "$output?.result !== true" }),
    edge("analyze-error", "retry-task"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["error", "recovery", "autofix"],
    replaces: {
      module: "monitor.mjs",
      functions: ["runCodexRecovery"],
      calledFrom: ["monitor.mjs:runMonitorMonitorCycle"],
      description: "Replaces hardcoded error recovery logic. " +
        "Retry/escalate decisions are now visual workflow branches.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Anomaly Watchdog (death-loop / stall detection)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const ANOMALY_WATCHDOG_TEMPLATE = {
  id: "template-anomaly-watchdog",
  name: "Anomaly Watchdog",
  description:
    "Real-time anomaly detection for agent sessions — catches death loops, " +
    "stalls, token overflows, rebase spirals, and thought spinning. " +
    "Automatically intervenes or escalates depending on severity.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    stallThresholdMs: 300000,
    maxTokenUsage: 0.9,
    maxConsecutiveErrors: 5,
  },
  nodes: [
    node("trigger", "trigger.event", "Agent Anomaly Detected", {
      eventType: "agent.anomaly",
      filter: "$event?.severity === 'high' || $event?.severity === 'critical'",
    }, { x: 400, y: 50 }),

    node("classify", "condition.switch", "Classify Anomaly", {
      value: "$data?.anomalyType || 'unknown'",
      cases: {
        "DEATH_LOOP": "death-loop",
        "STALL": "stall",
        "TOKEN_OVERFLOW": "token-overflow",
        "REBASE_SPIRAL": "rebase-spiral",
        "THOUGHT_SPIN": "thought-spin",
      },
    }, { x: 400, y: 200, outputs: ["death-loop", "stall", "token-overflow", "rebase-spiral", "thought-spin", "default"] }),

    node("kill-and-restart", "action.restart_agent", "Kill & Restart Agent", {
      sessionId: "{{sessionId}}",
      reason: "Death loop detected — agent cycling through the same error pattern",
      prompt: "The previous session entered a death loop. Start fresh with a different approach.\n\nOriginal task: {{taskTitle}}",
    }, { x: 100, y: 380 }),

    node("nudge-stall", "action.continue_session", "Nudge Stalled Agent", {
      sessionId: "{{sessionId}}",
      prompt: "You appear to be stalled. Please continue working on the current task. If you are stuck, describe the blocker and try a different approach.",
      strategy: "continue",
    }, { x: 300, y: 380 }),

    node("trim-context", "action.continue_session", "Trim Context & Continue", {
      sessionId: "{{sessionId}}",
      prompt: "Your context window is nearly full. Summarize your progress so far in 2-3 sentences, then continue with the most critical remaining work.",
      strategy: "refine",
    }, { x: 500, y: 380 }),

    node("fix-rebase", "action.run_command", "Fix Stuck Rebase", {
      command: "git rebase --abort 2>/dev/null; git reset --hard HEAD; git checkout -B {{branch}} origin/{{branch}} 2>/dev/null || true",
      cwd: "{{worktreePath}}",
    }, { x: 700, y: 380 }),

    node("break-spin", "action.continue_session", "Break Thought Spin", {
      sessionId: "{{sessionId}}",
      prompt: "Stop your current analysis. You are repeating the same reasoning. Take a concrete action NOW:\n1. Make a specific code change, OR\n2. Run a specific command, OR\n3. Report that you are blocked and need help.\nDo NOT continue analyzing.",
      strategy: "continue",
    }, { x: 900, y: 380 }),

    node("log-intervention", "notify.log", "Log Intervention", {
      message: "Anomaly watchdog intervened: {{anomalyType}} for session {{sessionId}}",
      level: "warn",
    }, { x: 400, y: 550 }),

    node("alert-telegram", "notify.telegram", "Alert Human", {
      message: "⚠️ Agent anomaly detected: **{{anomalyType}}**\nSession: {{sessionId}}\nTask: {{taskTitle}}\nIntervention: auto-applied",
    }, { x: 400, y: 700 }),
  ],
  edges: [
    edge("trigger", "classify"),
    edge("classify", "kill-and-restart", { port: "death-loop" }),
    edge("classify", "nudge-stall", { port: "stall" }),
    edge("classify", "trim-context", { port: "token-overflow" }),
    edge("classify", "fix-rebase", { port: "rebase-spiral" }),
    edge("classify", "break-spin", { port: "thought-spin" }),
    edge("kill-and-restart", "log-intervention"),
    edge("nudge-stall", "log-intervention"),
    edge("trim-context", "log-intervention"),
    edge("fix-rebase", "log-intervention"),
    edge("break-spin", "log-intervention"),
    edge("log-intervention", "alert-telegram"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["anomaly", "watchdog", "death-loop", "stall", "reliability"],
    replaces: {
      module: "anomaly-detector.mjs",
      functions: ["AnomalyDetector.processLine", "onAnomaly callback"],
      calledFrom: ["monitor.mjs:startAgentAlertTailer"],
      description: "Replaces hardcoded anomaly detection responses with a visual " +
        "workflow. Each anomaly type (death loop, stall, token overflow, rebase " +
        "spiral, thought spin) routes to a specific intervention node.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Workspace Hygiene (maintenance + reaper)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const WORKSPACE_HYGIENE_TEMPLATE = {
  id: "template-workspace-hygiene",
  name: "Workspace Hygiene",
  description:
    "Scheduled maintenance sweep: prune orphaned worktrees, kill stale " +
    "processes, rotate logs, and clean up old agent evidence. Keeps " +
    "your dev environment lean.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    staleProcessMaxAge: "15m",
    worktreeMaxAge: "48h",
    logRetentionDays: 7,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Daily Cleanup", {
      intervalMs: 86400000,
      cron: "0 3 * * *",
    }, { x: 400, y: 50 }),

    node("prune-worktrees", "action.run_command", "Prune Worktrees", {
      command: "git worktree prune && git worktree list --porcelain | grep -c worktree || echo 0",
    }, { x: 150, y: 200 }),

    node("kill-stale", "action.run_command", "Kill Stale Processes", {
      command: "bosun maintenance --kill-stale --max-age {{staleProcessMaxAge}}",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("rotate-logs", "action.run_command", "Rotate Agent Logs", {
      command: "find .bosun/logs -name '*.log' -mtime +{{logRetentionDays}} -delete 2>/dev/null; echo 'Rotated'",
      continueOnError: true,
    }, { x: 650, y: 200 }),

    node("clean-evidence", "action.run_command", "Clean Old Evidence", {
      command: "find .bosun/evidence -type f -mtime +14 -delete 2>/dev/null; echo 'Cleaned'",
      continueOnError: true,
    }, { x: 150, y: 380 }),

    node("check-disk", "action.run_command", "Check Disk Usage", {
      command: "du -sh .bosun/ 2>/dev/null || dir /s .bosun 2>nul",
    }, { x: 400, y: 380 }),

    node("gc-git", "action.run_command", "Git GC", {
      command: "git gc --auto --quiet",
      continueOnError: true,
    }, { x: 650, y: 380 }),

    node("summary", "notify.log", "Log Summary", {
      message: "Workspace hygiene sweep completed",
      level: "info",
    }, { x: 400, y: 540 }),
  ],
  edges: [
    edge("trigger", "prune-worktrees"),
    edge("trigger", "kill-stale"),
    edge("trigger", "rotate-logs"),
    edge("prune-worktrees", "clean-evidence"),
    edge("kill-stale", "check-disk"),
    edge("rotate-logs", "gc-git"),
    edge("clean-evidence", "summary"),
    edge("check-disk", "summary"),
    edge("gc-git", "summary"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["maintenance", "cleanup", "worktree", "hygiene"],
    replaces: {
      module: "maintenance.mjs",
      functions: ["runMaintenanceSweep", "killStaleOrchestrators", "reapStuckGitPushes", "cleanupWorktrees"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the hardcoded maintenance sweep with a visual workflow. " +
        "Worktree pruning, stale process cleanup, log rotation, and git gc " +
        "become explicit, configurable workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Health Check & Config Doctor
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const HEALTH_CHECK_TEMPLATE = {
  id: "template-health-check",
  name: "Health Check",
  description:
    "Periodic system health check: validates config, verifies SDK " +
    "availability, checks git state, and reports any issues found.",
  category: "reliability",
  enabled: true,
  trigger: "trigger.schedule",
  variables: {
    intervalMs: 3600000,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Hourly Health Check", {
      intervalMs: 3600000,
      cron: "0 * * * *",
    }, { x: 400, y: 50 }),

    node("check-config", "action.bosun_cli", "Check Config", {
      subcommand: "doctor",
      args: "--json",
    }, { x: 150, y: 200 }),

    node("check-git", "action.run_command", "Check Git State", {
      command: "node -e \"const cp=require('node:child_process');const status=cp.execSync('git status --porcelain',{encoding:'utf8'});const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(status + (status.endsWith('\\\\n') ? '' : '\\\\n') + count + '\\\\n');\"",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("check-agents", "action.run_command", "Check Agent Status", {
      command: "node -e \"const cp=require('node:child_process');try{process.stdout.write(cp.execSync('bosun --daemon-status',{encoding:'utf8'}));}catch{process.stdout.write('daemon not running\\\\n');}\"",
      continueOnError: true,
    }, { x: 650, y: 200 }),

    node("has-issues", "condition.expression", "Any Issues?", {
      expression: "($ctx.getNodeOutput('check-config')?.success === false) || (($ctx.getNodeOutput('check-config')?.output || '').includes('ERROR')) || (($ctx.getNodeOutput('check-config')?.output || '').includes('CRITICAL')) || ($ctx.getNodeOutput('check-git')?.success === false) || ($ctx.getNodeOutput('check-agents')?.success === false)",
    }, { x: 400, y: 380 }),

    node("alert", "notify.telegram", "Alert Issues Found", {
      message: "🏥 Health check found issues — run `bosun doctor` for details",
    }, { x: 200, y: 540 }),

    node("all-ok", "notify.telegram", "All Healthy", {
      message: "Health check passed — all systems operational",
      level: "info",
    }, { x: 600, y: 540 }),
  ],
  edges: [
    edge("trigger", "check-config"),
    edge("trigger", "check-git"),
    edge("trigger", "check-agents"),
    edge("check-config", "has-issues"),
    edge("check-git", "has-issues"),
    edge("check-agents", "has-issues"),
    edge("has-issues", "alert", { condition: "$output?.result === true" }),
    edge("has-issues", "all-ok", { condition: "$output?.result !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["health", "config", "doctor", "monitoring"],
    replaces: {
      module: "config-doctor.mjs",
      functions: ["runConfigDoctor"],
      calledFrom: ["cli.mjs:doctor command"],
      description: "Replaces manual config-doctor runs with a scheduled health " +
        "check workflow. Config validation, git state, and agent status " +
        "checks run in parallel with automatic alerting.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Incident Response
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const INCIDENT_RESPONSE_TEMPLATE = {
  id: "template-incident-response",
  name: "Incident Response",
  description:
    "Automated incident management: detects error spikes or anomalous " +
    "patterns, creates an incident task, assigns an agent for investigation, " +
    "collects evidence, and escalates via notification channels.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.anomaly",
  variables: {
    errorThreshold: 5,
    escalationDelayMs: 600000,
    autoAssignAgent: true,
  },
  nodes: [
    node("trigger", "trigger.anomaly", "Error Spike Detected", {
      anomalyTypes: ["error-spike", "death-loop", "agent-stall"],
      threshold: "{{errorThreshold}}",
    }, { x: 400, y: 50 }),

    node("collect-evidence", "agent.evidence_collect", "Collect Evidence", {
      sources: ["logs", "git-status", "process-list", "recent-errors"],
      lookbackMinutes: 30,
    }, { x: 400, y: 200 }),

    node("classify-incident", "action.run_agent", "Classify Incident", {
      prompt: `# Incident Classification

Analyze the collected evidence:
{{evidence}}

Classify the incident:
1. **SEVERITY**: critical / high / medium / low
2. **CATEGORY**: agent-crash / build-failure / resource-exhaustion / stuck-process / unknown
3. **ROOT CAUSE**: One-line hypothesis
4. **IMPACT**: What is affected and who is impacted
5. **RECOMMENDED ACTION**: Immediate steps to mitigate

Output as JSON: { "severity": "...", "category": "...", "rootCause": "...", "impact": "...", "action": "..." }`,
      sdk: "auto",
      timeoutMs: 300000,
    }, { x: 400, y: 370 }),

    node("is-critical", "condition.expression", "Is Critical?", {
      expression: "($ctx.getNodeOutput('classify-incident')?.output || '').includes('\"severity\": \"critical\"') || ($ctx.getNodeOutput('classify-incident')?.output || '').includes('\"severity\":\"critical\"')",
    }, { x: 400, y: 540, outputs: ["yes", "no"] }),

    node("create-incident-task", "action.create_task", "Create Incident Task", {
      title: "🚨 Incident: {{incidentCategory}}",
      description: "Auto-detected incident.\n\nEvidence: {{evidence}}\n\nClassification: {{classification}}",
      tags: ["incident", "auto-detected"],
      priority: "high",
    }, { x: 400, y: 690 }),

    node("assign-agent", "action.run_agent", "Investigate & Mitigate", {
      prompt: `# Incident Investigation

An incident has been detected and classified:
{{classification}}

Evidence collected:
{{evidence}}

Your task:
1. Investigate the root cause in detail
2. Apply immediate mitigation if safe to do so
3. Document what you find and what you changed
4. If you cannot resolve it, document what you know for human review

Be conservative — prefer safe mitigations over aggressive fixes.`,
      sdk: "auto",
      timeoutMs: 1800000,
    }, { x: 250, y: 840 }),

    node("alert-critical", "notify.telegram", "Critical Incident Alert", {
      message: "🚨 **CRITICAL INCIDENT**\n\nCategory: {{incidentCategory}}\nRoot cause: {{rootCause}}\n\nAgent investigating. Immediate attention may be required.",
    }, { x: 150, y: 540 }),

    node("alert-standard", "notify.log", "Log Incident", {
      message: "Incident detected (non-critical): {{incidentCategory}} — agent assigned",
      level: "warn",
    }, { x: 600, y: 690 }),

    node("resolution-log", "notify.log", "Log Resolution", {
      message: "Incident response complete — see task for details",
      level: "info",
    }, { x: 400, y: 990 }),
  ],
  edges: [
    edge("trigger", "collect-evidence"),
    edge("collect-evidence", "classify-incident"),
    edge("classify-incident", "is-critical"),
    edge("is-critical", "alert-critical", { condition: "$output?.result === true", port: "yes" }),
    edge("is-critical", "create-incident-task", { condition: "$output?.result !== true", port: "no" }),
    edge("alert-critical", "create-incident-task"),
    edge("create-incident-task", "alert-standard"),
    edge("create-incident-task", "assign-agent"),
    edge("assign-agent", "resolution-log"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["incident", "response", "detection", "escalation", "reliability"],
    replaces: {
      module: "error-detector.mjs",
      functions: ["handleErrorSpike", "escalateAnomaly"],
      calledFrom: ["anomaly-detector.mjs:onAnomaly"],
      description:
        "Replaces reactive error handling with a structured incident response " +
        "workflow. Evidence collection, classification, task creation, and " +
        "agent assignment become explicit, auditable steps.",
    },
  },
};
