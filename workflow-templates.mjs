/**
 * workflow-templates.mjs — Pre-built Workflow Templates for Bosun
 *
 * Ready-to-use workflow definitions that users can install with one click
 * from the visual builder. Each template encodes a complete flow that
 * previously required custom code or env-var configuration.
 *
 * Templates are split into category modules for easy extension:
 *   workflow-templates/github.mjs     — PR Merge Strategy, Triage, Conflict Resolver, Stale Reaper
 *   workflow-templates/agents.mjs     — Frontend Agent, Review Agent, Custom Agent, Session Monitor
 *   workflow-templates/planning.mjs   — Task Planner, Task Replenish, Nightly Report
 *   workflow-templates/ci-cd.mjs      — Build & Deploy
 *   workflow-templates/reliability.mjs — Error Recovery, Anomaly Watchdog, Workspace Hygiene, Health Check
 *
 * To add a new template:
 *   1. Choose the appropriate category file (or create a new one)
 *   2. Import { node, edge, resetLayout } from "./_helpers.mjs"
 *   3. Define and export your template constant
 *   4. Add the export to this index file's WORKFLOW_TEMPLATES array
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

// ── Re-export helpers for external consumers ────────────────────────────────
export { node, edge, resetLayout } from "./workflow-templates/_helpers.mjs";

// ── Import templates from category modules ──────────────────────────────────

// GitHub
import {
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
} from "./workflow-templates/github.mjs";

// Agents
import {
  FRONTEND_AGENT_TEMPLATE,
  REVIEW_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
} from "./workflow-templates/agents.mjs";

// Planning
import {
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
} from "./workflow-templates/planning.mjs";

// CI/CD
import { BUILD_DEPLOY_TEMPLATE } from "./workflow-templates/ci-cd.mjs";

// Reliability
import {
  ERROR_RECOVERY_TEMPLATE,
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
} from "./workflow-templates/reliability.mjs";

// ── Re-export individual templates for direct import ────────────────────────

export {
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  FRONTEND_AGENT_TEMPLATE,
  REVIEW_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
  BUILD_DEPLOY_TEMPLATE,
  ERROR_RECOVERY_TEMPLATE,
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
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
  // ── GitHub ──
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  // ── Agents ──
  REVIEW_AGENT_TEMPLATE,
  FRONTEND_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  // ── Planning ──
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
  // ── CI/CD ──
  BUILD_DEPLOY_TEMPLATE,
  // ── Reliability ──
  ERROR_RECOVERY_TEMPLATE,
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
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
