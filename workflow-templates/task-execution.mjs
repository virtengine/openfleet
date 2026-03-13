/**
 * task-execution.mjs — Task-Type Execution Workflow Templates
 *
 * Specialised workflows that are matched to tasks based on title/description
 * patterns. Each template uses trigger.task_assigned with regex filters so
 * the right workflow picks up the right kind of task automatically.
 *
 * Agent-run nodes default to library-resolved skills — the Library Resolver
 * selects the best agents/skills for each phase based on the task + node prompt.
 * Users can override by manually selecting skills in the workflow editor.
 *
 * Templates:
 *   - Fullstack Task Workflow
 *   - Backend Task Workflow
 *   - Frontend Task Workflow
 *   - Debug Task Workflow
 *   - CI/CD Task Workflow
 *   - Design Task Workflow
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Fullstack Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const FULLSTACK_TASK_TEMPLATE = {
  id: "template-task-fullstack",
  name: "Fullstack Task Workflow",
  description:
    "Handles tasks that span frontend and backend — API endpoints, " +
    "database models, and UI components. Runs four agent phases: " +
    "architecture planning, backend implementation, frontend implementation, " +
    "and integration testing.",
  category: "task-execution",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_assigned",
  variables: {
    taskTimeoutMs: 21600000,
    maxRetries: 2,
    maxContinues: 3,
    testCommand: "auto",
    buildCommand: "auto",
    lintCommand: "auto",
  },
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["fullstack", "task-type"],
    resolveMode: "library",
  },
  nodes: [
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      taskPattern: "full.?stack|end.to.end|api.*ui|server.*client|frontend.*backend|database.*component",
    }, { x: 400, y: 50 }),

    node("plan-architecture", "action.run_agent", "Plan Architecture", {
      prompt: `## Phase: Architecture Planning

Analyse the task and produce a concrete plan covering:
1. Backend changes: API routes, models, services, migrations
2. Frontend changes: components, pages, state management
3. Shared types / contracts between layers
4. Test strategy for each layer
5. Integration points and data flow

Do NOT write code yet — produce only the plan.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 180 }),

    node("implement-backend", "action.run_agent", "Implement Backend", {
      prompt: `## Phase: Backend Implementation

Implement the server-side / API changes from the architecture plan:
- Models, schemas, database migrations
- API routes and controllers
- Service / business logic
- Unit tests for backend logic
- Run tests: {{testCommand}}

Commit backend changes separately.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 340 }),

    node("implement-frontend", "action.run_agent", "Implement Frontend", {
      prompt: `## Phase: Frontend Implementation

Implement the client-side / UI changes:
- Components, pages, layouts
- State management and API integration
- Styling and responsive design
- Component tests
- Run build: {{buildCommand}}

Commit frontend changes separately.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 500 }),

    node("integration-test", "action.run_agent", "Integration Test", {
      prompt: `## Phase: Integration Testing

Verify the full stack works end-to-end:
1. Run the full test suite: {{testCommand}}
2. Run the build: {{buildCommand}}
3. Run lint: {{lintCommand}}
4. Fix any integration issues between frontend and backend
5. Ensure all tests pass before completing

Push all changes and create/update the PR.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 660 }),

    node("done", "notify.log", "Complete", {
      message: "Fullstack task completed — all layers implemented and tested.",
    }, { x: 400, y: 820 }),
  ],
  edges: [
    edge("trigger", "plan-architecture"),
    edge("plan-architecture", "implement-backend"),
    edge("implement-backend", "implement-frontend"),
    edge("implement-frontend", "integration-test"),
    edge("integration-test", "done"),
  ],
};


// ═══════════════════════════════════════════════════════════════════════════
//  Backend Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const BACKEND_TASK_TEMPLATE = {
  id: "template-task-backend",
  name: "Backend Task Workflow",
  description:
    "Specialised for server-side tasks — APIs, databases, services, " +
    "middleware. Runs three phases: plan, implement with TDD, and " +
    "verify with full test suite.",
  category: "task-execution",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_assigned",
  variables: {
    taskTimeoutMs: 21600000,
    maxRetries: 2,
    maxContinues: 3,
    testCommand: "auto",
    buildCommand: "auto",
    lintCommand: "auto",
  },
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["backend", "api", "server", "task-type"],
    resolveMode: "library",
  },
  nodes: [
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      taskPattern: "api|server|backend|database|model|migration|endpoint|middleware|service|graphql|rest|grpc",
    }, { x: 400, y: 50 }),

    node("plan", "action.run_agent", "Plan Backend", {
      prompt: `## Phase: Backend Planning

Analyse the task and produce a plan:
1. Data model / schema changes
2. API endpoint design (routes, request/response shapes)
3. Service layer logic
4. Database queries or migrations
5. Test plan (unit + integration)

Do NOT write code yet.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 180 }),

    node("implement-tdd", "action.run_agent", "Implement (TDD)", {
      prompt: `## Phase: Test-Driven Implementation

1. Write tests FIRST for the planned changes
2. Verify tests fail (red)
3. Implement the backend logic to make tests pass (green)
4. Refactor for clarity and performance
5. Run full test suite: {{testCommand}}
6. Run build: {{buildCommand}}
7. Run lint: {{lintCommand}}

Commit with descriptive messages.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 380 }),

    node("verify", "action.run_agent", "Verify & PR", {
      prompt: `## Phase: Verification

1. Run the complete test suite: {{testCommand}}
2. Run build: {{buildCommand}}
3. Ensure no regressions
4. Push changes and create/update PR
5. Include test results summary in PR description`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 560 }),

    node("done", "notify.log", "Complete", {
      message: "Backend task completed — API/service implemented and tested.",
    }, { x: 400, y: 720 }),
  ],
  edges: [
    edge("trigger", "plan"),
    edge("plan", "implement-tdd"),
    edge("implement-tdd", "verify"),
    edge("verify", "done"),
  ],
};


// ═══════════════════════════════════════════════════════════════════════════
//  Frontend Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const FRONTEND_TASK_TEMPLATE = {
  id: "template-task-frontend",
  name: "Frontend Task Workflow",
  description:
    "Specialised for UI tasks — components, pages, styling, " +
    "accessibility. Runs three phases: design analysis, implement " +
    "with component tests, and visual verification.",
  category: "task-execution",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_assigned",
  variables: {
    taskTimeoutMs: 21600000,
    maxRetries: 2,
    maxContinues: 3,
    testCommand: "auto",
    buildCommand: "auto",
    lintCommand: "auto",
  },
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["frontend", "ui", "css", "component", "task-type"],
    resolveMode: "library",
  },
  nodes: [
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      taskPattern: "frontend|ui|component|page|layout|style|css|responsive|accessibility|a11y|design.system",
    }, { x: 400, y: 50 }),

    node("analyse-design", "action.run_agent", "Analyse Design", {
      prompt: `## Phase: Design Analysis

Analyse the UI task requirements:
1. Component hierarchy and structure
2. Layout and responsive breakpoints
3. State management needs
4. Accessibility requirements (ARIA, keyboard nav)
5. Styling approach (CSS modules, Tailwind, styled-components)
6. Component test plan

Do NOT write code yet.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 180 }),

    node("implement-ui", "action.run_agent", "Implement UI", {
      prompt: `## Phase: UI Implementation

1. Create / update components per the design plan
2. Implement layouts, styling, and responsive design
3. Add proper accessibility attributes
4. Write component tests
5. Run tests: {{testCommand}}
6. Run build: {{buildCommand}}
7. Run lint: {{lintCommand}}

Commit with descriptive messages.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 380 }),

    node("verify-visual", "action.run_agent", "Verify & PR", {
      prompt: `## Phase: Visual Verification

1. Run the full test suite: {{testCommand}}
2. Run build: {{buildCommand}}
3. Verify components render correctly
4. Check responsive breakpoints
5. Verify accessibility (screen reader, keyboard)
6. Push changes and create/update PR`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 560 }),

    node("done", "notify.log", "Complete", {
      message: "Frontend task completed — UI implemented and verified.",
    }, { x: 400, y: 720 }),
  ],
  edges: [
    edge("trigger", "analyse-design"),
    edge("analyse-design", "implement-ui"),
    edge("implement-ui", "verify-visual"),
    edge("verify-visual", "done"),
  ],
};


// ═══════════════════════════════════════════════════════════════════════════
//  Debug Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const DEBUG_TASK_TEMPLATE = {
  id: "template-task-debug",
  name: "Debug Task Workflow",
  description:
    "Bug investigation and fix workflow. Starts with reproduction " +
    "and root-cause analysis, then implements a targeted fix with " +
    "regression tests.",
  category: "task-execution",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_assigned",
  variables: {
    taskTimeoutMs: 21600000,
    maxRetries: 3,
    maxContinues: 4,
    testCommand: "auto",
    buildCommand: "auto",
    lintCommand: "auto",
  },
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["debug", "bug", "fix", "error", "task-type"],
    resolveMode: "library",
  },
  nodes: [
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      taskPattern: "bug|fix|error|crash|regression|broken|debug|issue|defect|hotfix|patch",
    }, { x: 400, y: 50 }),

    node("reproduce", "action.run_agent", "Reproduce & Analyse", {
      prompt: `## Phase: Bug Reproduction & Root Cause Analysis

1. Read the bug report carefully
2. Find the relevant code area
3. Reproduce the issue (write a failing test if possible)
4. Trace the root cause through the codebase
5. Document: what fails, where, why, and the minimal fix needed

Do NOT fix the bug yet — only diagnose.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 180 }),

    node("fix-and-test", "action.run_agent", "Fix & Regression Test", {
      prompt: `## Phase: Fix Implementation with Regression Tests

1. Write a regression test that demonstrates the bug (must fail before fix)
2. Apply the minimal, surgical fix
3. Verify the regression test now passes
4. Run the full test suite: {{testCommand}}
5. Run build: {{buildCommand}}
6. Run lint: {{lintCommand}}
7. Ensure no other tests broke

Commit fix and test together with a clear commit message.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 380 }),

    node("verify", "action.run_agent", "Verify & PR", {
      prompt: `## Phase: Final Verification

1. Run complete test suite: {{testCommand}}
2. Run build: {{buildCommand}}
3. Confirm the original bug is fixed
4. Confirm no regressions
5. Push and create/update PR with root cause analysis in description`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 560 }),

    node("done", "notify.log", "Complete", {
      message: "Debug task completed — bug fixed with regression test.",
    }, { x: 400, y: 720 }),
  ],
  edges: [
    edge("trigger", "reproduce"),
    edge("reproduce", "fix-and-test"),
    edge("fix-and-test", "verify"),
    edge("verify", "done"),
  ],
};


// ═══════════════════════════════════════════════════════════════════════════
//  CI/CD Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const CICD_TASK_TEMPLATE = {
  id: "template-task-cicd",
  name: "CI/CD Task Workflow",
  description:
    "For pipeline, deployment, infrastructure, and build-system tasks. " +
    "Plans the change, implements with validation steps, then verifies " +
    "the pipeline works end-to-end.",
  category: "task-execution",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_assigned",
  variables: {
    taskTimeoutMs: 21600000,
    maxRetries: 2,
    maxContinues: 3,
    testCommand: "auto",
    buildCommand: "auto",
    lintCommand: "auto",
  },
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["ci", "cd", "pipeline", "deploy", "infrastructure", "task-type"],
    resolveMode: "library",
  },
  nodes: [
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      taskPattern: "ci|cd|pipeline|deploy|infrastructure|docker|kubernetes|k8s|terraform|github.action|build.system|release|devops",
    }, { x: 400, y: 50 }),

    node("plan-pipeline", "action.run_agent", "Plan Pipeline Change", {
      prompt: `## Phase: CI/CD Planning

Analyse the pipeline/infrastructure task:
1. Current CI/CD configuration
2. What needs to change and why
3. Impact on existing workflows/pipelines
4. Rollback strategy
5. Test plan for verifying the change

Do NOT make changes yet.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 180 }),

    node("implement-pipeline", "action.run_agent", "Implement Pipeline", {
      prompt: `## Phase: Pipeline Implementation

1. Make the CI/CD / infrastructure changes per the plan
2. Update configuration files (workflows, Dockerfiles, Terraform, etc.)
3. Add or update pipeline tests where applicable
4. Run build: {{buildCommand}}
5. Run lint: {{lintCommand}}
6. Validate configuration syntax

Commit changes with clear descriptions.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 380 }),

    node("verify-pipeline", "action.run_agent", "Verify & PR", {
      prompt: `## Phase: Pipeline Verification

1. Run full test suite: {{testCommand}}
2. Run build: {{buildCommand}}
3. Verify pipeline configuration is valid
4. Push and create/update PR
5. Include deployment / rollback instructions in PR description`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 560 }),

    node("done", "notify.log", "Complete", {
      message: "CI/CD task completed — pipeline updated and verified.",
    }, { x: 400, y: 720 }),
  ],
  edges: [
    edge("trigger", "plan-pipeline"),
    edge("plan-pipeline", "implement-pipeline"),
    edge("implement-pipeline", "verify-pipeline"),
    edge("verify-pipeline", "done"),
  ],
};


// ═══════════════════════════════════════════════════════════════════════════
//  Design Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const DESIGN_TASK_TEMPLATE = {
  id: "template-task-design",
  name: "Design Task Workflow",
  description:
    "For design-related tasks — mockups, wireframes, design tokens, " +
    "component library work. Analyses design requirements, implements " +
    "the design system changes, and verifies visual output.",
  category: "task-execution",
  enabled: true,
  trigger: "trigger.task_assigned",
  variables: {
    taskTimeoutMs: 21600000,
    maxRetries: 2,
    maxContinues: 3,
    testCommand: "auto",
    buildCommand: "auto",
    lintCommand: "auto",
  },
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["design", "mockup", "wireframe", "design-system", "task-type"],
    resolveMode: "library",
  },
  nodes: [
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      taskPattern: "design|mockup|wireframe|prototype|design.system|theme|color|typography|icon|illustration|ux",
    }, { x: 400, y: 50 }),

    node("analyse-requirements", "action.run_agent", "Analyse Design Req", {
      prompt: `## Phase: Design Requirements Analysis

1. Review the design task requirements
2. Identify affected design tokens, components, or patterns
3. Check existing design system for reusable pieces
4. Plan the implementation approach
5. List affected files and components

Do NOT make changes yet.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 180 }),

    node("implement-design", "action.run_agent", "Implement Design", {
      prompt: `## Phase: Design Implementation

1. Update design tokens (colors, spacing, typography) if needed
2. Create / update components per the design specification
3. Ensure consistency with existing design system
4. Add visual tests or snapshots where applicable
5. Run build: {{buildCommand}}
6. Run lint: {{lintCommand}}

Commit changes with descriptive messages.`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 380 }),

    node("verify-design", "action.run_agent", "Verify & PR", {
      prompt: `## Phase: Design Verification

1. Run tests: {{testCommand}}
2. Run build: {{buildCommand}}
3. Verify visual consistency
4. Check design token values are correct
5. Push and create/update PR`,
      taskId: "{{taskId}}",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      agentProfile: "{{agentProfile}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{taskTimeoutMs}}",
      maxRetries: "{{maxRetries}}",
      maxContinues: "{{maxContinues}}",
      resolveMode: "library",
      failOnError: false,
    }, { x: 400, y: 560 }),

    node("done", "notify.log", "Complete", {
      message: "Design task completed — design changes implemented and verified.",
    }, { x: 400, y: 720 }),
  ],
  edges: [
    edge("trigger", "analyse-requirements"),
    edge("analyse-requirements", "implement-design"),
    edge("implement-design", "verify-design"),
    edge("verify-design", "done"),
  ],
};
