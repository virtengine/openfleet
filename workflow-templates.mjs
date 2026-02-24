/**
 * workflow-templates.mjs — Pre-built Workflow Templates for Bosun
 *
 * Ready-to-use workflow definitions that users can install with one click
 * from the visual builder. Each template encodes a complete flow that
 * previously required custom code or env-var configuration.
 *
 * Templates:
 *   1. pr-merge-strategy   — Automated PR merge decision (7 outcomes)
 *   2. pr-triage            — Classify, label, and detect breaking changes
 *   3. review-agent         — Automated PR review flow
 *   4. frontend-agent       — Front-end agent with screenshot validation
 *   5. task-planner         — Auto-replenish backlog when tasks run low
 *   6. task-replenish       — Experimental periodic task replenishment
 *   7. build-and-deploy     — Build, test, and deploy pipeline
 *   8. error-recovery       — Auto-fix after agent crash/failure
 *   9. custom-agent-profile — Template for creating custom agent profiles
 *
 * Categories: github, agents, planning, ci-cd, reliability, custom
 *
 * EXPORTS:
 *   WORKFLOW_TEMPLATES     — Array of all built-in templates
 *   TEMPLATE_CATEGORIES    — Category metadata (label, icon, order)
 *   getTemplate(id)        — Get a single template by ID
 *   installTemplate(id, engine) — Install a template into the workflow engine
 *   listTemplates()        — List all available templates
 */

import { randomUUID } from "node:crypto";

// ── Helper: Generate positioned nodes ───────────────────────────────────────

let _nextX = 100;
let _nextY = 100;

function node(id, type, label, config = {}, opts = {}) {
  const x = opts.x ?? _nextX;
  const y = opts.y ?? _nextY;
  _nextX = x + 280;
  return {
    id,
    type,
    label,
    config,
    position: { x, y },
    outputs: opts.outputs || ["default"],
    ...(opts.extra || {}),
  };
}

function edge(source, target, opts = {}) {
  return {
    id: `${source}->${target}`,
    source,
    target,
    sourcePort: opts.port || "default",
    condition: opts.condition || undefined,
  };
}

function resetLayout() { _nextX = 100; _nextY = 100; }

// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE 1: Frontend Agent with Screenshot Validation
// ═══════════════════════════════════════════════════════════════════════════

const FRONTEND_AGENT_TEMPLATE = {
  id: "template-frontend-agent",
  name: "Frontend Agent",
  description:
    "Front-end development agent that validates work by taking screenshots, " +
    "storing them as evidence, and having an independent model verify the " +
    "implementation matches the task requirements before marking complete.",
  category: "agents",
  enabled: true,
  trigger: "trigger.task_assigned",
  variables: {
    devServerUrl: "http://localhost:3000",
    evidenceDir: ".bosun/evidence",
    screenshotCount: 3,
  },
  nodes: [
    // Row 1: Trigger
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      agentType: "frontend",
      taskPattern: "feat\\(.*\\)|fix\\(.*\\)|style\\(.*\\)|ui|frontend|css|component",
    }, { x: 400, y: 50 }),

    // Row 2: Profile selection
    node("select-profile", "agent.select_profile", "Select Agent Profile", {
      profiles: {
        frontend: {
          titlePatterns: ["ui", "frontend", "css", "component", "page", "layout", "style", "design"],
          tags: ["frontend", "ui", "css", "component"],
        },
        fullstack: {
          titlePatterns: ["api.*ui", "full.?stack"],
          tags: ["fullstack"],
        },
      },
      default: "frontend",
    }, { x: 400, y: 160 }),

    // Row 3: Run the agent
    node("run-agent", "action.run_agent", "Run Frontend Agent", {
      prompt: `# Frontend Development Task

## Task: {{taskTitle}}

## Description
{{taskDescription}}

## Special Instructions
You are a **frontend specialist** agent. Your focus areas:
- HTML/CSS layout and styling
- JavaScript/TypeScript UI logic
- Component architecture and state management
- Responsive design and accessibility
- Visual accuracy matching design specifications

## CRITICAL: Evidence Collection
After completing your implementation:
1. Start the dev server if not running
2. Take screenshots of ALL pages/components you changed
3. Save each screenshot to \`.bosun/evidence/\` directory
4. Include screenshots of: main view, mobile view, any interactive states
5. Name files descriptively: \`homepage-desktop.png\`, \`modal-open.png\`, etc.

## Workflow
1. Read task requirements carefully
2. Implement all frontend changes
3. Run \`npm run build\` to verify no errors
4. Run \`npm run lint\` to verify no warnings
5. Start dev server and screenshot all changed pages
6. Commit and push

## Do NOT mark task complete yourself — the validation workflow handles that.`,
      sdk: "auto",
      cwd: "{{worktreePath}}",
      timeoutMs: 7200000,
      agentProfile: "frontend",
    }, { x: 400, y: 280 }),

    // Row 4: Verify build
    node("verify-build", "validation.build", "Verify Build", {
      command: "npm run build",
      cwd: "{{worktreePath}}",
      zeroWarnings: true,
    }, { x: 150, y: 420 }),

    // Row 4: Verify lint
    node("verify-lint", "validation.lint", "Verify Lint", {
      command: "npm run lint",
      cwd: "{{worktreePath}}",
    }, { x: 650, y: 420 }),

    // Row 5: Screenshot capture (multiple views)
    node("screenshot-desktop", "validation.screenshot", "Screenshot Desktop", {
      url: "{{devServerUrl}}",
      outputDir: "{{evidenceDir}}",
      filename: "desktop-{{taskId}}.png",
      viewport: { width: 1920, height: 1080 },
    }, { x: 100, y: 560 }),

    node("screenshot-tablet", "validation.screenshot", "Screenshot Tablet", {
      url: "{{devServerUrl}}",
      outputDir: "{{evidenceDir}}",
      filename: "tablet-{{taskId}}.png",
      viewport: { width: 768, height: 1024 },
    }, { x: 400, y: 560 }),

    node("screenshot-mobile", "validation.screenshot", "Screenshot Mobile", {
      url: "{{devServerUrl}}",
      outputDir: "{{evidenceDir}}",
      filename: "mobile-{{taskId}}.png",
      viewport: { width: 375, height: 812 },
    }, { x: 700, y: 560 }),

    // Row 6: Collect all evidence
    node("collect-evidence", "agent.evidence_collect", "Collect Evidence", {
      evidenceDir: "{{evidenceDir}}",
    }, { x: 400, y: 700 }),

    // Row 7: Model review — independent verification
    node("model-review", "validation.model_review", "Model Verification", {
      evidenceDir: "{{evidenceDir}}",
      originalTask: "{{taskTitle}}: {{taskDescription}}",
      criteria: "Visual implementation matches requirements. No broken layouts. Responsive design works across viewports. No console errors visible.",
      strictMode: true,
    }, { x: 400, y: 840 }),

    // Row 8: Conditional — pass or fail
    node("check-review", "condition.expression", "Review Passed?", {
      expression: "$output?.model_review?.passed === true || $data?.modelReviewPassed === true",
    }, { x: 400, y: 960 }),

    // Row 9a: Success path
    node("mark-success", "action.update_task_status", "Mark Task Done", {
      taskId: "{{taskId}}",
      status: "done",
    }, { x: 200, y: 1080 }),

    node("notify-success", "notify.telegram", "Notify Success", {
      message: "✅ Frontend task **{{taskTitle}}** passed visual verification and is complete.",
    }, { x: 200, y: 1200 }),

    // Row 9b: Failure path
    node("notify-failure", "notify.telegram", "Notify Review Failed", {
      message: "❌ Frontend task **{{taskTitle}}** failed visual verification. Review evidence in .bosun/evidence/",
    }, { x: 600, y: 1080 }),

    node("log-failure", "notify.log", "Log Failure", {
      message: "Frontend verification failed for {{taskId}}: review output in evidence dir",
      level: "warn",
    }, { x: 600, y: 1200 }),
  ],
  edges: [
    edge("trigger", "select-profile"),
    edge("select-profile", "run-agent"),
    edge("run-agent", "verify-build"),
    edge("run-agent", "verify-lint"),
    edge("verify-build", "screenshot-desktop"),
    edge("verify-build", "screenshot-tablet"),
    edge("verify-build", "screenshot-mobile"),
    edge("verify-lint", "screenshot-desktop"),
    edge("screenshot-desktop", "collect-evidence"),
    edge("screenshot-tablet", "collect-evidence"),
    edge("screenshot-mobile", "collect-evidence"),
    edge("collect-evidence", "model-review"),
    edge("model-review", "check-review"),
    edge("check-review", "mark-success", { condition: "$output?.result === true" }),
    edge("check-review", "notify-failure", { condition: "$output?.result !== true" }),
    edge("mark-success", "notify-success"),
    edge("notify-failure", "log-failure"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["frontend", "agent", "validation", "screenshot"],
    replaces: {
      module: "agent-hooks.mjs",
      functions: ["screenshotValidation", "evidenceCollection"],
      calledFrom: ["monitor.mjs:startFreshSession"],
      description: "Replaces hardcoded frontend agent profile with a visual workflow. " +
        "Screenshot capture, model verification, and evidence collection are explicit steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE 2: Task Planner (auto-replenish backlog)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const TASK_PLANNER_TEMPLATE = {
  id: "template-task-planner",
  name: "Task Planner",
  description:
    "Automatically generates new backlog tasks when the todo count drops " +
    "below a configurable threshold. Replaces the previous hardcoded " +
    "TASK_PLANNER_MODE / REPLENISH_ENABLED env-var system.",
  category: "planning",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_low",
  variables: {
    minTodoCount: 3,
    taskCount: 5,
    dedupHours: 24,
  },
  nodes: [
    node("trigger", "trigger.task_low", "Backlog Low?", {
      threshold: 3,
      status: "todo",
    }, { x: 400, y: 50 }),

    node("check-dedup", "condition.expression", "Dedup Window", {
      expression: "(Date.now() - ($data?._lastPlannerRun || 0)) > (($data?.dedupHours || 24) * 3600000)",
    }, { x: 400, y: 180 }),

    node("log-start", "notify.log", "Log Planner Start", {
      message: "Task planner triggered: {{todoCount}} tasks remaining (threshold: {{minTodoCount}})",
      level: "info",
    }, { x: 400, y: 310 }),

    node("run-planner", "agent.run_planner", "Generate Tasks", {
      taskCount: 5,
      context: "Focus on high-value implementation work. Avoid duplicating existing tasks.",
      dedup: true,
    }, { x: 400, y: 440 }),

    node("check-result", "condition.expression", "Planner Succeeded?", {
      expression: "$output?.run_planner?.success === true || $ctx.getNodeOutput('run-planner')?.success === true",
    }, { x: 400, y: 570 }),

    node("set-timestamp", "action.set_variable", "Update Last Run", {
      key: "_lastPlannerRun",
      value: "Date.now()",
      isExpression: true,
    }, { x: 200, y: 700 }),

    node("notify-done", "notify.telegram", "Notify Tasks Created", {
      message: "🗂️ Task planner generated new backlog tasks. Todo count was {{todoCount}}.",
      silent: true,
    }, { x: 200, y: 830 }),

    node("notify-skip", "notify.log", "Log Dedup Skip", {
      message: "Task planner skipped: within dedup window",
      level: "info",
    }, { x: 650, y: 180 }),

    node("notify-fail", "notify.log", "Log Planner Failure", {
      message: "Task planner failed to generate tasks",
      level: "warn",
    }, { x: 600, y: 700 }),
  ],
  edges: [
    edge("trigger", "check-dedup"),
    edge("check-dedup", "log-start", { condition: "$output?.result === true" }),
    edge("check-dedup", "notify-skip", { condition: "$output?.result !== true" }),
    edge("log-start", "run-planner"),
    edge("run-planner", "check-result"),
    edge("check-result", "set-timestamp", { condition: "$output?.result === true" }),
    edge("check-result", "notify-fail", { condition: "$output?.result !== true" }),
    edge("set-timestamp", "notify-done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["planner", "backlog", "automation"],
    replaces: {
      module: "monitor.mjs",
      functions: ["startTaskPlannerStatusLoop"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the hardcoded task planner status loop. " +
        "Task counting, gap analysis, and replenishment are visual workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE 3: Task Replenish (periodic/schedule-based)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const TASK_REPLENISH_TEMPLATE = {
  id: "template-task-replenish",
  name: "Task Replenish (Scheduled)",
  description:
    "Periodically checks backlog and replenishes tasks on a schedule. " +
    "This replaces the previous INTERNAL_EXECUTOR_REPLENISH_ENABLED env var " +
    "with a configurable visual workflow.",
  category: "planning",
  enabled: false, // Opt-in — user enables when ready
  trigger: "trigger.schedule",
  variables: {
    intervalMs: 3600000, // 1 hour
    minTodoCount: 5,
    taskCount: 8,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Hourly Check", {
      intervalMs: 3600000,
    }, { x: 400, y: 50 }),

    node("check-backlog", "trigger.task_low", "Check Backlog Level", {
      threshold: 5,
    }, { x: 400, y: 180 }),

    node("needs-tasks", "condition.expression", "Needs Replenishment?", {
      expression: "$ctx.getNodeOutput('check-backlog')?.triggered === true",
    }, { x: 400, y: 310 }),

    node("run-planner", "agent.run_planner", "Generate Tasks", {
      taskCount: 8,
      context: "Scheduled replenishment run. Prioritize implementation tasks that build on recent PRs.",
    }, { x: 400, y: 440 }),

    node("notify", "notify.telegram", "Notify", {
      message: "🔄 Scheduled task replenishment complete.",
      silent: true,
    }, { x: 400, y: 570 }),

    node("skip-log", "notify.log", "No Replenish Needed", {
      message: "Scheduled replenishment check: backlog sufficient, skipping",
    }, { x: 700, y: 310 }),
  ],
  edges: [
    edge("trigger", "check-backlog"),
    edge("check-backlog", "needs-tasks"),
    edge("needs-tasks", "run-planner", { condition: "$output?.result === true" }),
    edge("needs-tasks", "skip-log", { condition: "$output?.result !== true" }),
    edge("run-planner", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["replenish", "schedule", "backlog"],
    replaces: {
      module: "monitor.mjs",
      functions: ["startTaskPlannerStatusLoop (scheduled variant)"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the cron-based task replenishment loop in monitor. " +
        "Backlog scanning and planner execution become visual workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE 4: Review Agent (automated PR review)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const REVIEW_AGENT_TEMPLATE = {
  id: "template-review-agent",
  name: "Review Agent",
  description:
    "Automatically runs code review when a PR is opened or updated. " +
    "Checks build, tests, and code quality, then posts review comments.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.pr_event",
  variables: {},
  nodes: [
    node("trigger", "trigger.pr_event", "PR Opened/Updated", {
      event: "opened",
    }, { x: 400, y: 50 }),

    node("run-build", "validation.build", "Run Build", {
      command: "npm run build",
    }, { x: 200, y: 200 }),

    node("run-tests", "validation.tests", "Run Tests", {
      command: "npm test",
    }, { x: 600, y: 200 }),

    node("run-review", "action.run_agent", "Agent Review", {
      prompt: `# Code Review

Review the changes in the current branch. Check for:
1. Code quality and best practices
2. Potential bugs or edge cases
3. Test coverage for new features
4. Documentation updates if needed

Provide a structured review with specific file:line references.`,
      timeoutMs: 900000,
    }, { x: 400, y: 350 }),

    node("aggregate", "transform.aggregate", "Collect Results", {
      sources: ["run-build", "run-tests", "run-review"],
    }, { x: 400, y: 500 }),

    node("notify", "notify.telegram", "Post Review", {
      message: "📝 PR review complete for {{branch}}",
    }, { x: 400, y: 640 }),
  ],
  edges: [
    edge("trigger", "run-build"),
    edge("trigger", "run-tests"),
    edge("run-build", "run-review"),
    edge("run-tests", "run-review"),
    edge("run-review", "aggregate"),
    edge("aggregate", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["review", "pr", "automation"],
    replaces: {
      module: "review-agent.mjs",
      functions: ["ReviewAgent.runReview", "createReviewAgent"],
      calledFrom: ["monitor.mjs:checkEpicBranches"],
      description: "Replaces the ReviewAgent class with a visual workflow. " +
        "Build, test, and AI review steps run in parallel with results aggregated.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE 5: Build and Deploy Pipeline
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const BUILD_DEPLOY_TEMPLATE = {
  id: "template-build-deploy",
  name: "Build & Deploy",
  description:
    "Complete CI/CD-style pipeline: build → test → lint → deploy. " +
    "Configurable deployment commands for any hosting target.",
  category: "ci-cd",
  enabled: false,
  trigger: "trigger.event",
  variables: {
    deployCommand: "npm run deploy",
    deployBranch: "main",
  },
  nodes: [
    node("trigger", "trigger.event", "On PR Merged", {
      eventType: "pr.merged",
      filter: "$event.branch === 'main'",
    }, { x: 400, y: 50 }),

    node("build", "validation.build", "Build", {
      command: "npm run build",
      zeroWarnings: true,
    }, { x: 400, y: 180 }),

    node("test", "validation.tests", "Tests", {
      command: "npm test",
    }, { x: 400, y: 310 }),

    node("lint", "validation.lint", "Lint", {
      command: "npm run lint",
    }, { x: 400, y: 440 }),

    node("deploy", "action.run_command", "Deploy", {
      command: "{{deployCommand}}",
    }, { x: 400, y: 570 }),

    node("notify", "notify.telegram", "Notify Deploy", {
      message: "🚀 Deployment to production completed for {{branch}}",
    }, { x: 400, y: 700 }),
  ],
  edges: [
    edge("trigger", "build"),
    edge("build", "test"),
    edge("test", "lint"),
    edge("lint", "deploy"),
    edge("deploy", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["ci", "cd", "deploy", "build"],
    replaces: {
      module: "monitor.mjs",
      functions: ["preflight checks"],
      calledFrom: ["preflight.mjs"],
      description: "Replaces ad-hoc build/test/lint validation steps " +
        "with a coordinated CI/CD pipeline workflow.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE 6: Error Recovery
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const ERROR_RECOVERY_TEMPLATE = {
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
//  TEMPLATE 7: Custom Agent Profile (starter template)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const CUSTOM_AGENT_TEMPLATE = {
  id: "template-custom-agent",
  name: "Custom Agent Profile",
  description:
    "Starter template for creating a custom agent profile with " +
    "configurable validation, notification, and completion gates. " +
    "Duplicate and customize to match your specific workflow.",
  category: "agents",
  enabled: false,
  trigger: "trigger.manual",
  variables: {
    agentName: "my-custom-agent",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start", {}, { x: 400, y: 50 }),

    node("set-context", "action.set_variable", "Set Context", {
      key: "agentProfile",
      value: "{{agentName}}",
    }, { x: 400, y: 180 }),

    node("run-agent", "action.run_agent", "Run Agent", {
      prompt: "# Custom Agent Task\n\nTask: {{taskTitle}}\n{{taskDescription}}",
      sdk: "auto",
    }, { x: 400, y: 310 }),

    node("verify", "validation.tests", "Run Verification", {
      command: "npm test",
    }, { x: 400, y: 440 }),

    node("check-result", "condition.expression", "Passed?", {
      expression: "$ctx.getNodeOutput('verify')?.passed === true",
    }, { x: 400, y: 570 }),

    node("complete", "action.update_task_status", "Mark Complete", {
      taskId: "{{taskId}}",
      status: "done",
    }, { x: 200, y: 700 }),

    node("fail-notify", "notify.log", "Log Failure", {
      message: "Custom agent verification failed for {{taskId}}",
      level: "warn",
    }, { x: 600, y: 700 }),
  ],
  edges: [
    edge("trigger", "set-context"),
    edge("set-context", "run-agent"),
    edge("run-agent", "verify"),
    edge("verify", "check-result"),
    edge("check-result", "complete", { condition: "$output?.result === true" }),
    edge("check-result", "fail-notify", { condition: "$output?.result !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["custom", "agent", "starter"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE 8: PR Merge Strategy
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const PR_MERGE_STRATEGY_TEMPLATE = {
  id: "template-pr-merge-strategy",
  name: "PR Merge Strategy",
  description:
    "Automated PR merge decision workflow. Analyzes diffs, CI status, " +
    "and agent output to decide: merge, prompt agent, re-attempt, " +
    "close, request manual review, or wait. Based on Bosun's merge-strategy engine.",
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
    // Row 1: Trigger
    node("trigger", "trigger.pr_event", "PR Ready for Review", {
      event: "review_requested",
    }, { x: 400, y: 50 }),

    // Row 2: Gather context (parallel)
    node("check-ci", "validation.build", "Check CI Status", {
      command: "gh pr checks {{prNumber}} --json name,state,conclusion",
    }, { x: 150, y: 200 }),

    node("get-diff", "action.run_command", "Get Diff Stats", {
      command: "git diff --stat {{baseBranch}}...HEAD",
    }, { x: 650, y: 200 }),

    // Row 3: CI gate
    node("ci-passed", "condition.expression", "CI Passed?", {
      expression: "$ctx.getNodeOutput('check-ci')?.passed === true",
    }, { x: 150, y: 350, outputs: ["yes", "no"] }),

    node("wait-for-ci", "action.delay", "Wait for CI", {
      delayMs: "{{ciTimeoutMs}}",
      reason: "CI is still running",
    }, { x: 150, y: 500 }),

    // Row 3b: Analyze merge (main path)
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

    // Row 4: Decision router
    node("decision-router", "condition.switch", "Route Decision", {
      field: "action",
      cases: {
        merge_after_ci_pass: "merge",
        prompt: "prompt-agent",
        close_pr: "close",
        re_attempt: "retry",
        manual_review: "escalate",
        wait: "wait-for-ci",
      },
    }, { x: 400, y: 520, outputs: ["merge", "prompt-agent", "close", "retry", "escalate", "wait-for-ci", "default"] }),

    // Row 5: Action branches
    node("do-merge", "action.run_command", "Auto-Merge PR", {
      command: "gh pr merge {{prNumber}} --auto --squash",
    }, { x: 100, y: 680 }),

    node("do-prompt", "action.run_agent", "Prompt Agent", {
      prompt: "Continue working on the PR. Instructions: {{decision.message}}",
      timeoutMs: 3600000,
    }, { x: 300, y: 680 }),

    node("do-close", "action.run_command", "Close PR", {
      command: "gh pr close {{prNumber}} --comment \"{{decision.reason}}\"",
    }, { x: 500, y: 680 }),

    node("do-retry", "action.run_agent", "Re-attempt Task", {
      prompt: "Start the task over from scratch. Previous attempt failed: {{decision.reason}}",
      timeoutMs: 3600000,
    }, { x: 700, y: 680 }),

    node("do-escalate", "notify.telegram", "Escalate to Human", {
      message: "👀 PR #{{prNumber}} needs manual review: {{decision.reason}}",
    }, { x: 900, y: 680 }),

    // Row 6: Completion
    node("notify-complete", "notify.log", "Log Result", {
      message: "PR #{{prNumber}} merge strategy: {{decision.action}} — {{decision.reason}}",
      level: "info",
    }, { x: 400, y: 850 }),
  ],
  edges: [
    // Trigger → parallel context gathering
    edge("trigger", "check-ci"),
    edge("trigger", "get-diff"),
    // Context → analysis
    edge("check-ci", "ci-passed"),
    edge("ci-passed", "wait-for-ci", { condition: "$output?.result !== true", port: "no" }),
    edge("ci-passed", "analyze", { condition: "$output?.result === true", port: "yes" }),
    edge("get-diff", "analyze"),
    edge("wait-for-ci", "analyze"),
    // Analysis → decision
    edge("analyze", "decision-router"),
    // Decision → branches
    edge("decision-router", "do-merge", { port: "merge" }),
    edge("decision-router", "do-prompt", { port: "prompt-agent" }),
    edge("decision-router", "do-close", { port: "close" }),
    edge("decision-router", "do-retry", { port: "retry" }),
    edge("decision-router", "do-escalate", { port: "escalate" }),
    edge("decision-router", "wait-for-ci", { port: "wait-for-ci" }),
    // All branches → completion
    edge("do-merge", "notify-complete"),
    edge("do-prompt", "notify-complete"),
    edge("do-close", "notify-complete"),
    edge("do-retry", "notify-complete"),
    edge("do-escalate", "notify-complete"),
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
//  TEMPLATE 9: PR Triage & Labels
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const PR_TRIAGE_TEMPLATE = {
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
      expression: "($ctx.getNodeOutput('get-stats')?.additions || 0) + ($ctx.getNodeOutput('get-stats')?.deletions || 0)",
      cases: { small: "<{{smallThreshold}}", large: ">{{largeThreshold}}" },
      default: "medium",
    }, { x: 400, y: 330, outputs: ["small", "medium", "large"] }),

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
      expression: "$ctx.getNodeOutput('detect-breaking')?.breaking === true",
    }, { x: 400, y: 780, outputs: ["yes", "no"] }),

    node("label-breaking", "action.run_command", "Label: Breaking", {
      command: "gh pr edit {{prNumber}} --add-label \"breaking-change\"",
    }, { x: 200, y: 920 }),

    node("done", "notify.log", "Triage Complete", {
      message: "PR #{{prNumber}} triaged — size: {{size}}, breaking: {{breaking}}",
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
//  TEMPLATE 10: Anomaly Watchdog (death-loop / stall detection)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const ANOMALY_WATCHDOG_TEMPLATE = {
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
//  TEMPLATE 11: Workspace Hygiene (maintenance + reaper)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const WORKSPACE_HYGIENE_TEMPLATE = {
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
//  TEMPLATE 12: PR Conflict Resolver
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const PR_CONFLICT_RESOLVER_TEMPLATE = {
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
  },
  nodes: [
    node("trigger", "trigger.schedule", "Check Every 30min", {
      intervalMs: 1800000,
      cron: "*/30 * * * *",
    }, { x: 400, y: 50 }),

    node("list-prs", "action.run_command", "List Open PRs", {
      command: "gh pr list --json number,title,headRefName,mergeable,statusCheckRollup --limit 20",
    }, { x: 400, y: 180 }),

    node("has-conflicts", "condition.expression", "Any Conflicts?", {
      expression: "($ctx.getNodeOutput('list-prs')?.output || '').includes('CONFLICTING') || ($ctx.getNodeOutput('list-prs')?.output || '').includes('BEHIND')",
    }, { x: 400, y: 330 }),

    node("resolve-conflicts", "action.run_agent", "Resolve Conflicts", {
      prompt: `You are a merge conflict resolution agent. For each PR with conflicts:
1. Check out the branch
2. Rebase onto main (or the base branch)
3. Resolve any conflicts — prefer the feature branch changes but ensure tests pass
4. Force-push the rebased branch
5. Verify CI passes

Only fix conflicts, do NOT change any logic. Keep changes minimal.`,
      sdk: "auto",
      timeoutMs: 1800000,
    }, { x: 200, y: 500 }),

    node("verify-ci", "action.run_command", "Verify CI Green", {
      command: "gh pr checks --json name,state,conclusion | head -20",
    }, { x: 200, y: 660 }),

    node("auto-merge", "condition.expression", "CI Passed?", {
      expression: "$ctx.getNodeOutput('verify-ci')?.success === true",
    }, { x: 200, y: 810 }),

    node("do-merge", "action.run_command", "Auto-Merge", {
      command: "gh pr merge --auto --squash",
    }, { x: 100, y: 960 }),

    node("notify-fixed", "notify.telegram", "Notify Fixed", {
      message: "🔧 PR conflicts auto-resolved and merged",
      silent: true,
    }, { x: 100, y: 1100 }),

    node("notify-failed", "notify.log", "Log CI Failed", {
      message: "PR conflict resolved but CI still failing — needs manual review",
      level: "warn",
    }, { x: 400, y: 960 }),

    node("skip", "notify.log", "No Conflicts", {
      message: "All PRs are clean — no conflicts found",
      level: "info",
    }, { x: 600, y: 330 }),
  ],
  edges: [
    edge("trigger", "list-prs"),
    edge("list-prs", "has-conflicts"),
    edge("has-conflicts", "resolve-conflicts", { condition: "$output?.result === true" }),
    edge("has-conflicts", "skip", { condition: "$output?.result !== true" }),
    edge("resolve-conflicts", "verify-ci"),
    edge("verify-ci", "auto-merge"),
    edge("auto-merge", "do-merge", { condition: "$output?.result === true" }),
    edge("auto-merge", "notify-failed", { condition: "$output?.result !== true" }),
    edge("do-merge", "notify-fixed"),
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
//  TEMPLATE 13: Health Check & Config Doctor
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const HEALTH_CHECK_TEMPLATE = {
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
      command: "git status --porcelain && git worktree list --porcelain | grep -c worktree",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("check-agents", "action.run_command", "Check Agent Status", {
      command: "bosun --daemon-status 2>/dev/null || echo 'daemon not running'",
      continueOnError: true,
    }, { x: 650, y: 200 }),

    node("has-issues", "condition.expression", "Any Issues?", {
      expression: "($ctx.getNodeOutput('check-config')?.output || '').includes('ERROR') || ($ctx.getNodeOutput('check-config')?.output || '').includes('CRITICAL')",
    }, { x: 400, y: 380 }),

    node("alert", "notify.telegram", "Alert Issues Found", {
      message: "🏥 Health check found issues — run `bosun doctor` for details",
    }, { x: 200, y: 540 }),

    node("all-ok", "notify.log", "All Healthy", {
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
//  TEMPLATE 14: Stale PR Reaper
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const STALE_PR_REAPER_TEMPLATE = {
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
//  TEMPLATE 15: Agent Session Monitor
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const AGENT_SESSION_MONITOR_TEMPLATE = {
  id: "template-agent-session-monitor",
  name: "Agent Session Monitor",
  description:
    "Monitors active agent sessions for timeouts, excessive token usage, " +
    "or inactivity. Auto-continues stalled agents or escalates hung ones.",
  category: "agents",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    checkIntervalMs: 300000,
    maxIdleMs: 600000,
    maxTokenPercent: 85,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Check Every 5min", {
      intervalMs: 300000,
      cron: "*/5 * * * *",
    }, { x: 400, y: 50 }),

    node("list-sessions", "action.run_command", "List Active Sessions", {
      command: "bosun agent list --json --active",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("has-active", "condition.expression", "Any Active?", {
      expression: "($ctx.getNodeOutput('list-sessions')?.output || '[]') !== '[]' && ($ctx.getNodeOutput('list-sessions')?.output || '').length > 5",
    }, { x: 400, y: 340 }),

    node("check-health", "action.run_command", "Check Session Health", {
      command: "bosun agent health --json",
      continueOnError: true,
    }, { x: 200, y: 490 }),

    node("has-issues", "condition.expression", "Any Unhealthy?", {
      expression: "($ctx.getNodeOutput('check-health')?.output || '').includes('stalled') || ($ctx.getNodeOutput('check-health')?.output || '').includes('timeout')",
    }, { x: 200, y: 640 }),

    node("auto-continue", "action.continue_session", "Auto-Continue Stalled", {
      prompt: "You appear to have stalled. Please continue working on the current task.",
      strategy: "continue",
      timeoutMs: 300000,
    }, { x: 100, y: 800 }),

    node("alert-hung", "notify.telegram", "Alert Hung Sessions", {
      message: "🔴 Agent session appears hung — auto-continue attempted. Check status.",
    }, { x: 100, y: 950 }),

    node("all-healthy", "notify.log", "Sessions Healthy", {
      message: "All active agent sessions are healthy",
      level: "info",
    }, { x: 450, y: 640 }),

    node("no-sessions", "notify.log", "No Active Sessions", {
      message: "No active agent sessions to monitor",
      level: "info",
    }, { x: 600, y: 490 }),
  ],
  edges: [
    edge("trigger", "list-sessions"),
    edge("list-sessions", "has-active"),
    edge("has-active", "check-health", { condition: "$output?.result === true" }),
    edge("has-active", "no-sessions", { condition: "$output?.result !== true" }),
    edge("check-health", "has-issues"),
    edge("has-issues", "auto-continue", { condition: "$output?.result === true" }),
    edge("has-issues", "all-healthy", { condition: "$output?.result !== true" }),
    edge("auto-continue", "alert-hung"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["agent", "monitor", "session", "health"],
    replaces: {
      module: "session-tracker.mjs",
      functions: ["SessionTracker.checkHealth", "pollAgentAlerts"],
      calledFrom: ["monitor.mjs:startAgentAlertTailer"],
      description: "Replaces hardcoded agent session monitoring with a visual " +
        "workflow. Health checks, stall detection, and auto-continuation " +
        "are configurable workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE 16: Nightly Report
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

const NIGHTLY_REPORT_TEMPLATE = {
  id: "template-nightly-report",
  name: "Nightly Report",
  description:
    "Generates a daily summary of agent activity: tasks completed, " +
    "PRs merged, errors encountered, and token usage. Sends to Telegram.",
  category: "planning",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    reportHour: 23,
    reportTimezone: "UTC",
  },
  nodes: [
    node("trigger", "trigger.schedule", "Nightly at 11pm", {
      intervalMs: 86400000,
      cron: "0 23 * * *",
    }, { x: 400, y: 50 }),

    node("get-task-stats", "action.run_command", "Get Task Stats", {
      command: "bosun task stats --json",
      continueOnError: true,
    }, { x: 150, y: 200 }),

    node("get-pr-stats", "action.run_command", "Get PR Stats", {
      command: "gh pr list --state all --json number,state,mergedAt --limit 50",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("get-agent-stats", "action.run_command", "Get Agent Stats", {
      command: "bosun agent stats --json 2>/dev/null || echo '{}'",
      continueOnError: true,
    }, { x: 650, y: 200 }),

    node("generate-report", "action.run_agent", "Generate Report", {
      prompt: `Generate a concise daily activity report from the following data.

## Task Stats
{{taskStats}}

## PR Activity
{{prStats}}

## Agent Activity
{{agentStats}}

Format as a Telegram-friendly message with emoji headers. Include:
- Tasks completed today vs yesterday
- PRs merged / opened / closed
- Agent success rate
- Notable errors or anomalies
- Recommendations for tomorrow`,
      timeoutMs: 300000,
    }, { x: 400, y: 380 }),

    node("send-report", "notify.telegram", "Send Report", {
      message: "📊 **Daily Bosun Report**\n\n{{reportOutput}}",
    }, { x: 400, y: 540 }),
  ],
  edges: [
    edge("trigger", "get-task-stats"),
    edge("trigger", "get-pr-stats"),
    edge("trigger", "get-agent-stats"),
    edge("get-task-stats", "generate-report"),
    edge("get-pr-stats", "generate-report"),
    edge("get-agent-stats", "generate-report"),
    edge("generate-report", "send-report"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["report", "daily", "telegram", "analytics"],
    replaces: {
      module: "telegram-sentinel.mjs",
      functions: ["dailyDigest", "sendStatusReport"],
      calledFrom: ["monitor.mjs:startSentinelBridge"],
      description: "Replaces ad-hoc Telegram status reporting with a scheduled " +
        "nightly report workflow. Stats gathering runs in parallel, then " +
        "an agent generates a formatted summary.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

/** Category metadata for UI grouping. */
export const TEMPLATE_CATEGORIES = Object.freeze({
  github:      { label: "GitHub",       icon: "🐙", order: 1 },
  agents:      { label: "Agents",       icon: "🤖", order: 2 },
  planning:    { label: "Planning",     icon: "📋", order: 3 },
  "ci-cd":     { label: "CI / CD",      icon: "🔄", order: 4 },
  reliability: { label: "Reliability",  icon: "🛡️", order: 5 },
  custom:      { label: "Custom",       icon: "⚙️", order: 6 },
});

export const WORKFLOW_TEMPLATES = Object.freeze([
  // ── Original 9 ──
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  REVIEW_AGENT_TEMPLATE,
  FRONTEND_AGENT_TEMPLATE,
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  BUILD_DEPLOY_TEMPLATE,
  ERROR_RECOVERY_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  // ── New templates ──
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
]);

/**
 * Get a template by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getTemplate(id) {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id) || null;
}

/**
 * List all available templates with metadata.
 * @returns {Array<{id, name, description, category, tags, replaces?}>}
 */
export function listTemplates() {
  return WORKFLOW_TEMPLATES.map((t) => {
    const cat = TEMPLATE_CATEGORIES[t.category] || TEMPLATE_CATEGORIES.custom;
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      categoryLabel: cat.label,
      categoryIcon: cat.icon,
      categoryOrder: cat.order,
      tags: t.metadata?.tags || [],
      nodeCount: t.nodes?.length || 0,
      edgeCount: t.edges?.length || 0,
      replaces: t.metadata?.replaces || null,
      recommended: t.recommended === true,
      enabled: t.enabled !== false,
    };
  });
}

/**
 * Install a template into a workflow engine, creating a new workflow instance.
 * The user can then customize names, variables, and node configs.
 * @param {string} templateId
 * @param {import('./workflow-engine.mjs').WorkflowEngine} engine
 * @param {object} [overrides] - Variable overrides
 * @returns {object} The saved workflow definition
 */
export function installTemplate(templateId, engine, overrides = {}) {
  const template = getTemplate(templateId);
  if (!template) throw new Error(`Template "${templateId}" not found`);

  // Deep clone
  const def = JSON.parse(JSON.stringify(template));
  def.id = randomUUID(); // New unique ID
  def.metadata = {
    ...def.metadata,
    installedFrom: templateId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Apply variable overrides
  if (overrides) {
    def.variables = { ...def.variables, ...overrides };
  }

  return engine.save(def);
}
