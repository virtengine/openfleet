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

import { createHash, randomUUID } from "node:crypto";

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
  BOSUN_PR_WATCHDOG_TEMPLATE,
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
  TASK_STATUS_TRANSITION_MANAGER_TEMPLATE,
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
  BOSUN_PR_WATCHDOG_TEMPLATE,
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
  TASK_STATUS_TRANSITION_MANAGER_TEMPLATE,
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
  BOSUN_PR_WATCHDOG_TEMPLATE,
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
  TASK_STATUS_TRANSITION_MANAGER_TEMPLATE,
  INCIDENT_RESPONSE_TEMPLATE,
  // ── Security ──
  DEPENDENCY_AUDIT_TEMPLATE,
  SECRET_SCANNER_TEMPLATE,
]);

const _TEMPLATE_BY_ID = new Map(
  WORKFLOW_TEMPLATES.map((template) => [template.id, template]),
);
const TEMPLATE_STATE_VERSION = 1;

function stableNormalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = stableNormalize(value[key]);
    }
    return normalized;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableNormalize(value));
}

function hashContent(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function toWorkflowFingerprintPayload(def = {}) {
  return {
    name: def.name || "",
    description: def.description || "",
    category: def.category || "custom",
    trigger: def.trigger || "",
    variables: def.variables || {},
    nodes: def.nodes || [],
    edges: def.edges || [],
  };
}

export function computeWorkflowFingerprint(def = {}) {
  return hashContent(toWorkflowFingerprintPayload(def));
}

function cloneTemplateDefinition(template) {
  return JSON.parse(JSON.stringify(template));
}

function getTemplateVersion(templateId) {
  const template = getTemplate(templateId);
  if (!template) return null;
  return computeWorkflowFingerprint(template).slice(0, 12);
}

function deriveTemplateState(def, template) {
  const nowIso = new Date().toISOString();
  const currentFingerprint = computeWorkflowFingerprint(def);
  const templateFingerprint = computeWorkflowFingerprint(template);
  const previousState = def?.metadata?.templateState || {};

  const installedTemplateFingerprint = typeof previousState.installedTemplateFingerprint === "string"
    ? previousState.installedTemplateFingerprint
    : (currentFingerprint === templateFingerprint ? templateFingerprint : null);

  const installedFingerprint = typeof previousState.installedFingerprint === "string"
    ? previousState.installedFingerprint
    : currentFingerprint;

  const isCustomized = currentFingerprint !== installedFingerprint;
  const updateAvailable = installedTemplateFingerprint
    ? installedTemplateFingerprint !== templateFingerprint
    : false;

  return {
    stateVersion: TEMPLATE_STATE_VERSION,
    templateId: template.id,
    templateName: template.name,
    templateVersion: templateFingerprint.slice(0, 12),
    templateFingerprint,
    installedTemplateFingerprint,
    installedTemplateVersion: installedTemplateFingerprint
      ? installedTemplateFingerprint.slice(0, 12)
      : null,
    installedFingerprint,
    currentFingerprint,
    isCustomized,
    updateAvailable,
    refreshedAt: nowIso,
  };
}

export function applyWorkflowTemplateState(def = {}) {
  if (!def || typeof def !== "object") return def;
  const templateId = String(def?.metadata?.installedFrom || "").trim();
  if (!templateId) return def;
  const template = getTemplate(templateId);
  if (!template) return def;
  if (!def.metadata || typeof def.metadata !== "object") def.metadata = {};
  def.metadata.templateState = deriveTemplateState(def, template);
  return def;
}

function makeUpdatedWorkflowFromTemplate(existing, template, mode = "replace") {
  const templateClone = cloneTemplateDefinition(template);
  const nowIso = new Date().toISOString();
  const mergedVariables = {
    ...(templateClone.variables || {}),
    ...(existing.variables || {}),
  };
  const next = {
    ...templateClone,
    id: mode === "copy" ? randomUUID() : existing.id,
    name: mode === "copy" ? `${existing.name} (Updated)` : existing.name,
    enabled: existing.enabled !== false,
    variables: mergedVariables,
    metadata: {
      ...(existing.metadata || {}),
      ...(templateClone.metadata || {}),
      installedFrom: template.id,
      templateUpdatedAt: nowIso,
    },
  };
  delete next.metadata.templateState;
  if (mode === "copy") {
    next.metadata.createdAt = nowIso;
    next.metadata.updatedAt = nowIso;
  }
  return applyWorkflowTemplateState(next);
}

export function updateWorkflowFromTemplate(engine, workflowId, opts = {}) {
  const mode = String(opts.mode || "replace").toLowerCase();
  if (!["replace", "copy"].includes(mode)) {
    throw new Error(`Unsupported template update mode "${mode}"`);
  }
  const existing = engine.get(workflowId);
  if (!existing) throw new Error(`Workflow "${workflowId}" not found`);
  const templateId = String(existing?.metadata?.installedFrom || "").trim();
  if (!templateId) throw new Error(`Workflow "${workflowId}" is not template-backed`);
  const template = getTemplate(templateId);
  if (!template) throw new Error(`Template "${templateId}" not found`);

  const hydrated = applyWorkflowTemplateState(existing);
  if (mode === "replace" && hydrated?.metadata?.templateState?.isCustomized && opts.force !== true) {
    throw new Error("Workflow has custom changes; pass force=true to replace it");
  }

  const next = makeUpdatedWorkflowFromTemplate(hydrated, template, mode);
  return engine.save(next);
}

export function reconcileInstalledTemplates(engine, opts = {}) {
  const autoUpdateUnmodified = opts.autoUpdateUnmodified !== false;
  const workflows = engine.list();
  const result = {
    scanned: 0,
    metadataUpdated: 0,
    autoUpdated: 0,
    updateAvailable: [],
    customized: [],
    updatedWorkflowIds: [],
    errors: [],
  };

  for (const summary of workflows) {
    const wfId = summary?.id;
    if (!wfId) continue;
    const def = engine.get(wfId);
    if (!def?.metadata?.installedFrom) continue;
    result.scanned += 1;

    try {
      const before = stableStringify(def.metadata?.templateState || null);
      applyWorkflowTemplateState(def);
      const state = def.metadata?.templateState || null;
      const after = stableStringify(state);
      if (before !== after) {
        engine.save(def);
        result.metadataUpdated += 1;
      }

      if (!state) continue;
      if (state.isCustomized) {
        result.customized.push({
          workflowId: def.id,
          name: def.name,
          templateId: state.templateId,
          updateAvailable: state.updateAvailable === true,
        });
      }
      if (state.updateAvailable === true) {
        result.updateAvailable.push({
          workflowId: def.id,
          name: def.name,
          templateId: state.templateId,
          isCustomized: state.isCustomized === true,
        });
      }

      if (autoUpdateUnmodified && state.updateAvailable === true && state.isCustomized !== true) {
        const saved = updateWorkflowFromTemplate(engine, def.id, { mode: "replace", force: true });
        result.autoUpdated += 1;
        result.updatedWorkflowIds.push(saved.id);
      }
    } catch (err) {
      result.errors.push({
        workflowId: wfId,
        error: err.message,
      });
    }
  }

  return result;
}

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
      "template-task-status-transition-manager",
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
      "template-task-status-transition-manager",
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
      "template-bosun-pr-watchdog",
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
      "template-task-status-transition-manager",
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
    const fingerprint = computeWorkflowFingerprint(t);
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
      version: fingerprint.slice(0, 12),
      fingerprint,
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
  const def = cloneTemplateDefinition(template);
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

  applyWorkflowTemplateState(def);
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
