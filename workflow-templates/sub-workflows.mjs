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
 *   VALIDATE_AND_PR_SUB   — build → test → lint → push → create-pr
 *   PR_HANDOFF_SUB        — create-pr → pr-created? → set-inreview → handoff-progressor
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
      cwd: "{{worktreePath}}",
      branch: "{{branch}}",
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
      expression: "$ctx.getNodeOutput($edge.source)?.success === true || $ctx.getNodeOutput($edge.source)?.prUrl",
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
