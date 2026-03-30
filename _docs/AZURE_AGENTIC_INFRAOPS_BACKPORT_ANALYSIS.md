# Azure Agentic InfraOps Back-Port Analysis

## Purpose

This document compares Bosun with the concepts published in the Azure Agentic InfraOps project and identifies which ideas are already present in Bosun, which are only partially present, and which would materially improve Bosun if promoted into first-class features.

The key conclusion is straightforward:

- Bosun already provides many of the runtime primitives that Azure Agentic InfraOps cites as inspiration.
- The main opportunity is not feature parity.
- The main opportunity is to make Bosun more opinionated by turning existing scattered patterns into an explicit operating model.

## What Azure Agentic InfraOps Adds Conceptually

From the public docs, the Azure project is organized around a stricter orchestration model with:

- a conductor pattern that maintains the evolving execution plan
- explicit approval gates at critical transitions
- invariant validators between steps, not just at the end
- a repository-first memory model for durable state
- typed session state and resumable checkpoints
- challenger reviews as a built-in maker-checker loop
- stronger cost governance and model-tier routing
- deterministic stop conditions for long-running agent workflows

Azure Agentic InfraOps is best understood as Bosun-style engineering patterns wrapped in a more prescriptive control framework.

## What Bosun Already Has

Bosun already contains strong first-class implementations for many of the underlying primitives:

- multi-agent orchestration and supervision
- workflow DAG execution
- distributed shared state and claim-based locking
- context shredding and compression
- anomaly detection and circuit breakers
- PR automation and review gating
- prompt registries and skill loading
- workflow evidence collection and validation nodes

High-signal existing areas:

- `infra/monitor.mjs`
- `agent/agent-supervisor.mjs`
- `agent/agent-pool.mjs`
- `workflow/workflow-engine.mjs`
- `workflow/workflow-nodes.mjs`
- `task/task-claims.mjs`
- `workspace/shared-state-manager.mjs`
- `infra/anomaly-detector.mjs`
- `config/context-shredding-config.mjs`

This matters because the recommendations below are largely architectural surfacing and unification work, not ground-up invention.

## Where Bosun Is Partial Today

Bosun has the pieces, but several of the Azure concepts are not yet expressed as a single explicit contract.

### 1. Supervisor Without A True Conductor Ledger

Bosun has orchestration and supervision, but the plan is not treated as a durable, mutable ledger that is continuously updated as subagents report back.

Current state:

- supervision is strong
- replanning is possible
- the plan itself is not a first-class persisted state object

Impact:

- less transparent progress across long-running tasks
- weaker resume semantics after interruption
- harder to reason about what changed between iterations

### 2. Approval Is Present But Too Coarse

Bosun already has review gates, but approval is not consistently expressed as typed gates on classes of actions.

Current state:

- merge and review gates exist
- workflow `action.ask_user` exists
- agent runtime often defaults to coarse approval policies

Gap:

- no first-class policy like `approvalRequired: ["deploy", "merge", "secrets", "prod-write"]`
- no unified pause-and-resume contract at those exact boundaries

### 3. Validation Happens Too Late

Bosun has strong quality gates, but many checks happen near push, review, or failure recovery time instead of between agent handoffs.

Gap:

- no general transition-level invariant validator layer in the workflow engine
- downstream steps can receive outputs that are structurally valid enough to continue, but not semantically trustworthy enough to compound safely

### 4. Session State Is Not Yet A Canonical Envelope

Bosun has task state, workflow state, session tracking, and shared state. What it does not yet have is one canonical typed session envelope that describes the current objective, current phase, approvals, retry counts, checkpoints, and completion predicates for a run.

Gap:

- harder crash recovery for long multi-step tasks
- weaker auditability for why a run resumed where it did
- harder interoperability between monitor, workflow, and review flows

### 5. No Built-In Challenger Loop

Bosun supports review, but it does not consistently use a built-in maker-checker cycle where one agent produces and a second agent challenges against explicit criteria before promotion.

Gap:

- quality control is partly reactive
- autofix and remediation loops can remain single-perspective
- review criteria are not always converted into repeated structured evaluation

### 6. Cost Governance Is Observed More Than Enforced

Bosun tracks budgets and timeouts, but model-tiering and spend-aware orchestration are not yet a strong first-class control surface.

Gap:

- limited per-run token accounting
- limited per-role model routing based on task complexity and cost
- no explicit budget-triggered compaction, downgrade, or halt policy across a whole orchestration run

### 7. Stop Conditions Are Not Formal Enough

Bosun has retries, cooldowns, anomaly detection, and circuit breakers. That is not the same thing as deterministic completion logic.

Gap:

- no general `goalSatisfied()` contract for long-running orchestration steps
- limited stall detection based on lack of meaningful state change
- limited typed fallback outcomes when iteration caps are reached

## Highest-Leverage Improvements For Bosun

These are the changes most worth back-porting from the Azure style of operation.

### Priority 1: Add A First-Class Run Ledger

Introduce a durable run ledger for complex tasks and workflows.

Suggested contents:

- objective
- current phase
- plan steps
- completed steps
- blocked steps
- approvals granted
- checkpoints
- retry counters
- evidence references
- completion predicate status

Likely Bosun touchpoints:

- `infra/monitor.mjs`
- `workflow/workflow-engine.mjs`
- `task/`
- `workspace/shared-state-manager.mjs`

Outcome:

- better crash recovery
- more reliable replanning
- clearer operator visibility
- easier subagent coordination

### Priority 2: Add Typed Approval Gates

Add policy-driven gates by action class instead of broad runtime approval settings.

Examples:

- `merge`
- `prod-deploy`
- `external-write`
- `secret-use`
- `destructive-git`

Likely Bosun touchpoints:

- `agent/agent-hooks.mjs`
- `workflow/workflow-nodes/actions.mjs`
- `infra/monitor.mjs`
- configuration schema and runtime config

Outcome:

- tighter operator control
- less friction for low-risk automation
- resumable pauses at the right boundaries

### Priority 3: Add Handoff Validators In The Workflow Engine

Add an explicit validation layer between agent-producing nodes and downstream consumer nodes.

Validator types could include:

- schema validity
- confidence threshold
- required evidence presence
- policy compliance
- semantic completeness
- contradiction or drift detection

Likely Bosun touchpoints:

- `workflow/workflow-engine.mjs`
- `workflow/workflow-nodes/validation.mjs`
- `workflow/workflow-contract.mjs`

Outcome:

- fewer error cascades
- safer multi-step automation
- better recovery semantics when a step is low quality but not technically failed

### Priority 4: Add A Built-In Challenger Pattern

Make maker-checker loops a reusable Bosun workflow and runtime primitive.

Pattern:

- maker agent produces output
- challenger agent reviews against explicit criteria
- result is approve, changes requested, or escalate
- iteration cap and fallback policy are mandatory

Likely Bosun touchpoints:

- `agent/review-agent.mjs`
- `agent/agent-supervisor.mjs`
- `agent/autofix.mjs`
- `workflow-templates/`

Outcome:

- stronger code review automation
- better remediation quality
- less self-confirming single-agent behavior

### Priority 5: Formalize Deterministic Stop Conditions

Add explicit completion and stall contracts for long-running flows.

Examples:

- `maxIterations`
- `goalSatisfied`
- `noStateChangeForNRounds`
- `budgetExceeded`
- `approvalTimeout`
- `escalateAfter`

Likely Bosun touchpoints:

- `infra/monitor.mjs`
- `agent/agent-supervisor.mjs`
- `workflow/workflow-engine.mjs`

Outcome:

- fewer ambiguous loops
- better operator trust
- clearer escalation behavior

### Priority 6: Promote Cost Governance To A First-Class Policy Surface

Extend Bosun from budget awareness into budget-based orchestration policy.

Examples:

- route summarization and cleanup work to cheaper models
- reserve premium models for planning, review, and high-risk tasks
- cap spend per run or per task family
- auto-compact context or downgrade model tiers when thresholds are crossed

Likely Bosun touchpoints:

- `agent/agent-pool.mjs`
- `agent/fleet-coordinator.mjs`
- `agent/agent-work-analyzer.mjs`
- config schema

Outcome:

- lower operating cost
- more predictable scaling
- better fleet-level scheduling decisions

## Recommended Implementation Order

If this becomes an actual Bosun improvement track, the order should be:

1. Run ledger and resumable session envelope
2. Typed approval gates
3. Handoff validators
4. Challenger workflow template and runtime support
5. Deterministic stop conditions
6. Cost governance policy surface

That sequence improves reliability first, then quality, then economics.

## What Not To Copy Blindly

Some Azure Agentic InfraOps patterns are domain-specific to Azure infrastructure generation and should not be copied into Bosun wholesale.

Examples:

- Azure-specific governance terminology
- IaC-specific approval stage count
- AVM and Well-Architected checks as Bosun core concepts

Bosun should copy the orchestration pattern, not the infrastructure domain framing.

## Recommended Bosun Positioning

The clearest framing after this comparison is:

> Azure Agentic InfraOps operationalizes several Bosun patterns for one domain.
> Bosun can improve in return by making those same patterns more explicit, durable, and policy-driven at the platform level.

In other words, the best inspiration to take back is:

- stronger state contracts
- stronger gate contracts
- stronger handoff validation
- stronger maker-checker loops
- stronger deterministic completion rules

## Proposed Follow-Up Work

If we decide to implement this, the next useful artifacts would be:

1. a Bosun RFC for `run-ledger.json`
2. a config proposal for typed approval gates
3. a workflow-engine proposal for transition validators
4. a reusable challenger template for maker-checker flows
5. a stop-condition spec shared by monitor and workflow runtime
