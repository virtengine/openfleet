/**
 * sub-workflows.mjs — Reusable Workflow Fragments (Sub-Workflows)
 *
 * Composable node+edge fragments that can be embedded into parent workflows
 * via `embedSubWorkflow()`. Each fragment encapsulates a common pattern
 * that was previously copy-pasted across multiple templates.
 *
 * ## Usage
 *
 *   import { VALIDATE_AND_PR_SUB, PR_HANDOFF_SUB } from "./sub-workflows.mjs";
 *   import { embedSubWorkflow, wire, node, edge } from "./_helpers.mjs";
 *
 *   // Embed validate-and-pr into your template:
 *   const validate = embedSubWorkflow(VALIDATE_AND_PR_SUB, "v1-");
 *   // Wire it after your agent node:
 *   const edges = [...validate.edges, wire("my-agent", validate.entryNodeId)];
 *
 * ## Available Sub-Workflows
 *
 *   VALIDATE_AND_PR_SUB    — build → test → lint → push → create-pr
 *   VALIDATION_GATE_SUB    — build → test → lint (quality gate only, no push/PR)
 *   PR_HANDOFF_SUB         — create-pr → pr-created? → set-inreview → handoff-progressor
 *   PR_CHECK_HANDOFF_SUB   — pr-ok? → set-inreview → handoff-progressor (no create-pr)
 *   AGENT_PLAN_EXECUTE_SUB — plan (no code) → implement → verify
 */

import { node, edge, subWorkflow, agentDefaults } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Validate & PR — build/test/lint → push → create PR
// ═══════════════════════════════════════════════════════════════════════════

export const VALIDATE_AND_PR_SUB = subWorkflow(
  "validate-and-pr",
  [
    node("build", "action.run_command", "Build", {
      command: "{{buildCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 0 }),
    node("test", "action.run_command", "Test", {
      command: "{{testCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 130 }),
    node("lint", "action.run_command", "Lint", {
      command: "{{lintCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 260 }),
    node("push", "action.push_branch", "Push Branch", {
      worktreePath: "{{worktreePath}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 400, y: 390 }),
    node("create-pr", "action.create_pr", "Create / Update PR", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 400, y: 520 }),
  ],
  [
    edge("build", "test"),
    edge("test", "lint"),
    edge("lint", "push"),
    edge("push", "create-pr"),
  ],
  {
    entryNode: "build",
    exitNode: "create-pr",
    description: "Build + Test + Lint validation gate, then push and create/update PR.",
  },
);


// ═══════════════════════════════════════════════════════════════════════════
//  PR Handoff — create-pr → check → set-inreview → dispatch progressor
// ═══════════════════════════════════════════════════════════════════════════

export const PR_HANDOFF_SUB = subWorkflow(
  "pr-handoff",
  [
    node("create-pr", "action.create_pr", "Create / Update PR", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 400, y: 0 }),
    node("pr-created", "condition.expression", "PR Created?", {
      expression: "Boolean($ctx.getNodeOutput('create-pr')?.prNumber || $ctx.getNodeOutput('create-pr')?.prUrl)",
    }, { x: 400, y: 130, outputs: ["yes", "no"] }),
    node("set-inreview", "action.update_task_status", "Set In-Review", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    }, { x: 300, y: 260 }),
    node("handoff-progressor", "action.execute_workflow", "Handoff PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
      },
    }, { x: 300, y: 390 }),
  ],
  [
    edge("create-pr", "pr-created"),
    edge("pr-created", "set-inreview", { port: "yes" }),
    edge("set-inreview", "handoff-progressor"),
  ],
  {
    entryNode: "create-pr",
    exitNode: "handoff-progressor",
    description: "Create PR, verify success, transition task to in-review, and dispatch PR progressor.",
  },
);


// ═══════════════════════════════════════════════════════════════════════════
//  Agent Plan + Execute — plan (no code) → implement → verify
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create an agent plan-execute-verify sub-workflow with custom prompts.
 *
 * @param {object} opts
 * @param {string} opts.planPrompt - Agent prompt for the planning phase
 * @param {string} opts.implementPrompt - Agent prompt for implementation
 * @param {string} opts.verifyPrompt - Agent prompt for verification
 * @param {object} [opts.agentExtra] - Extra config merged into all 3 agent nodes
 * @returns {object} Sub-workflow definition
 */
export function makeAgentPlanExecuteVerifySub(opts) {
  const defaults = agentDefaults(opts.agentExtra || {});

  return subWorkflow(
    "agent-plan-execute-verify",
    [
      node("plan", "action.run_agent", "Plan", {
        prompt: opts.planPrompt,
        ...defaults,
      }, { x: 400, y: 0 }),
      node("implement", "action.run_agent", "Implement", {
        prompt: opts.implementPrompt,
        ...defaults,
      }, { x: 400, y: 160 }),
      node("verify", "action.run_agent", "Verify", {
        prompt: opts.verifyPrompt,
        ...defaults,
      }, { x: 400, y: 320 }),
    ],
    [
      edge("plan", "implement"),
      edge("implement", "verify"),
    ],
    {
      entryNode: "plan",
      exitNode: "verify",
      description: "Three-phase agent pipeline: plan → implement → verify.",
    },
  );
}


// ═══════════════════════════════════════════════════════════════════════════
//  Validation Gate — build → test → lint (quality check only)
// ═══════════════════════════════════════════════════════════════════════════

export const VALIDATION_GATE_SUB = subWorkflow(
  "validation-gate",
  [
    node("build", "validation.build", "Build Check", {
      command: "{{buildCommand}}",
      zeroWarnings: true,
    }, { x: 400, y: 0 }),
    node("test", "validation.tests", "Test Run", {
      command: "{{testCommand}}",
    }, { x: 400, y: 130 }),
    node("lint", "validation.lint", "Lint Check", {
      command: "{{lintCommand}}",
    }, { x: 400, y: 260 }),
  ],
  [
    edge("build", "test"),
    edge("test", "lint"),
  ],
  {
    entryNode: "build",
    exitNode: "lint",
    description: "Sequential build + test + lint quality gate.",
  },
);


// ═══════════════════════════════════════════════════════════════════════════
//  PR Check + Handoff — pr-ok? → set-inreview → handoff-progressor
//  (For use when create-pr already happened upstream.)
// ═══════════════════════════════════════════════════════════════════════════

export const PR_CHECK_HANDOFF_SUB = subWorkflow(
  "pr-check-handoff",
  [
    node("pr-ok", "condition.expression", "PR Created?", {
      expression: "Boolean($ctx.getNodeOutput('create-pr')?.prNumber || $ctx.getNodeOutput('create-pr')?.prUrl)",
    }, { x: 400, y: 0, outputs: ["yes", "no"] }),
    node("set-inreview", "action.update_task_status", "Set In-Review", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    }, { x: 300, y: 130 }),
    node("handoff-progressor", "action.execute_workflow", "Handoff PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
      },
    }, { x: 300, y: 260 }),
  ],
  [
    edge("pr-ok", "set-inreview", { port: "yes" }),
    edge("set-inreview", "handoff-progressor"),
  ],
  {
    entryNode: "pr-ok",
    exitNode: "handoff-progressor",
    description: "Check PR result, transition task to in-review, dispatch PR progressor.",
  },
);


// ═══════════════════════════════════════════════════════════════════════════
//  Installable Sub-Workflow Templates
//
//  These are fully-formed workflow templates (with trigger.workflow_call)
//  that appear under the "Sub-Workflows" category and can be installed
//  standalone, then invoked at runtime via action.execute_workflow.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validation Gate — build → test → lint quality check.
 * Callable from other workflows via action.execute_workflow.
 */
export const VALIDATION_GATE_TEMPLATE = {
  id: "template-sub-validation-gate",
  name: "Validation Gate",
  description:
    "Sequential build → test → lint quality gate. Use as a reusable " +
    "building block — call from other workflows via Execute Workflow node.",
  category: "sub-workflow",
  enabled: true,
  recommended: false,
  trigger: "trigger.workflow_call",
  variables: {
    buildCommand: "auto",
    testCommand: "auto",
    lintCommand: "auto",
    worktreePath: ".",
  },
  metadata: {
    author: "bosun",
    version: 1,
    tags: ["sub-workflow", "validation", "quality-gate"],
  },
  nodes: [
    node("trigger", "trigger.workflow_call", "Workflow Called", {}, { x: 400, y: 50 }),
    node("build", "action.run_command", "Build", {
      command: "{{buildCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 180 }),
    node("test", "action.run_command", "Test", {
      command: "{{testCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 310 }),
    node("lint", "action.run_command", "Lint", {
      command: "{{lintCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 440 }),
    node("done", "notify.log", "Validation Complete", {
      message: "Validation gate passed: build + test + lint.",
    }, { x: 400, y: 570 }),
  ],
  edges: [
    edge("trigger", "build"),
    edge("build", "test"),
    edge("test", "lint"),
    edge("lint", "done"),
  ],
};

/**
 * Validate & PR — build/test/lint → push → create PR.
 * Callable from other workflows via action.execute_workflow.
 */
export const VALIDATE_AND_PR_TEMPLATE = {
  id: "template-sub-validate-and-pr",
  name: "Validate & Create PR",
  description:
    "Build → Test → Lint → Push → Create/Update PR. A complete " +
    "validation-through-PR pipeline as a reusable sub-workflow.",
  category: "sub-workflow",
  enabled: true,
  recommended: false,
  trigger: "trigger.workflow_call",
  variables: {
    buildCommand: "auto",
    testCommand: "auto",
    lintCommand: "auto",
    worktreePath: ".",
    branch: "",
    baseBranch: "",
    taskId: "",
    taskTitle: "",
  },
  metadata: {
    author: "bosun",
    version: 1,
    tags: ["sub-workflow", "validation", "pr", "push"],
  },
  nodes: [
    node("trigger", "trigger.workflow_call", "Workflow Called", {}, { x: 400, y: 50 }),
    node("build", "action.run_command", "Build", {
      command: "{{buildCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 180 }),
    node("test", "action.run_command", "Test", {
      command: "{{testCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 310 }),
    node("lint", "action.run_command", "Lint", {
      command: "{{lintCommand}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 440 }),
    node("push", "action.push_branch", "Push Branch", {
      worktreePath: "{{worktreePath}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 400, y: 570 }),
    node("create-pr", "action.create_pr", "Create / Update PR", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 400, y: 700 }),
    node("done", "notify.log", "PR Pipeline Complete", {
      message: "Validation passed, branch pushed, PR created/updated.",
    }, { x: 400, y: 830 }),
  ],
  edges: [
    edge("trigger", "build"),
    edge("build", "test"),
    edge("test", "lint"),
    edge("lint", "push"),
    edge("push", "create-pr"),
    edge("create-pr", "done"),
  ],
};

/**
 * PR Handoff — create PR → verify → transition to in-review → dispatch progressor.
 * Callable from other workflows via action.execute_workflow.
 */
export const PR_HANDOFF_TEMPLATE = {
  id: "template-sub-pr-handoff",
  name: "PR Handoff",
  description:
    "Create PR → verify creation → set task to in-review → dispatch " +
    "PR Progressor workflow. Reusable handoff building block.",
  category: "sub-workflow",
  enabled: true,
  recommended: false,
  trigger: "trigger.workflow_call",
  variables: {
    taskId: "",
    taskTitle: "",
    branch: "",
    baseBranch: "",
  },
  metadata: {
    author: "bosun",
    version: 1,
    tags: ["sub-workflow", "pr", "handoff"],
    requiredTemplates: ["template-bosun-pr-progressor"],
  },
  nodes: [
    node("trigger", "trigger.workflow_call", "Workflow Called", {}, { x: 400, y: 50 }),
    node("create-pr", "action.create_pr", "Create / Update PR", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 400, y: 180 }),
    node("pr-created", "condition.expression", "PR Created?", {
      expression: "Boolean($ctx.getNodeOutput('create-pr')?.prNumber || $ctx.getNodeOutput('create-pr')?.prUrl)",
    }, { x: 400, y: 310, outputs: ["yes", "no"] }),
    node("set-inreview", "action.update_task_status", "Set In-Review", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    }, { x: 300, y: 440 }),
    node("handoff-progressor", "action.execute_workflow", "Handoff PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
      },
    }, { x: 300, y: 570 }),
    node("done", "notify.log", "Handoff Complete", {
      message: "PR created and PR Progressor dispatched.",
    }, { x: 300, y: 700 }),
  ],
  edges: [
    edge("trigger", "create-pr"),
    edge("create-pr", "pr-created"),
    edge("pr-created", "set-inreview", { port: "yes" }),
    edge("set-inreview", "handoff-progressor"),
    edge("handoff-progressor", "done"),
  ],
};


