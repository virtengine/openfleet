/**
 * workflow-templates.mjs — Pre-built Workflow Templates for Bosun
 *
 * Ready-to-use workflow definitions that users can install with one click
 * from the visual builder. Each template encodes a complete flow that
 * previously required custom code or env-var configuration.
 *
 * Templates are split into category modules for easy extension:
 *   workflow-templates/github.mjs     — PR Merge Strategy, Triage, Conflict Resolver, Stale Reaper, Release Drafter, SDK Conflict Resolver
 *   workflow-templates/agents.mjs     — Frontend Agent, Review Agent, Custom Agent, Session Monitor, Backend Agent, Meeting Orchestrator + Subworkflow Chain
 *   workflow-templates/planning.mjs   — Task Planner, Task Replenish, Nightly Report, Sprint Retrospective, Weekly Fitness Summary
 *   workflow-templates/ci-cd.mjs      — Build & Deploy, Release Pipeline, Canary Deploy
 *   workflow-templates/reliability.mjs — Error Recovery, Anomaly Watchdog, Workspace Hygiene, Health Check, Task Finalization Guard, Task Repair Worktree, Task Orphan Worktree Recovery, Incident Response, Task Archiver, Sync Engine
 *   workflow-templates/security.mjs   — Dependency Audit, Secret Scanner
 *   workflow-templates/code-quality.mjs — Code Quality Striker
 *
 * To add a new template:
 *   1. Choose the appropriate category file (or create a new one)
 *   2. Import { node, edge, resetLayout } from "../_helpers.mjs"
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
import { detectProjectStack, getCommandPresets } from "./project-detection.mjs";

// ── Re-export helpers for external consumers ────────────────────────────────
export { node, edge, resetLayout } from "../workflow-templates/_helpers.mjs";

// ── Import templates from category modules ──────────────────────────────────

// GitHub
import {
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  RELEASE_DRAFTER_TEMPLATE,
  BOSUN_PR_WATCHDOG_TEMPLATE,
  GITHUB_KANBAN_SYNC_TEMPLATE,
  SDK_CONFLICT_RESOLVER_TEMPLATE,
} from "../workflow-templates/github.mjs";

// Agents
import {
  FRONTEND_AGENT_TEMPLATE,
  REVIEW_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  BACKEND_AGENT_TEMPLATE,
  VOICE_VIDEO_PARALLEL_ROLLOUT_TEMPLATE,
  MEETING_SUBWORKFLOW_CHAIN_TEMPLATE,
} from "../workflow-templates/agents.mjs";

// Planning
import {
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
  SPRINT_RETROSPECTIVE_TEMPLATE,
  WEEKLY_FITNESS_SUMMARY_TEMPLATE,
} from "../workflow-templates/planning.mjs";

// CI/CD
import {
  BUILD_DEPLOY_TEMPLATE,
  RELEASE_PIPELINE_TEMPLATE,
  CANARY_DEPLOY_TEMPLATE,
} from "../workflow-templates/ci-cd.mjs";

// Reliability
import {
  ERROR_RECOVERY_TEMPLATE,
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
  TASK_FINALIZATION_GUARD_TEMPLATE,
  TASK_REPAIR_WORKTREE_TEMPLATE,
  TASK_ORPHAN_WORKTREE_RECOVERY_TEMPLATE,
  TASK_STATUS_TRANSITION_MANAGER_TEMPLATE,
  INCIDENT_RESPONSE_TEMPLATE,
  TASK_ARCHIVER_TEMPLATE,
  SYNC_ENGINE_TEMPLATE,
} from "../workflow-templates/reliability.mjs";

// Security
import {
  DEPENDENCY_AUDIT_TEMPLATE,
  SECRET_SCANNER_TEMPLATE,
} from "../workflow-templates/security.mjs";

// Code Quality (structural refactor, agentic maintenance)
import {
  CODE_QUALITY_STRIKER_TEMPLATE,
} from "../workflow-templates/code-quality.mjs";

// Task Execution (task-type-specific workflows)
import {
  FULLSTACK_TASK_TEMPLATE,
  BACKEND_TASK_TEMPLATE,
  FRONTEND_TASK_TEMPLATE,
  DEBUG_TASK_TEMPLATE,
  CICD_TASK_TEMPLATE,
  DESIGN_TASK_TEMPLATE,
} from "../workflow-templates/task-execution.mjs";

// Task Lifecycle (workflow-first core)
import {
  TASK_LIFECYCLE_TEMPLATE,
  VE_ORCHESTRATOR_LITE_TEMPLATE,
} from "../workflow-templates/task-lifecycle.mjs";

// Task Batch (parallel dispatch)
import {
  TASK_BATCH_PROCESSOR_TEMPLATE,
  TASK_BATCH_PR_TEMPLATE,
} from "../workflow-templates/task-batch.mjs";

// Research (iterative verification loops)
import {
  RESEARCH_AGENT_TEMPLATE,
} from "../workflow-templates/research.mjs";

// Coverage (node-type coverage templates)
import {
  WEBHOOK_TASK_ROUTER_TEMPLATE,
  SCHEDULED_MAINTENANCE_TEMPLATE,
  MCP_RESEARCH_PROBE_TEMPLATE,
  AGENT_EXECUTION_PIPELINE_TEMPLATE,
  FLOW_CONTROL_SUITE_TEMPLATE,
} from "../workflow-templates/coverage.mjs";

// MCP Integration (MCP tool → workflow data piping)
import {
  MCP_TOOL_CHAIN_TEMPLATE,
  MCP_GITHUB_PR_MONITOR_TEMPLATE,
  MCP_CROSS_SERVER_PIPELINE_TEMPLATE,
  MCP_ITERATIVE_RESEARCH_TEMPLATE,
} from "../workflow-templates/mcp-integration.mjs";

// Bosun Native (built-in tools, sub-workflows, internal functions)
import {
  BOSUN_TOOL_PIPELINE_TEMPLATE,
  WORKFLOW_COMPOSITION_TEMPLATE,
  MCP_TO_BOSUN_BRIDGE_TEMPLATE,
  GIT_HEALTH_PIPELINE_TEMPLATE,
} from "../workflow-templates/bosun-native.mjs";

// ── Re-export individual templates for direct import ────────────────────────

export {
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  RELEASE_DRAFTER_TEMPLATE,
  BOSUN_PR_WATCHDOG_TEMPLATE,
  GITHUB_KANBAN_SYNC_TEMPLATE,
  SDK_CONFLICT_RESOLVER_TEMPLATE,
  FRONTEND_AGENT_TEMPLATE,
  REVIEW_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  BACKEND_AGENT_TEMPLATE,
  VOICE_VIDEO_PARALLEL_ROLLOUT_TEMPLATE,
  MEETING_SUBWORKFLOW_CHAIN_TEMPLATE,
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
  SPRINT_RETROSPECTIVE_TEMPLATE,
  WEEKLY_FITNESS_SUMMARY_TEMPLATE,
  BUILD_DEPLOY_TEMPLATE,
  RELEASE_PIPELINE_TEMPLATE,
  CANARY_DEPLOY_TEMPLATE,
  ERROR_RECOVERY_TEMPLATE,
  ANOMALY_WATCHDOG_TEMPLATE,
  WORKSPACE_HYGIENE_TEMPLATE,
  HEALTH_CHECK_TEMPLATE,
  TASK_FINALIZATION_GUARD_TEMPLATE,
  TASK_REPAIR_WORKTREE_TEMPLATE,
  TASK_ORPHAN_WORKTREE_RECOVERY_TEMPLATE,
  TASK_STATUS_TRANSITION_MANAGER_TEMPLATE,
  INCIDENT_RESPONSE_TEMPLATE,
  TASK_ARCHIVER_TEMPLATE,
  SYNC_ENGINE_TEMPLATE,
  DEPENDENCY_AUDIT_TEMPLATE,
  SECRET_SCANNER_TEMPLATE,
  CODE_QUALITY_STRIKER_TEMPLATE,
  FULLSTACK_TASK_TEMPLATE,
  BACKEND_TASK_TEMPLATE,
  FRONTEND_TASK_TEMPLATE,
  DEBUG_TASK_TEMPLATE,
  CICD_TASK_TEMPLATE,
  DESIGN_TASK_TEMPLATE,
  TASK_LIFECYCLE_TEMPLATE,
  VE_ORCHESTRATOR_LITE_TEMPLATE,
  TASK_BATCH_PROCESSOR_TEMPLATE,
  TASK_BATCH_PR_TEMPLATE,
  RESEARCH_AGENT_TEMPLATE,
  WEBHOOK_TASK_ROUTER_TEMPLATE,
  SCHEDULED_MAINTENANCE_TEMPLATE,
  MCP_RESEARCH_PROBE_TEMPLATE,
  AGENT_EXECUTION_PIPELINE_TEMPLATE,
  FLOW_CONTROL_SUITE_TEMPLATE,
  MCP_TOOL_CHAIN_TEMPLATE,
  MCP_GITHUB_PR_MONITOR_TEMPLATE,
  MCP_CROSS_SERVER_PIPELINE_TEMPLATE,
  MCP_ITERATIVE_RESEARCH_TEMPLATE,
  BOSUN_TOOL_PIPELINE_TEMPLATE,
  WORKFLOW_COMPOSITION_TEMPLATE,
  MCP_TO_BOSUN_BRIDGE_TEMPLATE,
  GIT_HEALTH_PIPELINE_TEMPLATE,
};

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

/** Category metadata for UI grouping. */
export const TEMPLATE_CATEGORIES = Object.freeze({
  "task-execution": { label: "Task Execution", icon: ":play:", order: 1 },
  github:      { label: "GitHub",       icon: ":git:", order: 2 },
  agents:      { label: "Agents",       icon: ":bot:", order: 3 },
  planning:    { label: "Planning",     icon: ":clipboard:", order: 4 },
  "ci-cd":     { label: "CI / CD",      icon: ":refresh:", order: 5 },
  reliability: { label: "Reliability",  icon: ":shield:", order: 6 },
  security:    { label: "Security",     icon: ":lock:", order: 7 },
  lifecycle:   { label: "Lifecycle",    icon: ":rocket:", order: 8 },
  research:    { label: "Research",     icon: ":microscope:", order: 9 },
  coverage:    { label: "Coverage",     icon: ":chart:", order: 10 },
  "mcp-integration": { label: "MCP Integration", icon: ":plug:", order: 11 },
  maintenance: { label: "Maintenance",   icon: ":wrench:",   order: 12 },
  custom:      { label: "Custom",       icon: ":settings:", order: 13 },
});

export const WORKFLOW_TEMPLATES = Object.freeze([
  // ── GitHub ──
  PR_MERGE_STRATEGY_TEMPLATE,
  PR_TRIAGE_TEMPLATE,
  PR_CONFLICT_RESOLVER_TEMPLATE,
  STALE_PR_REAPER_TEMPLATE,
  RELEASE_DRAFTER_TEMPLATE,
  BOSUN_PR_WATCHDOG_TEMPLATE,
  GITHUB_KANBAN_SYNC_TEMPLATE,
  SDK_CONFLICT_RESOLVER_TEMPLATE,
  // ── Agents ──
  REVIEW_AGENT_TEMPLATE,
  FRONTEND_AGENT_TEMPLATE,
  CUSTOM_AGENT_TEMPLATE,
  AGENT_SESSION_MONITOR_TEMPLATE,
  BACKEND_AGENT_TEMPLATE,
  VOICE_VIDEO_PARALLEL_ROLLOUT_TEMPLATE,
  MEETING_SUBWORKFLOW_CHAIN_TEMPLATE,
  // ── Planning ──
  TASK_PLANNER_TEMPLATE,
  TASK_REPLENISH_TEMPLATE,
  NIGHTLY_REPORT_TEMPLATE,
  SPRINT_RETROSPECTIVE_TEMPLATE,
  WEEKLY_FITNESS_SUMMARY_TEMPLATE,
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
  TASK_ORPHAN_WORKTREE_RECOVERY_TEMPLATE,
  TASK_STATUS_TRANSITION_MANAGER_TEMPLATE,
  INCIDENT_RESPONSE_TEMPLATE,
  TASK_ARCHIVER_TEMPLATE,
  SYNC_ENGINE_TEMPLATE,
  // ── Security ──
  DEPENDENCY_AUDIT_TEMPLATE,
  SECRET_SCANNER_TEMPLATE,
  // ── Maintenance (structural quality, agentic dev) ──
  CODE_QUALITY_STRIKER_TEMPLATE,
  // ── Task Execution (task-type workflows + core lifecycle) ──
  FULLSTACK_TASK_TEMPLATE,
  BACKEND_TASK_TEMPLATE,
  FRONTEND_TASK_TEMPLATE,
  DEBUG_TASK_TEMPLATE,
  CICD_TASK_TEMPLATE,
  DESIGN_TASK_TEMPLATE,
  // ── Task Lifecycle (workflow-first core) ──
  TASK_LIFECYCLE_TEMPLATE,
  VE_ORCHESTRATOR_LITE_TEMPLATE,
  // ── Task Batch (parallel dispatch) ──
  TASK_BATCH_PROCESSOR_TEMPLATE,
  TASK_BATCH_PR_TEMPLATE,
  // ── Research (iterative verification loops) ──
  RESEARCH_AGENT_TEMPLATE,
  // ── Coverage (node-type coverage) ──
  WEBHOOK_TASK_ROUTER_TEMPLATE,
  SCHEDULED_MAINTENANCE_TEMPLATE,
  MCP_RESEARCH_PROBE_TEMPLATE,
  AGENT_EXECUTION_PIPELINE_TEMPLATE,
  FLOW_CONTROL_SUITE_TEMPLATE,
  // ── MCP Integration (MCP tool → workflow data piping) ──
  MCP_TOOL_CHAIN_TEMPLATE,
  MCP_GITHUB_PR_MONITOR_TEMPLATE,
  MCP_CROSS_SERVER_PIPELINE_TEMPLATE,
  MCP_ITERATIVE_RESEARCH_TEMPLATE,
  // ── Bosun Native (tools, sub-workflows, functions) ──
  BOSUN_TOOL_PIPELINE_TEMPLATE,
  WORKFLOW_COMPOSITION_TEMPLATE,
  MCP_TO_BOSUN_BRIDGE_TEMPLATE,
  GIT_HEALTH_PIPELINE_TEMPLATE,
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
  const forceUpdateTemplateIds = new Set(
    (Array.isArray(opts.forceUpdateTemplateIds)
      ? opts.forceUpdateTemplateIds
      : [opts.forceUpdateTemplateIds])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  const workflows = engine.list();
  const result = {
    scanned: 0,
    metadataUpdated: 0,
    autoUpdated: 0,
    forceUpdated: [],
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
      const previousState = def.metadata?.templateState || null;
      const before = stableStringify(previousState);
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

      const shouldForceUpdate =
        state.updateAvailable === true &&
        forceUpdateTemplateIds.has(String(state.templateId || "").trim());
      if (shouldForceUpdate) {
        const saved = updateWorkflowFromTemplate(engine, def.id, { mode: "replace", force: true });
        result.autoUpdated += 1;
        result.updatedWorkflowIds.push(saved.id);
        result.forceUpdated.push(saved.id);
        continue;
      }

      const wasCustomized = previousState?.isCustomized === true;
      if (autoUpdateUnmodified && state.updateAvailable === true && !wasCustomized) {
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
      "template-task-archiver",
      "template-sync-engine",
      "template-sdk-conflict-resolver",
      "template-task-batch-processor",
    ]),
  }),
  workflowfirst: Object.freeze({
    id: "workflowFirst",
    name: "Workflow-First (Full)",
    description:
      "Everything runs as a workflow — including the core task execution " +
      "lifecycle. Bosun becomes a thin shell around the workflow engine. " +
      "Enables workflowOwnsTaskLifecycle for complete workflow-driven control.",
    recommendedFor:
      "Teams ready for full workflow-first operation where every " +
      "bosun behavior is a composable, visual workflow.",
    workflowAutomationEnabled: true,
    workflowFirst: true,
    templateIds: Object.freeze([
      // Core lifecycle
      "template-task-lifecycle",
      // GitHub
      "template-pr-merge-strategy",
      "template-bosun-pr-watchdog",
      "template-github-kanban-sync",
      "template-stale-pr-reaper",
      "template-sdk-conflict-resolver",
      // Agents
      "template-review-agent",
      "template-backend-agent",
      "template-agent-session-monitor",
      // Planning
      "template-task-planner",
      "template-task-replenish",
      // Reliability
      "template-error-recovery",
      "template-anomaly-watchdog",
      "template-workspace-hygiene",
      "template-task-finalization-guard",
      "template-task-repair-worktree",
      "template-task-status-transition-manager",
      "template-incident-response",
      "template-task-archiver",
      "template-sync-engine",
      // CI/CD
      "template-release-pipeline",
      // Security
      "template-dependency-audit",
      // Batch dispatch
      "template-task-batch-processor",
      "template-task-batch-pr",
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

const WORKFLOW_TYPE_TEMPLATE_MAP = Object.freeze({
  "continuation-loop": "template-continuation-loop",
});

const WORKFLOW_CONFIG_RESERVED_KEYS = new Set([
  "type",
  "templateId",
  "enabled",
  "name",
  "options",
]);

function normalizeWorkflowConfigEntries(rawEntries = []) {
  const source = Array.isArray(rawEntries) ? rawEntries : [];
  const normalized = [];
  for (const raw of source) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const type = String(raw.type || "").trim().toLowerCase();
    if (!type) continue;
    const templateId = WORKFLOW_TYPE_TEMPLATE_MAP[type];
    if (!templateId || !_TEMPLATE_BY_ID.has(templateId)) continue;
    const enabled = raw.enabled !== false;
    const entry = { ...raw, type, templateId, enabled };
    normalized.push(entry);
  }
  return normalized;
}

function toTemplateOverridesFromWorkflowEntry(entry = {}) {
  const template = getTemplate(entry.templateId);
  if (!template) return {};
  const templateVars = template.variables && typeof template.variables === "object"
    ? template.variables
    : {};
  const picks = {};
  for (const [key, value] of Object.entries(entry)) {
    if (WORKFLOW_CONFIG_RESERVED_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(templateVars, key)) continue;
    picks[key] = coerceTemplateVariableValue(value, templateVars[key]);
  }
  if (entry.options && typeof entry.options === "object" && !Array.isArray(entry.options)) {
    for (const [key, value] of Object.entries(entry.options)) {
      if (!Object.prototype.hasOwnProperty.call(templateVars, key)) continue;
      picks[key] = coerceTemplateVariableValue(value, templateVars[key]);
    }
  }
  return picks;
}

export function resolveWorkflowTemplateConfig(rawEntries = []) {
  const entries = normalizeWorkflowConfigEntries(rawEntries);
  const templateIds = [];
  const overridesById = {};
  for (const entry of entries) {
    if (entry.enabled !== true) continue;
    if (!templateIds.includes(entry.templateId)) templateIds.push(entry.templateId);
    const overrides = toTemplateOverridesFromWorkflowEntry(entry);
    if (Object.keys(overrides).length > 0) {
      overridesById[entry.templateId] = {
        ...(overridesById[entry.templateId] || {}),
        ...overrides,
      };
    }
  }
  return { templateIds, overridesById };
}
/**
 * Get a template by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getTemplate(id) {
  return _TEMPLATE_BY_ID.get(id) || null;
}

// ── Grouped Flows ──────────────────────────────────────────────────────────
// Templates that use action.execute_workflow to chain into other templates
// declare metadata.requiredTemplates. When one template in a group is
// installed or enabled, all members of the group must be installed/enabled
// together so that the chain doesn't break at runtime.

/**
 * Resolve the full dependency group for a template.
 * Walks `metadata.requiredTemplates` transitively to collect every template
 * that must be co-installed.
 * @param {string} templateId
 * @returns {{ root: string, members: string[] } | null}
 */
export function getTemplateGroup(templateId) {
  const root = getTemplate(templateId);
  if (!root) return null;

  const members = new Set([templateId]);
  const queue = [...(root.metadata?.requiredTemplates || [])];
  while (queue.length > 0) {
    const depId = queue.shift();
    if (members.has(depId)) continue;
    const dep = getTemplate(depId);
    if (!dep) continue;
    members.add(depId);
    const nested = dep.metadata?.requiredTemplates || [];
    for (const n of nested) {
      if (!members.has(n)) queue.push(n);
    }
  }

  return { root: templateId, members: [...members] };
}

/**
 * Expand a list of template IDs to include all required group members.
 * @param {string[]} templateIds
 * @returns {string[]} Expanded list with dependencies (no duplicates, order preserved)
 */
export function expandTemplateGroups(templateIds) {
  const seen = new Set();
  const expanded = [];
  for (const id of templateIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    expanded.push(id);
    const group = getTemplateGroup(id);
    if (!group) continue;
    for (const memberId of group.members) {
      if (!seen.has(memberId)) {
        seen.add(memberId);
        expanded.push(memberId);
      }
    }
  }
  return expanded;
}

/**
 * List all available templates with metadata.
 * @returns {Array<{id, name, description, category, tags, replaces?}>}
 */
/**
 * Classify a variable key into a command category if it matches.
 * Returns "test" | "build" | "lint" | "syntaxCheck" | null.
 */
function classifyCommandVariable(key) {
  const k = String(key || "").toLowerCase();
  if (k.includes("testcommand") || k.includes("test_command") || k === "testframework" || k === "test_framework") return "test";
  if (k.includes("buildcommand") || k.includes("build_command")) return "build";
  if (k.includes("lintcommand") || k.includes("lint_command") || k.includes("lintcmd")) return "lint";
  if (k.includes("syntaxcheck") || k.includes("syntax_check") || k.includes("typecheckcommand") || k.includes("type_check")) return "syntaxCheck";
  return null;
}

let _cachedDetection = null;
let _cachedDetectionRoot = null;

function getCachedDetection(rootDir) {
  if (!rootDir) return null;
  if (_cachedDetectionRoot === rootDir && _cachedDetection) return _cachedDetection;
  try {
    _cachedDetection = detectProjectStack(rootDir);
    _cachedDetectionRoot = rootDir;
  } catch { _cachedDetection = null; }
  return _cachedDetection;
}

function inferVariableInputAndOptions(key, defaultValue, rootDir) {
  const normalized = String(key || "").trim().toLowerCase();
  if (typeof defaultValue === "boolean") return { input: "toggle", options: [] };
  if (typeof defaultValue === "number") return { input: "number", options: [] };
  if (Array.isArray(defaultValue) || (defaultValue && typeof defaultValue === "object")) {
    return { input: "json", options: [] };
  }

  const optionValues = [];

  // Command-type variables get auto-detected + multi-language presets
  const cmdCategory = classifyCommandVariable(normalized);
  if (cmdCategory) {
    const detected = rootDir ? getCachedDetection(rootDir) : null;
    const presets = getCommandPresets(detected);
    const presetList = presets[cmdCategory] || [];

    if (presetList.length > 0) {
      // Put current default first if not already in presets
      const existingValues = new Set(presetList.map(p => p.value));
      if (typeof defaultValue === "string" && defaultValue.trim() && !existingValues.has(defaultValue.trim())) {
        optionValues.push(defaultValue.trim());
      }
      for (const p of presetList) {
        optionValues.push(p.value);
      }
    }
  } else if (normalized.includes("executor") || normalized.includes("sdk")) {
    optionValues.push("auto", "codex", "claude", "copilot");
  } else if (normalized.includes("bumptype") || normalized.includes("bump_type")) {
    optionValues.push("patch", "minor", "major");
  } else if (normalized === "basebranch" || normalized === "base_branch" || normalized === "defaultbasebranch" || normalized === "targetbranch" || normalized === "default_target_branch") {
    optionValues.push("main", "master", "develop", "staging");
  }

  if (typeof defaultValue === "string" && defaultValue.trim()) {
    optionValues.unshift(defaultValue.trim());
  }

  const deduped = [];
  for (const value of optionValues) {
    if (!value) continue;
    if (!deduped.includes(value)) deduped.push(value);
  }
  if (deduped.length > 0) {
    return {
      input: "select",
      options: deduped.map((value) => ({ value, label: value })),
    };
  }

  return { input: "text", options: [] };
}

function inferVariableDescription(key, defaultValue) {
  const normalized = String(key || "").trim().toLowerCase();
  if (normalized.includes("taskid") || normalized.includes("task_id")) return "Task identifier (for example TASK-123).";
  if (normalized.includes("prompt") || normalized.includes("problem") || normalized.includes("description")) return "Free-form instruction text.";
  if (normalized === "basebranch" || normalized === "base_branch" || normalized === "defaultbasebranch") return "Base branch for PRs (e.g. main, master, develop). Select from common options or type a custom branch.";
  if (normalized.includes("branch")) return "Git branch name.";
  if (normalized.includes("timeout") || normalized.includes("delay") || normalized.includes("cooldown")) return "Duration in milliseconds.";
  if (normalized.includes("executor") || normalized.includes("sdk")) return "Executor profile used by agent nodes.";
  if (normalized.includes("model")) return "Model id used by agent nodes.";
  if (classifyCommandVariable(normalized) === "test") return "Test command for your project. Auto-detected from project files when available.";
  if (classifyCommandVariable(normalized) === "build") return "Build command for your project. Auto-detected from project files when available.";
  if (classifyCommandVariable(normalized) === "lint") return "Lint/style check command. Auto-detected from project files when available.";
  if (classifyCommandVariable(normalized) === "syntaxCheck") return "Syntax/compile check command. Auto-detected from project files when available.";
  if (typeof defaultValue === "boolean") return "Toggle this setting on or off.";
  if (typeof defaultValue === "number") return "Numeric workflow setting.";
  return "";
}

const TEMPLATE_CAPABILITY_NODE_TYPES = Object.freeze({
  branch: Object.freeze(["flow.branch"]),
  join: Object.freeze(["flow.join"]),
  gate: Object.freeze(["flow.gate"]),
  universal: Object.freeze(["flow.universal", "flow.universial"]),
  end: Object.freeze(["flow.end"]),
});

function collectTemplateCapabilities(template) {
  const counts = {
    branch: 0,
    join: 0,
    gate: 0,
    universal: 0,
    end: 0,
  };

  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  for (const node of nodes) {
    const nodeType = String(node?.type || "").trim().toLowerCase();
    if (!nodeType) continue;
    for (const [capability, types] of Object.entries(TEMPLATE_CAPABILITY_NODE_TYPES)) {
      if (types.includes(nodeType)) counts[capability] += 1;
    }
  }

  return {
    capabilities: {
      branch: counts.branch > 0,
      join: counts.join > 0,
      gate: counts.gate > 0,
      universal: counts.universal > 0,
      end: counts.end > 0,
    },
    capabilityCounts: counts,
  };
}

export function listTemplates(rootDir) {
  return WORKFLOW_TEMPLATES.map((t) => {
    const cat = TEMPLATE_CATEGORIES[t.category] || TEMPLATE_CATEGORIES.custom;
    const fingerprint = computeWorkflowFingerprint(t);
    const capabilitySummary = collectTemplateCapabilities(t);
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
      trigger: t.trigger || null,
      capabilities: capabilitySummary.capabilities,
      capabilityCounts: capabilitySummary.capabilityCounts,
      variables: t.variables && typeof t.variables === "object"
        ? Object.entries(t.variables).map(([key, defaultValue]) => {
            const required = defaultValue === "" || defaultValue == null;
            const inferred = inferVariableInputAndOptions(key, defaultValue, rootDir);
            return {
              key,
              defaultValue,
              required,
              type: typeof defaultValue === "number"  ? "number"
                  : typeof defaultValue === "boolean" ? "toggle"
                  : "text",
              input: inferred.input,
              options: inferred.options,
              description: inferVariableDescription(key, defaultValue),
            };
          })
        : [],
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

function coerceTemplateVariableValue(rawValue, defaultValue) {
  if (typeof defaultValue === "number") {
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }
  if (typeof defaultValue === "boolean") {
    if (typeof rawValue === "boolean") return rawValue;
    const normalized = String(rawValue || "").trim().toLowerCase();
    if (["1", "true", "yes", "on", "y"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "n"].includes(normalized)) return false;
    return defaultValue;
  }
  if (Array.isArray(defaultValue) || (defaultValue && typeof defaultValue === "object")) {
    if (typeof rawValue === "string") {
      try {
        return JSON.parse(rawValue);
      } catch {
        return defaultValue;
      }
    }
    return rawValue && typeof rawValue === "object" ? rawValue : defaultValue;
  }
  if (rawValue === undefined || rawValue === null) return defaultValue;
  return String(rawValue);
}

export function normalizeTemplateOverridesById(rawOverrides = {}, allowedTemplateIds = null) {
  const input = rawOverrides && typeof rawOverrides === "object" ? rawOverrides : {};
  const allowed = Array.isArray(allowedTemplateIds)
    ? new Set(allowedTemplateIds.map((value) => String(value || "").trim()).filter(Boolean))
    : null;
  const normalized = {};

  for (const [templateId, overrides] of Object.entries(input)) {
    const id = String(templateId || "").trim();
    if (!id) continue;
    if (allowed && !allowed.has(id)) continue;
    const template = getTemplate(id);
    if (!template) continue;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) continue;

    const templateVars = template.variables && typeof template.variables === "object"
      ? template.variables
      : {};
    const nextOverrides = {};
    for (const [key, rawValue] of Object.entries(overrides)) {
      if (!Object.prototype.hasOwnProperty.call(templateVars, key)) continue;
      nextOverrides[key] = coerceTemplateVariableValue(rawValue, templateVars[key]);
    }
    if (Object.keys(nextOverrides).length > 0) {
      normalized[id] = nextOverrides;
    }
  }

  return normalized;
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
  const saved = engine.save(def);

  // ── Grouped flows: auto-install required sibling templates ────────────
  const requiredIds = template.metadata?.requiredTemplates || [];
  for (const depId of requiredIds) {
    const depTemplate = getTemplate(depId);
    if (!depTemplate) continue;
    const depExists = engine.list().some(
      (wf) => wf.metadata?.installedFrom === depId || wf.name === depTemplate.name,
    );
    if (depExists) continue;
    try {
      installTemplate(depId, engine, overrides);
    } catch {
      /* best-effort — dedup check may fire if installed concurrently */
    }
  }

  return saved;
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
  // Expand grouped flows so required siblings are always included
  const expanded = expandTemplateGroups(requested);

  const existing = engine.list();
  const installedLookup = new Set(
    existing.flatMap((wf) => [wf.metadata?.installedFrom, wf.name]).filter(Boolean),
  );
  const results = { installed: [], skipped: [], errors: [] };

  for (const templateId of expanded) {
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
      // Auto-install may have added sibling templates; refresh the lookup
      // so they are correctly skipped rather than triggering errors.
      for (const existing of engine.list()) {
        if (existing.metadata?.installedFrom) installedLookup.add(existing.metadata.installedFrom);
        if (existing.name) installedLookup.add(existing.name);
      }
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
