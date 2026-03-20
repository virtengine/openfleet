/**
 * task-execution.mjs — Task-Type Execution Workflow Templates
 *
 * Specialised workflows that are matched to tasks based on title/description
 * patterns. Each template uses trigger.task_assigned with regex filters so
 * the right workflow picks up the right kind of task automatically.
 *
 * ## Composition
 *
 * Templates use `makeAgentPipeline()` for the creative agent phases and
 * embed `VALIDATE_AND_PR_SUB` for the deterministic validation + PR tail.
 * Agent nodes handle planning and implementation (token-worthy creative work).
 * Build, test, lint, push, and PR creation use explicit workflow nodes —
 * no agent reasoning wasted on deterministic shell commands.
 *
 * Templates:
 *   - Fullstack Task Workflow
 *   - Backend Task Workflow
 *   - Frontend Task Workflow
 *   - Debug Task Workflow
 *   - CI/CD Task Workflow
 *   - Design Task Workflow
 */

import { node, edge, agentPhase, embedSubWorkflow, wire, resetLayout } from "./_helpers.mjs";
import { VALIDATE_AND_PR_SUB } from "./sub-workflows.mjs";

/**
 * Build a task-execution template with agent phases followed by an
 * embedded validate-and-PR sub-workflow tail.
 *
 * Agent phases handle planning/implementation (creative work).
 * Validation (build/test/lint) + push + PR use explicit nodes.
 */
function makeTaskTemplate(opts) {
  if (!opts?.id) throw new Error("makeTaskTemplate: id is required");
  if (!opts?.taskPattern) throw new Error("makeTaskTemplate: taskPattern is required");
  if (!Array.isArray(opts?.phases) || opts.phases.length === 0) {
    throw new Error("makeTaskTemplate: at least one phase is required");
  }

  resetLayout();

  const defaultVariables = {
    taskTimeoutMs: 21600000,
    maxRetries: 2,
    maxContinues: 3,
    testCommand: "auto",
    buildCommand: "auto",
    lintCommand: "auto",
  };

  const triggerNode = node("trigger", "trigger.task_assigned", "Task Assigned", {
    taskPattern: opts.taskPattern,
  }, { x: 400, y: 50 });

  const yStart = 180;
  const yStep = 160;
  const phaseNodes = opts.phases.map((phase, i) =>
    agentPhase(phase.id, phase.label, phase.prompt, phase.extra || {}, {
      x: 400,
      y: yStart + i * yStep,
    }),
  );

  // Embed the validate-and-PR sub-workflow after the last agent phase
  const vpSub = embedSubWorkflow(VALIDATE_AND_PR_SUB, "vp-");
  // Reposition embedded nodes below the agent phases
  const vpYStart = yStart + opts.phases.length * yStep;
  const vpNodes = vpSub.nodes.map((n, i) => ({
    ...n,
    position: { x: 400, y: vpYStart + i * 130 },
  }));

  const doneNode = node("done", "notify.log", "Complete", {
    message: opts.doneMessage || `${opts.name} completed.`,
  }, { x: 400, y: vpYStart + vpNodes.length * 130 });

  const allNodes = [triggerNode, ...phaseNodes, ...vpNodes, doneNode];

  // Edges: trigger → phase0 → … → phaseN → vp-entry → … → vp-exit → done
  const edges = [];
  edges.push(edge("trigger", opts.phases[0].id));
  for (let i = 0; i < opts.phases.length - 1; i++) {
    edges.push(edge(opts.phases[i].id, opts.phases[i + 1].id));
  }
  // Wire last agent phase → validate-and-PR entry
  edges.push(wire(opts.phases[opts.phases.length - 1].id, vpSub.entryNodeId));
  // Include sub-workflow internal edges
  edges.push(...vpSub.edges);
  // Wire validate-and-PR exit → done
  edges.push(wire(vpSub.exitNodeId, "done"));

  return {
    id: opts.id,
    name: opts.name,
    description: opts.description || "",
    category: opts.category || "task-execution",
    enabled: true,
    recommended: opts.recommended !== false,
    trigger: "trigger.task_assigned",
    variables: { ...defaultVariables, ...opts.variables },
    metadata: {
      author: "bosun",
      version: 2,
      createdAt: "2025-06-01T00:00:00Z",
      templateVersion: "2.0.0",
      tags: opts.tags || [],
      resolveMode: "library",
      ...(opts.metadata || {}),
    },
    nodes: allNodes,
    edges,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  Fullstack Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

export const FULLSTACK_TASK_TEMPLATE = makeTaskTemplate({
  id: "template-task-fullstack",
  name: "Fullstack Task Workflow",
  description:
    "Handles tasks that span frontend and backend — API endpoints, " +
    "database models, and UI components. Agent phases handle architecture " +
    "planning, backend implementation, and frontend implementation. " +
    "Validation (build/test/lint) and PR creation run as explicit nodes.",
  taskPattern: "full.?stack|end.to.end|api.*ui|server.*client|frontend.*backend|database.*component",
  tags: ["fullstack", "task-type"],
  recommended: true,
  phases: [
    {
      id: "plan-architecture",
      label: "Plan Architecture",
      prompt: `## Phase: Architecture Planning

Analyse the task and produce a concrete plan covering:
1. Backend changes: API routes, models, services, migrations
2. Frontend changes: components, pages, state management
3. Shared types / contracts between layers
4. Test strategy for each layer
5. Integration points and data flow

Do NOT write code yet — produce only the plan.`,
    },
    {
      id: "implement-backend",
      label: "Implement Backend",
      prompt: `## Phase: Backend Implementation

Implement the server-side / API changes from the architecture plan:
- Models, schemas, database migrations
- API routes and controllers
- Service / business logic
- Unit tests for backend logic

Commit backend changes separately.`,
    },
    {
      id: "implement-frontend",
      label: "Implement Frontend",
      prompt: `## Phase: Frontend Implementation

Implement the client-side / UI changes:
- Components, pages, layouts
- State management and API integration
- Styling and responsive design
- Component tests

Commit frontend changes separately.`,
    },
  ],
  doneMessage: "Fullstack task completed — all layers implemented, validated, and PR created.",
});


// ═══════════════════════════════════════════════════════════════════════════
//  Backend Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

export const BACKEND_TASK_TEMPLATE = makeTaskTemplate({
  id: "template-task-backend",
  name: "Backend Task Workflow",
  description:
    "Specialised for server-side tasks — APIs, databases, services, " +
    "middleware. Agent phases handle planning and TDD implementation. " +
    "Validation and PR creation run as explicit nodes.",
  taskPattern: "api|server|backend|database|model|migration|endpoint|middleware|service|graphql|rest|grpc",
  tags: ["backend", "api", "server", "task-type"],
  recommended: true,
  phases: [
    {
      id: "plan",
      label: "Plan Backend",
      prompt: `## Phase: Backend Planning

Analyse the task and produce a plan:
1. Data model / schema changes
2. API endpoint design (routes, request/response shapes)
3. Service layer logic
4. Database queries or migrations
5. Test plan (unit + integration)

Do NOT write code yet.`,
    },
    {
      id: "implement-tdd",
      label: "Implement (TDD)",
      prompt: `## Phase: Test-Driven Implementation

1. Write tests FIRST for the planned changes
2. Verify tests fail (red)
3. Implement the backend logic to make tests pass (green)
4. Refactor for clarity and performance

Commit with descriptive messages.`,
    },
  ],
  doneMessage: "Backend task completed — API/service implemented, validated, and PR created.",
});


// ═══════════════════════════════════════════════════════════════════════════
//  Frontend Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

export const FRONTEND_TASK_TEMPLATE = makeTaskTemplate({
  id: "template-task-frontend",
  name: "Frontend Task Workflow",
  description:
    "Specialised for UI tasks — components, pages, styling, " +
    "accessibility. Agent phases handle design analysis and UI " +
    "implementation. Validation and PR creation run as explicit nodes.",
  taskPattern: "frontend|ui|component|page|layout|style|css|responsive|accessibility|a11y|design.system",
  tags: ["frontend", "ui", "css", "component", "task-type"],
  recommended: true,
  phases: [
    {
      id: "analyse-design",
      label: "Analyse Design",
      prompt: `## Phase: Design Analysis

Analyse the UI task requirements:
1. Component hierarchy and structure
2. Layout and responsive breakpoints
3. State management needs
4. Accessibility requirements (ARIA, keyboard nav)
5. Styling approach (CSS modules, Tailwind, styled-components)
6. Component test plan

Do NOT write code yet.`,
    },
    {
      id: "implement-ui",
      label: "Implement UI",
      prompt: `## Phase: UI Implementation

1. Create / update components per the design plan
2. Implement layouts, styling, and responsive design
3. Add proper accessibility attributes
4. Write component tests

Commit with descriptive messages.`,
    },
  ],
  doneMessage: "Frontend task completed — UI implemented, validated, and PR created.",
});


// ═══════════════════════════════════════════════════════════════════════════
//  Debug Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

export const DEBUG_TASK_TEMPLATE = makeTaskTemplate({
  id: "template-task-debug",
  name: "Debug Task Workflow",
  description:
    "Bug investigation and fix workflow. Agent phases handle reproduction, " +
    "root-cause analysis, and surgical fix with regression tests. " +
    "Validation and PR creation run as explicit nodes.",
  taskPattern: "bug|fix|error|crash|regression|broken|debug|issue|defect|hotfix|patch",
  tags: ["debug", "bug", "fix", "error", "task-type"],
  recommended: true,
  variables: { maxRetries: 3, maxContinues: 4 },
  phases: [
    {
      id: "reproduce",
      label: "Reproduce & Analyse",
      prompt: `## Phase: Bug Reproduction & Root Cause Analysis

1. Read the bug report carefully
2. Find the relevant code area
3. Reproduce the issue (write a failing test if possible)
4. Trace the root cause through the codebase
5. Document: what fails, where, why, and the minimal fix needed

Do NOT fix the bug yet — only diagnose.`,
    },
    {
      id: "fix-and-test",
      label: "Fix & Regression Test",
      prompt: `## Phase: Fix Implementation with Regression Tests

1. Write a regression test that demonstrates the bug (must fail before fix)
2. Apply the minimal, surgical fix
3. Verify the regression test now passes

Commit fix and test together with a clear commit message.`,
    },
  ],
  doneMessage: "Debug task completed — bug fixed, validated, and PR created.",
});


// ═══════════════════════════════════════════════════════════════════════════
//  CI/CD Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
//  CI/CD Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

export const CICD_TASK_TEMPLATE = makeTaskTemplate({
  id: "template-task-cicd",
  name: "CI/CD Task Workflow",
  description:
    "For pipeline, deployment, infrastructure, and build-system tasks. " +
    "Agent phases handle planning and implementation. " +
    "Validation and PR creation run as explicit nodes.",
  taskPattern: "ci|cd|pipeline|deploy|infrastructure|docker|kubernetes|k8s|terraform|github.action|build.system|release|devops",
  tags: ["ci", "cd", "pipeline", "deploy", "infrastructure", "task-type"],
  recommended: true,
  phases: [
    {
      id: "plan-pipeline",
      label: "Plan Pipeline Change",
      prompt: `## Phase: CI/CD Planning

Analyse the pipeline/infrastructure task:
1. Current CI/CD configuration
2. What needs to change and why
3. Impact on existing workflows/pipelines
4. Rollback strategy
5. Test plan for verifying the change

Do NOT make changes yet.`,
    },
    {
      id: "implement-pipeline",
      label: "Implement Pipeline",
      prompt: `## Phase: Pipeline Implementation

1. Make the CI/CD / infrastructure changes per the plan
2. Update configuration files (workflows, Dockerfiles, Terraform, etc.)
3. Add or update pipeline tests where applicable
4. Validate configuration syntax

Commit changes with clear descriptions.`,
    },
  ],
  doneMessage: "CI/CD task completed — pipeline updated, validated, and PR created.",
});


// ═══════════════════════════════════════════════════════════════════════════
//  Design Task Workflow
// ═══════════════════════════════════════════════════════════════════════════

export const DESIGN_TASK_TEMPLATE = makeTaskTemplate({
  id: "template-task-design",
  name: "Design Task Workflow",
  description:
    "For design-related tasks — mockups, wireframes, design tokens, " +
    "component library work. Agent phases handle analysis and implementation. " +
    "Validation and PR creation run as explicit nodes.",
  taskPattern: "design|mockup|wireframe|prototype|design.system|theme|color|typography|icon|illustration|ux",
  tags: ["design", "mockup", "wireframe", "design-system", "task-type"],
  phases: [
    {
      id: "analyse-requirements",
      label: "Analyse Design Req",
      prompt: `## Phase: Design Requirements Analysis

1. Review the design task requirements
2. Identify affected design tokens, components, or patterns
3. Check existing design system for reusable pieces
4. Plan the implementation approach
5. List affected files and components

Do NOT make changes yet.`,
    },
    {
      id: "implement-design",
      label: "Implement Design",
      prompt: `## Phase: Design Implementation

1. Update design tokens (colors, spacing, typography) if needed
2. Create / update components per the design specification
3. Ensure consistency with existing design system
4. Add visual tests or snapshots where applicable

Commit changes with descriptive messages.`,
    },
  ],
  doneMessage: "Design task completed — design implemented, validated, and PR created.",
});
