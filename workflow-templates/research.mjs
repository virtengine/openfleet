/**
 * research.mjs — Research agent workflow templates.
 *
 * Templates:
 *   - Iterative Research Agent (Aletheia-style generate→verify→revise cycle)
 *
 * Demonstrates the convergence loop capabilities added to the workflow engine:
 *   - Back-edges for iterative cycles
 *   - transform.llm_parse for structured LLM output parsing
 *   - condition.switch for multi-way routing based on verifier verdicts
 *   - action.web_search for literature navigation
 *   - loop.while for sub-workflow-based iteration
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Iterative Research Agent (Aletheia-style)
//
//  Architecture modeled after Google DeepMind's Aletheia:
//
//    Problem → Generator → Candidate Solution → Verifier → Decision Point
//                ↑                                      ↓
//                |                              ┌───────┼───────┐
//                |                              │       │       │
//                |                          Correct  Minor Fix  Critical
//                |                              ↓       ↓       │
//                |                           Output  Reviser    │
//                |                                     ↓        │
//                |                              Back to Verify   │
//                └──────────────────────────────────────────────┘
//
//  Uses back-edges for the verify→revise loop and full-restart cycles.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const RESEARCH_AGENT_TEMPLATE = {
  id: "template-research-agent",
  name: "Iterative Research Agent",
  description:
    "An iterative research agent inspired by Google DeepMind's Aletheia. " +
    "Generates a candidate solution, verifies it with an independent model, " +
    "and routes through revision (minor fixes) or full regeneration (critical " +
    "flaws) cycles until the solution converges or max iterations are reached. " +
    "Supports web search for literature navigation.",
  category: "research",
  enabled: true,
  trigger: "trigger.manual",
  variables: {
    maxIterations: 10,
    problem: "",
    domain: "mathematics",
  },
  nodes: [
    // ── Entry ─────────────────────────────────────────────────────────
    node("trigger", "trigger.manual", "Start Research", {}, { x: 400, y: 50 }),

    // ── Optional: search for relevant literature ──────────────────────
    node("literature-search", "action.web_search", "Search Literature", {
      query: "{{problem}} {{domain}} research papers",
      maxResults: 5,
      engine: "fetch",
    }, { x: 400, y: 160 }),

    // ── Generator: produce a candidate solution ───────────────────────
    node("generator", "action.run_agent", "Generate Solution", {
      prompt: `# Research Problem — Generate a Candidate Solution

## Problem
{{problem}}

## Domain
{{domain}}

## Configuration
Max verification cycles: {{maxIterations}}

## Literature Context
{{literature-search.results}}

## Previous Attempts
{{_previousFeedback}}

## Instructions
You are a research agent solving a challenging problem in {{domain}}.
Produce a rigorous, well-structured candidate solution. Show your
reasoning step-by-step. If this is a retry after a critical flaw,
take a fundamentally different approach.

Provide your solution in a clear format with:
1. Approach overview
2. Detailed proof/derivation/analysis
3. Verification of key steps
4. Final answer/conclusion`,
      sdk: "auto",
      timeoutMs: 1800000,
      failOnError: false,
    }, { x: 400, y: 280 }),

    // ── Verifier: independent model reviews the candidate ─────────────
    node("verifier", "action.run_agent", "Verify Solution", {
      prompt: `# Independent Verification

## Original Problem
{{problem}}

## Candidate Solution
{{generator.output}}

## Instructions
You are an independent verifier. Rigorously check the candidate solution:
1. Is the logic/proof valid at every step?
2. Are there any gaps, errors, or unjustified assumptions?
3. Is the conclusion correct and complete?

Provide your assessment with ONE of these verdicts:

**VERDICT: CORRECT** — The solution is rigorous and complete.
**VERDICT: MINOR** — The solution has the right approach but needs fixes. List specific issues.
**VERDICT: CRITICAL** — The solution is fundamentally flawed. Explain why.

After the verdict, provide detailed feedback explaining your reasoning.`,
      sdk: "auto",
      timeoutMs: 900000,
      failOnError: false,
    }, { x: 400, y: 420 }),

    // ── Parse the verifier's output into structured fields ────────────
    node("parse-verdict", "transform.llm_parse", "Parse Verdict", {
      input: "verifier",
      field: "output",
      patterns: {
        verdict: "VERDICT:\\s*(CORRECT|MINOR|CRITICAL)",
      },
      keywords: {
        severity: ["correct", "minor", "critical"],
      },
      outputPort: "verdict",
    }, { x: 400, y: 540 }),

    // ── Route based on verdict ────────────────────────────────────────
    // (port-based routing via matchedPort from parse-verdict)

    // ── CORRECT → output the solution ─────────────────────────────────
    node("output-result", "notify.log", "Solution Found!", {
      message: "Research complete! Solution verified as correct.\n\nProblem: {{problem}}\nSolution: {{generator.output}}",
      level: "info",
    }, { x: 100, y: 680 }),

    // ── MINOR → revise and re-verify ──────────────────────────────────
    node("reviser", "action.continue_session", "Revise Solution", {
      prompt: `The verifier found minor issues with your solution:

{{verifier.output}}

Please fix these specific issues while keeping your overall approach.
Provide the corrected solution in the same format.`,
      strategy: "refine",
      timeoutMs: 900000,
    }, { x: 400, y: 680 }),

    // ── CRITICAL → log and restart generator from scratch ─────────────
    node("critical-log", "notify.log", "Critical Flaw Detected", {
      message: "Critical flaw in solution — restarting generator with new approach.\nFeedback: {{verifier.output}}",
      level: "warn",
    }, { x: 700, y: 680 }),

    node("store-feedback", "action.set_variable", "Store Feedback", {
      variable: "_previousFeedback",
      value: "Previous attempt was critically flawed: {{verifier.output}}. Take a fundamentally different approach.",
    }, { x: 700, y: 800 }),
  ],

  edges: [
    // Forward flow
    edge("trigger", "literature-search"),
    edge("literature-search", "generator"),
    edge("generator", "verifier"),
    edge("verifier", "parse-verdict"),

    // Route by verdict port
    edge("parse-verdict", "output-result", { port: "correct" }),
    edge("parse-verdict", "reviser", { port: "minor" }),
    edge("parse-verdict", "critical-log", { port: "critical" }),

    // Back-edges for convergence loops
    // Minor revision → back to verifier (check the revised solution)
    edge("reviser", "verifier", { backEdge: true, maxIterations: 5 }),

    // Critical flaw → store feedback → back to generator (full restart)
    edge("critical-log", "store-feedback"),
    edge("store-feedback", "generator", { backEdge: true, maxIterations: 5 }),
  ],

  metadata: {
    createdAt: "2026-03-03T00:00:00.000Z",
    version: 1,
    author: "bosun",
    tags: ["research", "aletheia", "convergence-loop", "back-edge"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Iterative Research Agent — Sub-Workflow Variant (loop.while)
//
//  An alternative approach that uses loop.while to iterate a child
//  workflow instead of back-edges. Simpler to understand but requires
//  a separate sub-workflow definition.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const RESEARCH_LOOP_TEMPLATE = {
  id: "template-research-loop",
  name: "Research Loop (While-Based)",
  description:
    "An iterative research agent using loop.while to repeatedly execute " +
    "a generate→verify sub-workflow until the solution converges. " +
    "Alternative to the back-edge approach — useful when you want " +
    "the iteration logic centralized in a single node.",
  category: "research",
  enabled: true,
  trigger: "trigger.manual",
  variables: {
    maxIterations: 10,
    problem: "",
    domain: "mathematics",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start Research", {}, { x: 400, y: 50 }),

    node("search", "action.web_search", "Search Literature", {
      query: "{{problem}} {{domain}} research",
      maxResults: 5,
    }, { x: 400, y: 160 }),

    node("iterate", "loop.while", "Iterate Until Converged", {
      condition: "$state._lastSuccess !== true || $state._verdict !== 'correct'",
      workflowId: "{{_researchSubWorkflowId}}",
      maxIterations: "{{maxIterations}}",
      stateVariable: "researchState",
      earlyExitOn: "never",
    }, { x: 400, y: 280 }),

    node("output", "notify.log", "Research Complete", {
      message: "Research loop completed after {{iterate.iterations}} iteration(s). Converged: {{iterate.converged}}",
      level: "info",
    }, { x: 400, y: 400 }),
  ],

  edges: [
    edge("trigger", "search"),
    edge("search", "iterate"),
    edge("iterate", "output"),
  ],

  metadata: {
    createdAt: "2026-03-03T00:00:00.000Z",
    version: 1,
    author: "bosun",
    tags: ["research", "loop-while", "convergence"],
  },
};

// ── Export all templates ─────────────────────────────────────────────────

export const templates = [
  RESEARCH_AGENT_TEMPLATE,
  RESEARCH_LOOP_TEMPLATE,
];

export default templates;
