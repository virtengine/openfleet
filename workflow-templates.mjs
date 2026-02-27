/**
 * workflow-templates.mjs — Pre-built Workflow Templates for Bosun
 *
 * Ready-to-use workflow definitions that users can install with one click
 * from the visual builder. Each template encodes a complete flow that
 * previously required custom code or env-var configuration.
 *
 * Templates are split into category modules for easy extension:
 *   workflow-templates/github.mjs     — PR Merge Strategy, Triage, Conflict Resolver, Stale Reaper, Release Drafter
 *   workflow-templates/agents.mjs     — Frontend Agent, Review Agent, Custom Agent, Session Monitor, Backend Agent
 *   workflow-templates/planning.mjs   — Task Planner, Task Replenish, Nightly Report, Sprint Retrospective
 *   workflow-templates/ci-cd.mjs      — Build & Deploy, Release Pipeline, Canary Deploy
 *   workflow-templates/reliability.mjs — Error Recovery, Anomaly Watchdog, Workspace Hygiene, Health Check, Task Finalization Guard, Task Repair Worktree, Incident Response
 *   workflow-templates/security.mjs   — Dependency Audit, Secret Scanner
 *
 * To add a new template:
 *   1. Choose the appropriate category file (or create a new one)
 *   2. Import { node, edge, resetLayout } from "./_helpers.mjs"
 *   3. Define and export your template constant
 *   4. Add the export to this index file's WORKFLOW_TEMPLATES array
 *
 * Categories: github, agents, planning, ci-cd, reliability, security, custom
 *
 * EXPORTS:
 *   WORKFLOW_TEMPLATES     — Array of all built-in templates
 *   TEMPLATE_CATEGORIES    — Category metadata (label, icon, order)
 *   getTemplate(id)        — Get a single template by ID
 *   installTemplate(id, engine) — Install a template into the workflow engine
 *   listTemplates()        — List all available templates
 */

import { randomUUID } from "node:crypto";

// ── Re-export helpers for external consumers ────────────────────────────────
export { node, edge, resetLayout } from "./workflow-templates/_helpers.mjs";

// ── Import templates from category modules ──────────────────────────────────

// GitHub
import {
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  RELEASE_DRAFTER_TEMPLATE,
} from "./workflow-templates/github.mjs";

// Agents
import {
  FRONTEND_AGENT_TEMPLATE,
  REVIEW_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  BACKEND_AGENT_TEMPLATE,
} from "./workflow-templates/agents.mjs";

// Planning
import {
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
  SPRINT_RETROSPECTIVE_TEMPLATE,
} from "./workflow-templates/planning.mjs";

// CI/CD
import {
  BUILD_DEPLOY_TEMPLATE,
  RELEASE_PIPELINE_TEMPLATE,
  CANARY_DEPLOY_TEMPLATE,
} from "./workflow-templates/ci-cd.mjs";

// Reliability
import {
  ERROR_RECOVERY_TEMPLATE,
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
  TASK_FINALIZATION_GUARD_TEMPLATE,
  TASK_REPAIR_WORKTREE_TEMPLATE,
  INCIDENT_RESPONSE_TEMPLATE,
} from "./workflow-templates/reliability.mjs";

// Security
import {
  DEPENDENCY_AUDIT_TEMPLATE,
  SECRET_SCANNER_TEMPLATE,
} from "./workflow-templates/security.mjs";

// ── Re-export individual templates for direct import ────────────────────────

export {
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  RELEASE_DRAFTER_TEMPLATE,
  FRONTEND_AGENT_TEMPLATE,
  REVIEW_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  BACKEND_AGENT_TEMPLATE,
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
  SPRINT_RETROSPECTIVE_TEMPLATE,
  BUILD_DEPLOY_TEMPLATE,
  RELEASE_PIPELINE_TEMPLATE,
  CANARY_DEPLOY_TEMPLATE,
  ERROR_RECOVERY_TEMPLATE,
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
  TASK_FINALIZATION_GUARD_TEMPLATE,
  TASK_REPAIR_WORKTREE_TEMPLATE,
  INCIDENT_RESPONSE_TEMPLATE,
  DEPENDENCY_AUDIT_TEMPLATE,
  SECRET_SCANNER_TEMPLATE,
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
  security:    { label: "Security",     icon: "🔒", order: 6 },
  custom:      { label: "Custom",       icon: "⚙️", order: 7 },
});

export const WORKFLOW_TEMPLATES = Object.freeze([
  // ── GitHub ──
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  RELEASE_DRAFTER_TEMPLATE,
  // ── Agents ──
  REVIEW_AGENT_TEMPLATE,
  FRONTEND_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  BACKEND_AGENT_TEMPLATE,
  // ── Planning ──
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
  SPRINT_RETROSPECTIVE_TEMPLATE,
  // ── CI/CD ──
  BUILD_DEPLOY_TEMPLATE,
  RELEASE_PIPELINE_TEMPLATE,
  CANARY_DEPLOY_TEMPLATE,
  // ── Reliability ──
  ERROR_RECOVERY_TEMPLATE,
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
  TASK_FINALIZATION_GUARD_TEMPLATE,
  TASK_REPAIR_WORKTREE_TEMPLATE,
  INCIDENT_RESPONSE_TEMPLATE,
  // ── Security ──
  DEPENDENCY_AUDIT_TEMPLATE,
  SECRET_SCANNER_TEMPLATE,
]);

const _TEMPLATE_BY_ID = new Map(
  WORKFLOW_TEMPLATES.map((template) => [template.id, template]),
);

/**
 * Setup workflow profiles used by `bosun --setup`.
 * - `manual`: human-driven dispatch with reliability safety nets.
 * - `balanced`: recommended default for most teams.
 * - `autonomous`: higher automation with planning + maintenance workflows.
 */
export const WORKFLOW_SETUP_PROFILES = Object.freeze({
  manual: Object.freeze({
    id: "manual",
    name: "Manual Dispatch",
    description:
      "Best for teams that dispatch tasks manually and want guardrails, " +
      "review automation, and recovery paths.",
    recommendedFor: "Hands-on workflow control with low automation risk.",
    workflowAutomationEnabled: false,
    templateIds: Object.freeze([
      "template-error-recovery",
      "template-task-finalization-guard",
      "template-task-repair-worktree",
      "template-review-agent",
      "template-health-check",
    ]),
  }),
  balanced: Object.freeze({
    id: "balanced",
    name: "Balanced (Recommended)",
    description:
      "Reliable default with automated PR quality gates and targeted " +
      "self-healing, without over-automating planning.",
    recommendedFor: "Most repos and teams adopting Bosun for daily delivery.",
    workflowAutomationEnabled: true,
    templateIds: Object.freeze([
      "template-pr-merge-strategy",
      "template-review-agent",
      "template-backend-agent",
      "template-error-recovery",
      "template-anomaly-watchdog",
      "template-agent-session-monitor",
      "template-task-finalization-guard",
      "template-task-repair-worktree",
      "template-dependency-audit",
    ]),
  }),
  autonomous: Object.freeze({
    id: "autonomous",
    name: "Autonomous",
    description:
      "Higher automation for end-to-end flow: planning, recovery, conflict " +
      "handling, maintenance, and incident response.",
    recommendedFor: "Teams optimizing for maximum unattended throughput.",
    workflowAutomationEnabled: true,
    templateIds: Object.freeze([
      "template-pr-merge-strategy",
      "template-pr-conflict-resolver",
      "template-review-agent",
      "template-backend-agent",
      "template-task-planner",
      "template-task-replenish",
      "template-error-recovery",
      "template-anomaly-watchdog",
      "template-agent-session-monitor",
      "template-workspace-hygiene",
      "template-task-finalization-guard",
      "template-task-repair-worktree",
      "template-incident-response",
      "template-release-pipeline",
      "template-dependency-audit",
    ]),
  }),
});

function normalizeTemplateIdList(templateIds = []) {
  const source = Array.isArray(templateIds)
    ? templateIds
    : String(templateIds || "").split(",");
  const normalized = [];
  for (const raw of source) {
    const id = String(raw || "").trim();
    if (!id || !_TEMPLATE_BY_ID.has(id) || normalized.includes(id)) continue;
    normalized.push(id);
  }
  return normalized;
}

function resolveProfileTemplateIds(profileId) {
  const normalized = String(profileId || "").trim().toLowerCase();
  const profile =
    WORKFLOW_SETUP_PROFILES[normalized] || WORKFLOW_SETUP_PROFILES.balanced;
  return [...profile.templateIds];
}

/**
 * Get a template by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getTemplate(id) {
  return _TEMPLATE_BY_ID.get(id) || null;
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
 * List setup workflow profiles for the setup wizard.
 * @returns {Array<{id: string, name: string, description: string, recommendedFor: string, workflowAutomationEnabled: boolean, templateIds: string[]}>}
 */
export function listWorkflowSetupProfiles() {
  return Object.values(WORKFLOW_SETUP_PROFILES).map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    recommendedFor: profile.recommendedFor,
    workflowAutomationEnabled: profile.workflowAutomationEnabled === true,
    templateIds: [...profile.templateIds],
  }));
}

/**
 * Get a single setup profile by id.
 * Falls back to `balanced` when unknown.
 * @param {string} profileId
 * @returns {{id: string, name: string, description: string, recommendedFor: string, workflowAutomationEnabled: boolean, templateIds: string[]}}
 */
export function getWorkflowSetupProfile(profileId = "balanced") {
  const normalized = String(profileId || "").trim().toLowerCase();
  const profile =
    WORKFLOW_SETUP_PROFILES[normalized] || WORKFLOW_SETUP_PROFILES.balanced;
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    recommendedFor: profile.recommendedFor,
    workflowAutomationEnabled: profile.workflowAutomationEnabled === true,
    templateIds: [...profile.templateIds],
  };
}

/**
 * Resolve template IDs from a setup profile and/or explicit custom template IDs.
 * Explicit template IDs win when provided.
 * @param {object} opts
 * @param {string} [opts.profileId]
 * @param {string[]|string} [opts.templateIds]
 * @returns {string[]}
 */
export function resolveWorkflowTemplateIds(opts = {}) {
  const explicit = normalizeTemplateIdList(opts.templateIds || []);
  if (explicit.length > 0) return explicit;
  return resolveProfileTemplateIds(opts.profileId || "balanced");
}

/**
 * List recommended templates only.
 * @returns {Array<object>}
 */
export function listRecommendedTemplates() {
  return WORKFLOW_TEMPLATES.filter((t) => t.recommended === true);
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

  // Dedup check: prevent installing a template that's already installed
  const existing = engine.list();
  const alreadyInstalled = existing.some(
    (wf) => wf.metadata?.installedFrom === templateId || wf.name === template.name
  );
  if (alreadyInstalled) {
    throw new Error(`Template "${template.name}" is already installed`);
  }

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

/**
 * Install a specific set of template IDs.
 * @param {import('./workflow-engine.mjs').WorkflowEngine} engine
 * @param {string[]|string} templateIds
 * @param {Record<string, object>} [overridesById]
 * @returns {{installed: object[], skipped: string[], errors: Array<{id: string, error: string}>}}
 */
export function installTemplateSet(engine, templateIds = [], overridesById = {}) {
  const source = Array.isArray(templateIds)
    ? templateIds
    : String(templateIds || "").split(",");
  const requested = [];
  for (const raw of source) {
    const id = String(raw || "").trim();
    if (!id || requested.includes(id)) continue;
    requested.push(id);
  }
  const existing = engine.list();
  const installedLookup = new Set(
    existing.flatMap((wf) => [wf.metadata?.installedFrom, wf.name]).filter(Boolean),
  );
  const results = { installed: [], skipped: [], errors: [] };

  for (const templateId of requested) {
    const template = getTemplate(templateId);
    if (!template) {
      results.errors.push({ id: templateId, error: `Template "${templateId}" not found` });
      continue;
    }
    if (installedLookup.has(template.id) || installedLookup.has(template.name)) {
      results.skipped.push(template.id);
      continue;
    }
    try {
      const overrides = overridesById[template.id] || overridesById[template.name] || {};
      const wf = installTemplate(template.id, engine, overrides);
      results.installed.push(wf);
      installedLookup.add(template.id);
      installedLookup.add(template.name);
    } catch (err) {
      results.errors.push({ id: template.id, error: err.message });
    }
  }

  return results;
}

/**
 * Ensure all recommended templates are installed.
 * @param {import('./workflow-engine.mjs').WorkflowEngine} engine
 * @param {Record<string, object>} [overridesById] Optional variable overrides keyed by template id.
 * @returns {{installed: object[], skipped: string[], errors: Array<{id: string, error: string}>}}
 */
export function installRecommendedTemplates(engine, overridesById = {}) {
  const recommendedIds = WORKFLOW_TEMPLATES
    .filter((template) => template.recommended === true)
    .map((template) => template.id);
  return installTemplateSet(engine, recommendedIds, overridesById);
}
