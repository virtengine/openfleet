/**
 * workflow-migration.mjs — Migration Guard & Shadow Mode for Workflow Templates
 *
 * Solves the dual-execution problem: when a workflow template replaces an
 * existing module (anomaly-detector.mjs, maintenance.mjs, etc.), this guard
 * ensures that the old module is disabled when the workflow is active, and
 * vice versa. Supports three migration modes:
 *
 *   1. LEGACY   — Old module runs, workflow disabled (default until enabled)
 *   2. SHADOW   — Both run, but the workflow only logs (dry-run) — for validation
 *   3. WORKFLOW — Workflow runs, old module disabled — the migration target
 *
 * Usage:
 *   import { MigrationGuard } from "./workflow-migration.mjs";
 *
 *   const guard = new MigrationGuard({ engine, configPath });
 *   guard.load();
 *
 *   // In monitor.mjs, before starting a legacy module:
 *   if (guard.shouldRunLegacy("maintenance.mjs")) {
 *     runMaintenanceSweep({ ... });
 *   }
 *
 *   // The workflow engine checks guard.shouldRunWorkflow() automatically
 *   // via the evaluateTriggers hook.
 *
 * EXPORTS:
 *   MigrationGuard     — Main class
 *   MigrationMode      — Enum: LEGACY, SHADOW, WORKFLOW
 *   getMigrationGuard() — Singleton accessor
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TAG = "[workflow-migration]";

// ── Migration Modes ─────────────────────────────────────────────────────────

export const MigrationMode = Object.freeze({
  /** Old module runs, workflow is disabled. Default safe state. */
  LEGACY: "legacy",

  /** Both run — workflow in dry-run/shadow mode (logs what it WOULD do).
   *  Use this to validate that the workflow produces the same decisions
   *  as the legacy module before cutting over. */
  SHADOW: "shadow",

  /** Workflow runs, old module is disabled. The migration target. */
  WORKFLOW: "workflow",
});

// ── Migration Guard ─────────────────────────────────────────────────────────

export class MigrationGuard {
  /**
   * @param {object} opts
   * @param {import('./workflow-engine.mjs').WorkflowEngine} [opts.engine]
   * @param {string} [opts.configPath] - Path to migration state file
   */
  constructor(opts = {}) {
    this.engine = opts.engine || null;
    this.configPath = opts.configPath || resolve(
      process.env.BOSUN_DIR || ".bosun",
      "workflow-migration.json"
    );

    /** @type {Map<string, {mode: string, workflowId?: string, enabledAt?: string, shadowLog: Array}>} */
    this._state = new Map();
    this._loaded = false;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  load() {
    if (this._loaded) return this;
    try {
      if (existsSync(this.configPath)) {
        const raw = JSON.parse(readFileSync(this.configPath, "utf8"));
        for (const [mod, entry] of Object.entries(raw.modules || {})) {
          this._state.set(mod, {
            mode: entry.mode || MigrationMode.LEGACY,
            workflowId: entry.workflowId || null,
            templateId: entry.templateId || null,
            enabledAt: entry.enabledAt || null,
            shadowLog: entry.shadowLog || [],
            lastValidated: entry.lastValidated || null,
            validationPassed: entry.validationPassed ?? null,
          });
        }
      }
    } catch (err) {
      console.warn(`${TAG} Failed to load migration state: ${err.message}`);
    }
    this._loaded = true;
    return this;
  }

  save() {
    try {
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const obj = { modules: {} };
      for (const [mod, entry] of this._state) {
        obj.modules[mod] = { ...entry };
      }
      writeFileSync(this.configPath, JSON.stringify(obj, null, 2), "utf8");
    } catch (err) {
      console.warn(`${TAG} Failed to save migration state: ${err.message}`);
    }
  }

  // ── Query API ─────────────────────────────────────────────────────────

  /**
   * Should the legacy (old) module run?
   * Returns TRUE in LEGACY mode and SHADOW mode.
   * Returns FALSE only in WORKFLOW mode (the workflow has taken over).
   * @param {string} moduleName - e.g. "maintenance.mjs"
   */
  shouldRunLegacy(moduleName) {
    if (!this._loaded) this.load();
    const entry = this._state.get(moduleName);
    if (!entry) return true; // No migration configured — legacy runs by default
    return entry.mode !== MigrationMode.WORKFLOW;
  }

  /**
   * Should the workflow run in full (non-dry-run) mode?
   * Returns TRUE only in WORKFLOW mode.
   * @param {string} moduleName
   */
  shouldRunWorkflow(moduleName) {
    if (!this._loaded) this.load();
    const entry = this._state.get(moduleName);
    if (!entry) return false; // No migration configured — workflow off
    return entry.mode === MigrationMode.WORKFLOW;
  }

  /**
   * Should the workflow run in shadow (dry-run) mode?
   * Returns TRUE in SHADOW mode.
   * @param {string} moduleName
   */
  shouldRunShadow(moduleName) {
    if (!this._loaded) this.load();
    const entry = this._state.get(moduleName);
    if (!entry) return false;
    return entry.mode === MigrationMode.SHADOW;
  }

  /**
   * Get the current mode for a module.
   * @param {string} moduleName
   * @returns {string} One of MigrationMode values, or "legacy" if not configured
   */
  getMode(moduleName) {
    if (!this._loaded) this.load();
    const entry = this._state.get(moduleName);
    return entry?.mode || MigrationMode.LEGACY;
  }

  /**
   * Get the full migration status for all tracked modules.
   * @returns {Array<{module, mode, workflowId, templateId, lastValidated, validationPassed}>}
   */
  getStatus() {
    if (!this._loaded) this.load();
    const result = [];
    for (const [mod, entry] of this._state) {
      result.push({
        module: mod,
        mode: entry.mode,
        workflowId: entry.workflowId,
        templateId: entry.templateId,
        lastValidated: entry.lastValidated,
        validationPassed: entry.validationPassed,
        shadowLogCount: entry.shadowLog?.length || 0,
      });
    }
    return result;
  }

  // ── Mutation API ──────────────────────────────────────────────────────

  /**
   * Register a module → workflow mapping. Called when a template is installed.
   * @param {string} moduleName - e.g. "maintenance.mjs"
   * @param {string} workflowId - The installed workflow's ID
   * @param {string} [templateId] - The template ID it was installed from
   * @param {string} [mode] - Initial mode (defaults to SHADOW for safety)
   */
  register(moduleName, workflowId, templateId, mode = MigrationMode.SHADOW) {
    if (!this._loaded) this.load();
    this._state.set(moduleName, {
      mode,
      workflowId,
      templateId: templateId || null,
      enabledAt: new Date().toISOString(),
      shadowLog: [],
      lastValidated: null,
      validationPassed: null,
    });
    this.save();
    console.log(`${TAG} Registered ${moduleName} → workflow ${workflowId} (mode: ${mode})`);
  }

  /**
   * Transition a module to a new migration mode.
   * @param {string} moduleName
   * @param {string} newMode - One of MigrationMode values
   */
  setMode(moduleName, newMode) {
    if (!this._loaded) this.load();
    const entry = this._state.get(moduleName);
    if (!entry) {
      throw new Error(`${TAG} Module "${moduleName}" not registered for migration`);
    }
    const oldMode = entry.mode;
    entry.mode = newMode;
    this.save();
    console.log(`${TAG} ${moduleName}: ${oldMode} → ${newMode}`);
  }

  /**
   * Add a shadow-mode log entry. Used to compare workflow output vs legacy output.
   * @param {string} moduleName
   * @param {object} entry - { action, timestamp, wouldHaveDone, legacyDid }
   */
  addShadowLog(moduleName, entry) {
    if (!this._loaded) this.load();
    const state = this._state.get(moduleName);
    if (!state) return;
    state.shadowLog = state.shadowLog || [];
    state.shadowLog.push({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
    // Keep last 50 entries
    if (state.shadowLog.length > 50) {
      state.shadowLog = state.shadowLog.slice(-50);
    }
    this.save();
  }

  /**
   * Record a validation result (dry-run success/failure).
   * @param {string} moduleName
   * @param {boolean} passed
   */
  recordValidation(moduleName, passed) {
    if (!this._loaded) this.load();
    const entry = this._state.get(moduleName);
    if (!entry) return;
    entry.lastValidated = new Date().toISOString();
    entry.validationPassed = passed;
    this.save();
  }

  /**
   * Remove a module from migration tracking (e.g. when reverting).
   * @param {string} moduleName
   */
  unregister(moduleName) {
    if (!this._loaded) this.load();
    this._state.delete(moduleName);
    this.save();
    console.log(`${TAG} Unregistered ${moduleName} from migration`);
  }

  /**
   * Auto-discover which installed workflows replace which modules.
   * Uses the `metadata.replaces.module` field in workflow definitions.
   * Only registers NEW mappings — doesn't overwrite existing ones.
   * @param {import('./workflow-engine.mjs').WorkflowEngine} [engine]
   */
  discoverFromEngine(engine) {
    const eng = engine || this.engine;
    if (!eng) return [];

    const discovered = [];
    for (const wf of eng.list()) {
      const replacesModule = wf.metadata?.replaces?.module;
      if (!replacesModule) continue;
      if (this._state.has(replacesModule)) continue; // Already tracked

      // Register in SHADOW mode by default — safe starting point
      this.register(
        replacesModule,
        wf.id,
        wf.metadata?.installedFrom || wf.id,
        MigrationMode.SHADOW
      );
      discovered.push({ module: replacesModule, workflowId: wf.id });
    }
    return discovered;
  }

  // ── Execution Helpers ─────────────────────────────────────────────────

  /**
   * Execute a workflow with the correct mode (dry-run for shadow, full for workflow).
   * Returns null if the workflow shouldn't run per migration config.
   * @param {string} moduleName
   * @param {object} [inputData]
   * @param {import('./workflow-engine.mjs').WorkflowEngine} [engine]
   * @returns {Promise<import('./workflow-engine.mjs').WorkflowContext|null>}
   */
  async executeForModule(moduleName, inputData = {}, engine) {
    if (!this._loaded) this.load();
    const entry = this._state.get(moduleName);
    if (!entry || !entry.workflowId) return null;

    const eng = engine || this.engine;
    if (!eng) return null;

    if (entry.mode === MigrationMode.LEGACY) {
      // Don't run the workflow at all in legacy mode
      return null;
    }

    const isDryRun = entry.mode === MigrationMode.SHADOW;

    try {
      const ctx = await eng.execute(entry.workflowId, inputData, {
        dryRun: isDryRun,
        force: true, // Allow execution even if workflow is disabled
      });

      if (isDryRun) {
        this.addShadowLog(moduleName, {
          action: "shadow-run",
          wouldHaveDone: ctx.getLog().map(l => l.message).join("; "),
          nodes: ctx.nodeOutputs ? Object.keys(ctx.nodeOutputs) : [],
          errors: ctx.errors || [],
        });
      }

      this.recordValidation(moduleName, ctx.errors.length === 0);
      return ctx;
    } catch (err) {
      console.warn(`${TAG} Failed to execute workflow for ${moduleName}: ${err.message}`);
      this.recordValidation(moduleName, false);
      return null;
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance = null;

/**
 * Get the shared MigrationGuard singleton.
 * @param {object} [opts] - Options for construction (only used on first call)
 * @returns {MigrationGuard}
 */
export function getMigrationGuard(opts = {}) {
  if (!_instance) {
    _instance = new MigrationGuard(opts);
    _instance.load();
  }
  return _instance;
}

/** Reset the singleton (for testing). */
export function resetMigrationGuard() {
  _instance = null;
}

// ── Template → Module Mapping ───────────────────────────────────────────────

/**
 * Known mappings: template ID → module filename.
 * Extracted from the `metadata.replaces.module` field of each template.
 * Used for quick lookups without needing to load the engine.
 */
export const TEMPLATE_MODULE_MAP = Object.freeze({
  "template-anomaly-watchdog":       "anomaly-detector.mjs",
  "template-workspace-hygiene":      "maintenance.mjs",
  "template-pr-conflict-resolver":   "pr-cleanup-daemon.mjs",
  "template-health-check":           "config-doctor.mjs",
  "template-stale-pr-reaper":        "workspace-reaper.mjs",
  "template-agent-session-monitor":  "session-tracker.mjs",
  "template-nightly-report":         "telegram-sentinel.mjs",
});

/**
 * Reverse mapping: module filename → template ID.
 */
export const MODULE_TEMPLATE_MAP = Object.freeze(
  Object.fromEntries(
    Object.entries(TEMPLATE_MODULE_MAP).map(([tid, mod]) => [mod, tid])
  )
);
