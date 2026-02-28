/**
 * agents.mjs — Agent-related workflow templates.
 *
 * Templates:
 *   - Frontend Agent
 *   - Review Agent (recommended)
 *   - Custom Agent Profile
 *   - Agent Session Monitor (recommended)
 *   - Backend Agent (recommended)
 *   - Voice + Video Rollout (Parallel Lanes)
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Frontend Agent with Screenshot Validation
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const FRONTEND_AGENT_TEMPLATE = {
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
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      agentType: "frontend",
      taskPattern: "feat\\(.*\\)|fix\\(.*\\)|style\\(.*\\)|ui|frontend|css|component",
    }, { x: 400, y: 50 }),

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
6. Capture at least {{screenshotCount}} key screenshots across target states/viewports.

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

    node("verify-build", "validation.build", "Verify Build", {
      command: "npm run build",
      cwd: "{{worktreePath}}",
      zeroWarnings: true,
    }, { x: 150, y: 420 }),

    node("verify-lint", "validation.lint", "Verify Lint", {
      command: "npm run lint",
      cwd: "{{worktreePath}}",
    }, { x: 650, y: 420 }),

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

    node("collect-evidence", "agent.evidence_collect", "Collect Evidence", {
      evidenceDir: "{{evidenceDir}}",
    }, { x: 400, y: 700 }),

    node("model-review", "validation.model_review", "Model Verification", {
      evidenceDir: "{{evidenceDir}}",
      originalTask: "{{taskTitle}}: {{taskDescription}}",
      criteria: "Visual implementation matches requirements. No broken layouts. Responsive design works across viewports. No console errors visible.",
      strictMode: true,
    }, { x: 400, y: 840 }),

    node("check-review", "condition.expression", "Review Passed?", {
      expression: "$output?.model_review?.passed === true || $data?.modelReviewPassed === true",
    }, { x: 400, y: 960 }),

    node("mark-success", "action.update_task_status", "Mark Task Done", {
      taskId: "{{taskId}}",
      status: "done",
    }, { x: 200, y: 1080 }),

    node("notify-success", "notify.telegram", "Notify Success", {
      message: ":check: Frontend task **{{taskTitle}}** passed visual verification and is complete.",
    }, { x: 200, y: 1200 }),

    node("notify-failure", "notify.telegram", "Notify Review Failed", {
      message: "❌ Frontend task **{{taskTitle}}** failed visual verification.\n" +
        "Evidence dir: `{{evidenceDir}}`\n" +
        "Reason: `{{model-review.reason}}`\n" +
        "Evidence count: `{{model-review.evidenceCount}}`\n" +
        "Review output: {{model-review.reviewOutput}}",
    }, { x: 600, y: 1080 }),

    node("log-failure", "notify.log", "Log Failure", {
      message: "Frontend verification failed for {{taskId}}: evidenceDir={{evidenceDir}} reason={{model-review.reason}} evidenceCount={{model-review.evidenceCount}}",
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
//  Review Agent (automated PR review)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const REVIEW_AGENT_TEMPLATE = {
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
      message: ":edit: PR review complete for {{branch}}",
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
//  Custom Agent Profile (starter template)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const CUSTOM_AGENT_TEMPLATE = {
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
//  Agent Session Monitor
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const AGENT_SESSION_MONITOR_TEMPLATE = {
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
      intervalMs: "{{checkIntervalMs}}",
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
      expression: "(() => { const out = String($ctx.getNodeOutput('check-health')?.output || ''); const maxIdleMs = Number($data?.maxIdleMs || 600000); const maxTokenPercent = Number($data?.maxTokenPercent || 85); const idleMatch = out.match(/idle(?:_ms)?\\s*[:=]\\s*(\\d+)/i); const tokenMatch = out.match(/token(?:_usage|_percent)?\\s*[:=]\\s*(\\d+(?:\\.\\d+)?)/i); const idleExceeded = idleMatch ? Number(idleMatch[1]) > maxIdleMs : false; const tokenExceeded = tokenMatch ? Number(tokenMatch[1]) >= maxTokenPercent : false; return out.includes('stalled') || out.includes('timeout') || idleExceeded || tokenExceeded; })()",
    }, { x: 200, y: 640 }),

    node("auto-continue", "action.continue_session", "Auto-Continue Stalled", {
      prompt: "You appear to have stalled. Please continue working on the current task.",
      strategy: "continue",
      timeoutMs: 300000,
    }, { x: 100, y: 800 }),

    node("alert-hung", "notify.telegram", "Alert Hung Sessions", {
      message: ":dot: Agent session appears hung — auto-continue attempted. Check status.",
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
//  Backend Agent
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const BACKEND_AGENT_TEMPLATE = {
  id: "template-backend-agent",
  name: "Backend Agent",
  description:
    "Spins up an agent focused on backend/API development with a " +
    "test-first methodology. Writes tests first, implements the feature, " +
    "validates with build + lint, then creates a PR.",
  category: "agents",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_assigned",
  variables: {
    testFramework: "node --test",
    buildCommand: "npm run build",
    agentSdk: "auto",
    timeoutMs: 3600000,
    autoFixTimeoutMs: 1200000,
  },
  nodes: [
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      filter: "task.tags?.some(t => t === 'backend' || t === 'api')",
    }, { x: 400, y: 50 }),

    node("plan-work", "agent.run_planner", "Plan Implementation", {
      prompt: "Analyze the task requirements and create a step-by-step implementation plan. Identify which files need to be modified, what tests need to be written, and any API contracts to maintain.",
      outputVariable: "plan",
    }, { x: 400, y: 180 }),

    node("write-tests", "action.run_agent", "Write Tests First", {
      prompt: `# Test-First Development

Based on the plan:
{{plan}}

Write comprehensive tests FIRST before any implementation:
1. Unit tests for new functions/methods
2. Integration tests for API endpoints if applicable
3. Edge cases and error scenarios

Use the project's existing test framework: {{testFramework}}
Commit with message "test: add tests for [feature]"`,
      sdk: "{{agentSdk}}",
      timeoutMs: "{{timeoutMs}}",
    }, { x: 400, y: 330 }),

    node("implement", "action.run_agent", "Implement Feature", {
      prompt: `# Implement Backend Feature

The tests have been written. Now implement the feature to make them pass:
1. Follow existing code conventions
2. Add proper error handling
3. Ensure all new tests pass
4. Do NOT modify the tests — make the code fit the contract

Run \`{{testFramework}}\` after implementation.
Commit with message "feat: implement [feature]"`,
      sdk: "{{agentSdk}}",
      timeoutMs: "{{timeoutMs}}",
    }, { x: 400, y: 490 }),

    node("build", "validation.build", "Build Check", {
      command: "{{buildCommand}}",
      zeroWarnings: true,
    }, { x: 400, y: 650 }),

    node("test-final", "validation.tests", "Final Test Run", {
      command: "{{testFramework}}",
    }, { x: 400, y: 780 }),

    node("lint", "validation.lint", "Lint Check", {
      command: "npm run lint 2>/dev/null || echo 'no lint script'",
    }, { x: 400, y: 910 }),

    node("all-passed", "condition.expression", "All Checks Passed?", {
      expression: "$ctx.getNodeOutput('build')?.passed === true && $ctx.getNodeOutput('test-final')?.passed === true && $ctx.getNodeOutput('lint')?.passed === true",
    }, { x: 400, y: 1040, outputs: ["yes", "no"] }),

    node("create-pr", "action.create_pr", "Handoff PR Lifecycle", {
      title: "feat: {{taskTitle}}",
      body: "Implements backend task with test-first methodology.\n\n**Plan:**\n{{plan}}\n\nAll tests passing. Bosun lifecycle handoff ready.",
      branch: "feat/{{taskSlug}}",
      baseBranch: "main",
      failOnError: true,
      maxRetries: 3,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 250, y: 1170 }),

    node("pr-created", "condition.expression", "Handoff Recorded?", {
      expression: "$ctx.getNodeOutput('create-pr')?.success === true",
    }, { x: 250, y: 1240, outputs: ["yes", "no"] }),

    node("notify-done", "notify.log", "Task Complete", {
      message: "Backend agent completed task — PR lifecycle handoff recorded",
      level: "info",
    }, { x: 180, y: 1320 }),

    node("notify-pr-failed", "notify.telegram", "Escalate Lifecycle Handoff Failure", {
      message: ":alert: Backend agent passed validation for {{taskTitle}} but failed to record Bosun PR lifecycle handoff after retries. Manual follow-up required.",
    }, { x: 420, y: 1320 }),

    node("set-validation-summary", "action.set_variable", "Summarize Validation Output", {
      key: "validationSummary",
      value:
        "(() => { const implement = $ctx.getNodeOutput('implement') || {}; const build = $ctx.getNodeOutput('build') || {}; const test = $ctx.getNodeOutput('test-final') || {}; const lint = $ctx.getNodeOutput('lint') || {}; return ['- implement.success: ' + (implement.success === true), '- build.passed: ' + (build.passed === true), '- test-final.passed: ' + (test.passed === true), '- lint.passed: ' + (lint.passed === true), '', 'Build output:', String(build.output || '').slice(0, 6000), '', 'Test output:', String(test.output || '').slice(0, 6000), '', 'Lint output:', String(lint.output || '').slice(0, 6000)].join('\\n'); })()",
      isExpression: true,
    }, { x: 620, y: 1090 }),

    node("auto-fix", "action.run_agent", "Auto-Fix Validation Failures", {
      prompt: `# Fix Backend Validation Failures

The first validation pass failed for task **{{taskTitle}}**.

Plan:
{{plan}}

Current validation outputs:
{{validationSummary}}

Fix the code so build/tests/lint pass.
Do NOT weaken, remove, or bypass tests.
Keep the original task scope.

Run build + tests + lint locally before finishing.
Commit with message "fix: address backend workflow validation failures"`,
      sdk: "{{agentSdk}}",
      timeoutMs: "{{autoFixTimeoutMs}}",
    }, { x: 620, y: 1170 }),

    node("build-retry", "validation.build", "Build Check (Retry)", {
      command: "{{buildCommand}}",
      zeroWarnings: true,
    }, { x: 620, y: 1300 }),

    node("test-retry", "validation.tests", "Final Test Run (Retry)", {
      command: "{{testFramework}}",
    }, { x: 620, y: 1430 }),

    node("lint-retry", "validation.lint", "Lint Check (Retry)", {
      command: "npm run lint 2>/dev/null || echo 'no lint script'",
    }, { x: 620, y: 1560 }),

    node("retry-passed", "condition.expression", "Retry Checks Passed?", {
      expression: "$ctx.getNodeOutput('build-retry')?.passed === true && $ctx.getNodeOutput('test-retry')?.passed === true && $ctx.getNodeOutput('lint-retry')?.passed === true",
    }, { x: 620, y: 1690, outputs: ["yes", "no"] }),

    node("create-pr-retry", "action.create_pr", "Handoff PR Lifecycle (After Retry)", {
      title: "feat: {{taskTitle}}",
      body: "Implements backend task after auto-fix retry.\n\n**Plan:**\n{{plan}}\n\nValidation passed after remediation. Bosun lifecycle handoff ready.",
      branch: "feat/{{taskSlug}}",
      baseBranch: "main",
      failOnError: true,
      maxRetries: 3,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 450, y: 1820 }),

    node("pr-created-retry", "condition.expression", "Handoff Recorded (Retry Path)?", {
      expression: "$ctx.getNodeOutput('create-pr-retry')?.success === true",
    }, { x: 450, y: 1890, outputs: ["yes", "no"] }),

    node("notify-done-retry", "notify.log", "Task Complete (After Retry)", {
      message: "Backend agent completed task after retry — PR lifecycle handoff recorded",
      level: "info",
    }, { x: 360, y: 1980 }),

    node("notify-fail", "notify.telegram", "Checks Failed", {
      message: ":alert: Backend agent: validation failed for task {{taskTitle}} even after remediation pass. Manual review needed.",
    }, { x: 820, y: 1820 }),

    node("notify-pr-failed-retry", "notify.telegram", "Escalate Lifecycle Failure (Retry Path)", {
      message: ":alert: Backend agent remediation passed for {{taskTitle}} but Bosun PR lifecycle handoff failed after retries. Manual follow-up required.",
    }, { x: 620, y: 1980 }),
  ],
  edges: [
    edge("trigger", "plan-work"),
    edge("plan-work", "write-tests"),
    edge("write-tests", "implement"),
    edge("implement", "build"),
    edge("build", "test-final"),
    edge("test-final", "lint"),
    edge("lint", "all-passed"),
    edge("all-passed", "create-pr", { condition: "$output?.result === true", port: "yes" }),
    edge("all-passed", "set-validation-summary", { condition: "$output?.result !== true", port: "no" }),
    edge("set-validation-summary", "auto-fix"),
    edge("create-pr", "pr-created"),
    edge("pr-created", "notify-done", { condition: "$output?.result === true", port: "yes" }),
    edge("pr-created", "notify-pr-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("auto-fix", "build-retry"),
    edge("build-retry", "test-retry"),
    edge("test-retry", "lint-retry"),
    edge("lint-retry", "retry-passed"),
    edge("retry-passed", "create-pr-retry", { condition: "$output?.result === true", port: "yes" }),
    edge("retry-passed", "notify-fail", { condition: "$output?.result !== true", port: "no" }),
    edge("create-pr-retry", "pr-created-retry"),
    edge("pr-created-retry", "notify-done-retry", { condition: "$output?.result === true", port: "yes" }),
    edge("pr-created-retry", "notify-pr-failed-retry", { condition: "$output?.result !== true", port: "no" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["agent", "backend", "api", "test-first", "tdd"],
    replaces: {
      module: "primary-agent.mjs",
      functions: ["runAgentWithTask"],
      calledFrom: ["task-executor.mjs:executeTask"],
      description:
        "Replaces generic agent task execution with a structured backend " +
        "workflow. Test-first methodology, build/lint gates, and Bosun-managed PR lifecycle handoff " +
        "are enforced as distinct workflow stages.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Voice + Video Rollout (Parallel Lanes)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const VOICE_VIDEO_PARALLEL_ROLLOUT_TEMPLATE = {
  id: "template-voice-video-parallel-rollout",
  name: "Voice + Video Rollout (Parallel Lanes)",
  description:
    "Launches three agent lanes in parallel (capture pipeline, provider adapters, " +
    "and QA/rollout hardening) to accelerate Voice + Video delivery while keeping " +
    "workstreams isolated by worktree.",
  category: "agents",
  enabled: false,
  trigger: "trigger.manual",
  variables: {
    lane1Worktree: "{{worktreePath}}",
    lane2Worktree: "{{worktreePath}}",
    lane3Worktree: "{{worktreePath}}",
    integrationBranch: "feat/voice-video-integration",
    definitionOfDone:
      "Voice + vision works end-to-end, provider fallback is explicit, and tests cover config + transport + failure paths.",
  },
  nodes: [
    node("trigger", "trigger.manual", "Launch Parallel Rollout", {}, { x: 500, y: 50 }),

    node("check-worktrees", "condition.expression", "Worktrees Distinct?", {
      expression:
        "(() => { " +
        "const a = String($data?.lane1Worktree || '').trim(); " +
        "const b = String($data?.lane2Worktree || '').trim(); " +
        "const c = String($data?.lane3Worktree || '').trim(); " +
        "if (!a || !b || !c) return false; " +
        "return new Set([a, b, c]).size === 3; " +
        "})()",
    }, { x: 500, y: 170 }),

    node("notify-worktree-error", "notify.telegram", "Invalid Worktree Setup", {
      message:
        "Parallel rollout aborted. Configure three distinct worktrees in " +
        "`lane1Worktree`, `lane2Worktree`, and `lane3Worktree` before launching.",
    }, { x: 860, y: 170 }),

    node("kickoff-log", "notify.log", "Kickoff Parallel Lanes", {
      message:
        "Starting parallel rollout on branch {{integrationBranch}} with 3 lanes.",
      level: "info",
    }, { x: 500, y: 290 }),

    node("lane-capture-core", "action.run_agent", "Lane 1: Capture Core", {
      prompt:
        "# Lane 1 - Capture Core\n\n" +
        "Work only in this lane's worktree. Focus on:\n" +
        "1. Voice video config/schema/env/settings keys\n" +
        "2. Browser capture loop (screen/camera), adaptive FPS, compression, change detection\n" +
        "3. Overlay controls + capture state indicators\n\n" +
        "Guardrails:\n" +
        "- Do not touch provider dispatch code owned by Lane 2\n" +
        "- Keep changes bounded to UI/config paths\n" +
        "- Add/extend tests for capture throttling and config behavior\n\n" +
        "Target branch: {{integrationBranch}}\n" +
        "Definition of done: {{definitionOfDone}}",
      sdk: "auto",
      cwd: "{{lane1Worktree}}",
      timeoutMs: 5400000,
      includeTaskContext: false,
      failOnError: true,
    }, { x: 120, y: 450 }),

    node("lane-provider-bridge", "action.run_agent", "Lane 2: Provider Bridge", {
      prompt:
        "# Lane 2 - Provider Bridge\n\n" +
        "Work only in this lane's worktree. Focus on:\n" +
        "1. Server-side vision frame ingress route and validation\n" +
        "2. Provider dispatch in voice relay (OpenAI image path, Gemini live path, Claude vision path)\n" +
        "3. Rate-limits, payload caps, and fallback semantics\n\n" +
        "Guardrails:\n" +
        "- Do not edit overlay/capture UI owned by Lane 1\n" +
        "- Keep provider logic behind explicit feature flags\n" +
        "- Add/extend tests for endpoint validation and provider routing\n\n" +
        "Target branch: {{integrationBranch}}\n" +
        "Definition of done: {{definitionOfDone}}",
      sdk: "auto",
      cwd: "{{lane2Worktree}}",
      timeoutMs: 5400000,
      includeTaskContext: false,
      failOnError: true,
    }, { x: 500, y: 450 }),

    node("lane-hardening", "action.run_agent", "Lane 3: QA + Rollout", {
      prompt:
        "# Lane 3 - QA + Rollout Hardening\n\n" +
        "Work only in this lane's worktree. Focus on:\n" +
        "1. Integration tests, resilience tests, and docs updates\n" +
        "2. Migration/rollout notes and operator controls\n" +
        "3. Conflict-free merge guidance across Lane 1 and Lane 2 outputs\n\n" +
        "Guardrails:\n" +
        "- Avoid touching core capture loop and provider dispatch internals unless a test proves breakage\n" +
        "- Keep this lane focused on verification, docs, and release safety\n" +
        "- Produce a concise verification summary\n\n" +
        "Target branch: {{integrationBranch}}\n" +
        "Definition of done: {{definitionOfDone}}",
      sdk: "auto",
      cwd: "{{lane3Worktree}}",
      timeoutMs: 3600000,
      includeTaskContext: false,
      failOnError: true,
    }, { x: 880, y: 450 }),

    node("aggregate", "transform.aggregate", "Aggregate Lane Results", {
      sources: ["lane-capture-core", "lane-provider-bridge", "lane-hardening"],
    }, { x: 500, y: 640 }),

    node("all-passed", "condition.expression", "All Lanes Passed?", {
      expression:
        "$ctx.getNodeOutput('lane-capture-core')?.success === true && " +
        "$ctx.getNodeOutput('lane-provider-bridge')?.success === true && " +
        "$ctx.getNodeOutput('lane-hardening')?.success === true",
    }, { x: 500, y: 770 }),

    node("notify-success", "notify.telegram", "Notify Success", {
      message:
        "Parallel Voice + Video rollout lanes completed successfully on {{integrationBranch}}. " +
        "Proceed to integration and final verification.",
    }, { x: 300, y: 910 }),

    node("notify-failure", "notify.telegram", "Notify Failure", {
      message:
        "Parallel Voice + Video rollout has lane failures on {{integrationBranch}}. " +
        "Inspect lane outputs before integration.",
    }, { x: 700, y: 910 }),
  ],
  edges: [
    edge("trigger", "check-worktrees"),
    edge("check-worktrees", "kickoff-log", { condition: "$output?.result === true" }),
    edge("check-worktrees", "notify-worktree-error", { condition: "$output?.result !== true" }),
    edge("kickoff-log", "lane-capture-core"),
    edge("kickoff-log", "lane-provider-bridge"),
    edge("kickoff-log", "lane-hardening"),
    edge("lane-capture-core", "aggregate"),
    edge("lane-provider-bridge", "aggregate"),
    edge("lane-hardening", "aggregate"),
    edge("aggregate", "all-passed"),
    edge("all-passed", "notify-success", { condition: "$output?.result === true" }),
    edge("all-passed", "notify-failure", { condition: "$output?.result !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-02-28T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["voice", "video", "parallel", "subagents", "rollout"],
  },
};
