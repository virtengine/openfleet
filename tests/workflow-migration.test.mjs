import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MigrationGuard,
  MigrationMode,
  getMigrationGuard,
  resetMigrationGuard,
  TEMPLATE_MODULE_MAP,
  MODULE_TEMPLATE_MAP,
} from "../scripts/bosun/workflow/workflow-migration.mjs""197;
import { WorkflowEngine } from "../scripts/bosun/workflow/workflow-engine.mjs""367;

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;

function makeTmpDir() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-mig-test-"));
  return tmpDir;
}

// ── Migration Mode Enum ─────────────────────────────────────────────────────

describe("MigrationMode", () => {
  it("has three modes", () => {
    expect(MigrationMode.LEGACY).toBe("legacy");
    expect(MigrationMode.SHADOW).toBe("shadow");
    expect(MigrationMode.WORKFLOW).toBe("workflow");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(MigrationMode)).toBe(true);
  });
});

// ── Template ↔ Module Mapping ───────────────────────────────────────────────

describe("TEMPLATE_MODULE_MAP", () => {
  it("maps template IDs to module filenames", () => {
    expect(TEMPLATE_MODULE_MAP["template-anomaly-watchdog"]).toBe("anomaly-detector.mjs");
    expect(TEMPLATE_MODULE_MAP["template-workspace-hygiene"]).toBe("maintenance.mjs");
    expect(TEMPLATE_MODULE_MAP["template-pr-conflict-resolver"]).toBe("pr-cleanup-daemon.mjs");
    expect(TEMPLATE_MODULE_MAP["template-health-check"]).toBe("config-doctor.mjs");
    expect(TEMPLATE_MODULE_MAP["template-stale-pr-reaper"]).toBe("workspace-reaper.mjs");
    expect(TEMPLATE_MODULE_MAP["template-agent-session-monitor"]).toBe("session-tracker.mjs");
    expect(TEMPLATE_MODULE_MAP["template-nightly-report"]).toBe("telegram-sentinel.mjs");
  });

  it("reverse map works correctly", () => {
    expect(MODULE_TEMPLATE_MAP["anomaly-detector.mjs"]).toBe("template-anomaly-watchdog");
    expect(MODULE_TEMPLATE_MAP["maintenance.mjs"]).toBe("template-workspace-hygiene");
    expect(MODULE_TEMPLATE_MAP["pr-cleanup-daemon.mjs"]).toBe("template-pr-conflict-resolver");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(TEMPLATE_MODULE_MAP)).toBe(true);
    expect(Object.isFrozen(MODULE_TEMPLATE_MAP)).toBe(true);
  });
});

// ── MigrationGuard ──────────────────────────────────────────────────────────

describe("MigrationGuard", () => {
  let guard;

  beforeEach(() => {
    makeTmpDir();
    guard = new MigrationGuard({ configPath: join(tmpDir, "migration.json") });
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── Default behavior (no config) ───────────────────────────────────────

  it("defaults to legacy mode (old modules run, workflows don't)", () => {
    expect(guard.shouldRunLegacy("maintenance.mjs")).toBe(true);
    expect(guard.shouldRunWorkflow("maintenance.mjs")).toBe(false);
    expect(guard.shouldRunShadow("maintenance.mjs")).toBe(false);
    expect(guard.getMode("maintenance.mjs")).toBe("legacy");
  });

  // ── Registration ───────────────────────────────────────────────────────

  it("register puts module in shadow mode by default", () => {
    guard.register("maintenance.mjs", "wf-123", "template-workspace-hygiene");
    expect(guard.getMode("maintenance.mjs")).toBe("shadow");
    expect(guard.shouldRunLegacy("maintenance.mjs")).toBe(true);  // Legacy still runs
    expect(guard.shouldRunShadow("maintenance.mjs")).toBe(true);  // Shadow also runs
    expect(guard.shouldRunWorkflow("maintenance.mjs")).toBe(false); // But not full workflow
  });

  it("register with explicit WORKFLOW mode disables legacy", () => {
    guard.register("maintenance.mjs", "wf-123", "template-workspace-hygiene", MigrationMode.WORKFLOW);
    expect(guard.shouldRunLegacy("maintenance.mjs")).toBe(false);
    expect(guard.shouldRunWorkflow("maintenance.mjs")).toBe(true);
  });

  // ── Mode Transitions ──────────────────────────────────────────────────

  it("setMode transitions from shadow to workflow", () => {
    guard.register("maintenance.mjs", "wf-123");
    expect(guard.getMode("maintenance.mjs")).toBe("shadow");

    guard.setMode("maintenance.mjs", MigrationMode.WORKFLOW);
    expect(guard.getMode("maintenance.mjs")).toBe("workflow");
    expect(guard.shouldRunLegacy("maintenance.mjs")).toBe(false);
    expect(guard.shouldRunWorkflow("maintenance.mjs")).toBe(true);
  });

  it("setMode transitions from workflow back to legacy (rollback)", () => {
    guard.register("maintenance.mjs", "wf-123", null, MigrationMode.WORKFLOW);
    guard.setMode("maintenance.mjs", MigrationMode.LEGACY);
    expect(guard.shouldRunLegacy("maintenance.mjs")).toBe(true);
    expect(guard.shouldRunWorkflow("maintenance.mjs")).toBe(false);
  });

  it("setMode throws for unregistered module", () => {
    expect(() => guard.setMode("nonexistent.mjs", MigrationMode.WORKFLOW)).toThrow(/not registered/);
  });

  // ── Persistence ───────────────────────────────────────────────────────

  it("persists state to disk and reloads", () => {
    guard.register("maintenance.mjs", "wf-123", "template-workspace-hygiene");
    guard.setMode("maintenance.mjs", MigrationMode.WORKFLOW);

    // New guard instance from same config path
    const guard2 = new MigrationGuard({ configPath: guard.configPath });
    guard2.load();
    expect(guard2.getMode("maintenance.mjs")).toBe("workflow");
    expect(guard2.shouldRunLegacy("maintenance.mjs")).toBe(false);
    expect(guard2.shouldRunWorkflow("maintenance.mjs")).toBe(true);
  });

  // ── Shadow Log ────────────────────────────────────────────────────────

  it("addShadowLog tracks shadow-mode execution results", () => {
    guard.register("maintenance.mjs", "wf-123");
    guard.addShadowLog("maintenance.mjs", {
      action: "shadow-run",
      wouldHaveDone: "pruned 3 worktrees; killed 0 stale processes",
    });
    guard.addShadowLog("maintenance.mjs", {
      action: "shadow-run",
      wouldHaveDone: "pruned 0 worktrees; killed 1 stale process",
    });

    const status = guard.getStatus();
    const maint = status.find((s) => s.module === "maintenance.mjs");
    expect(maint.shadowLogCount).toBe(2);
  });

  it("shadow log is capped at 50 entries", () => {
    guard.register("maintenance.mjs", "wf-123");
    for (let i = 0; i < 60; i++) {
      guard.addShadowLog("maintenance.mjs", { action: `run-${i}` });
    }
    const status = guard.getStatus();
    const maint = status.find((s) => s.module === "maintenance.mjs");
    expect(maint.shadowLogCount).toBe(50);
  });

  // ── Validation ────────────────────────────────────────────────────────

  it("recordValidation tracks pass/fail", () => {
    guard.register("maintenance.mjs", "wf-123");
    guard.recordValidation("maintenance.mjs", true);

    const status = guard.getStatus();
    const maint = status.find((s) => s.module === "maintenance.mjs");
    expect(maint.validationPassed).toBe(true);
    expect(maint.lastValidated).toBeDefined();
  });

  // ── Unregister ────────────────────────────────────────────────────────

  it("unregister removes module from tracking", () => {
    guard.register("maintenance.mjs", "wf-123");
    guard.unregister("maintenance.mjs");
    expect(guard.shouldRunLegacy("maintenance.mjs")).toBe(true);
    expect(guard.getMode("maintenance.mjs")).toBe("legacy");
    expect(guard.getStatus().length).toBe(0);
  });

  // ── getStatus ─────────────────────────────────────────────────────────

  it("getStatus returns full status for all tracked modules", () => {
    guard.register("maintenance.mjs", "wf-1", "tpl-1");
    guard.register("anomaly-detector.mjs", "wf-2", "tpl-2", MigrationMode.WORKFLOW);

    const status = guard.getStatus();
    expect(status.length).toBe(2);
    expect(status.find((s) => s.module === "maintenance.mjs").mode).toBe("shadow");
    expect(status.find((s) => s.module === "anomaly-detector.mjs").mode).toBe("workflow");
  });

  // ── Auto-discovery ────────────────────────────────────────────────────

  it("discoverFromEngine finds workflows with replaces metadata", () => {
    const engine = new WorkflowEngine({
      workflowDir: join(tmpDir, "workflows"),
      runsDir: join(tmpDir, "runs"),
    });

    // Save a mock workflow that replaces a module
    engine.save({
      id: "wf-test-1",
      name: "Test Workflow",
      nodes: [{ id: "t", type: "trigger.manual", label: "Start", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      metadata: {
        replaces: { module: "maintenance.mjs" },
        installedFrom: "template-workspace-hygiene",
      },
    });

    guard.engine = engine;
    const discovered = guard.discoverFromEngine();
    expect(discovered.length).toBe(1);
    expect(discovered[0].module).toBe("maintenance.mjs");
    expect(guard.getMode("maintenance.mjs")).toBe("shadow");
  });

  it("discoverFromEngine does not overwrite existing registrations", () => {
    guard.register("maintenance.mjs", "wf-old", null, MigrationMode.WORKFLOW);

    const engine = new WorkflowEngine({
      workflowDir: join(tmpDir, "workflows"),
      runsDir: join(tmpDir, "runs"),
    });
    engine.save({
      id: "wf-new",
      name: "New Workflow",
      nodes: [{ id: "t", type: "trigger.manual", label: "Start", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      metadata: { replaces: { module: "maintenance.mjs" } },
    });

    guard.engine = engine;
    const discovered = guard.discoverFromEngine();
    expect(discovered.length).toBe(0); // Didn't overwrite
    expect(guard.getMode("maintenance.mjs")).toBe("workflow"); // Still workflow
  });
});

// ── Singleton ───────────────────────────────────────────────────────────────

describe("getMigrationGuard singleton", () => {
  beforeEach(() => {
    resetMigrationGuard();
  });
  afterEach(() => {
    resetMigrationGuard();
  });

  it("returns the same instance on repeated calls", () => {
    const g1 = getMigrationGuard({ configPath: join(tmpdir(), "does-not-exist.json") });
    const g2 = getMigrationGuard();
    expect(g1).toBe(g2);
  });
});

// ── Dual-Execution Prevention Matrix ────────────────────────────────────────

describe("dual-execution prevention", () => {
  let guard;

  beforeEach(() => {
    makeTmpDir();
    guard = new MigrationGuard({ configPath: join(tmpDir, "migration.json") });
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  const MODES = [MigrationMode.LEGACY, MigrationMode.SHADOW, MigrationMode.WORKFLOW];

  for (const mode of MODES) {
    it(`mode=${mode}: legacy and workflow never BOTH run in full mode`, () => {
      guard.register("test.mjs", "wf-x", null, mode);

      const legacyRuns = guard.shouldRunLegacy("test.mjs");
      const workflowRuns = guard.shouldRunWorkflow("test.mjs");
      const shadowRuns = guard.shouldRunShadow("test.mjs");

      // The critical invariant: legacy and workflow NEVER both return true
      expect(legacyRuns && workflowRuns).toBe(false);

      // Verify expected behavior per mode
      if (mode === "legacy") {
        expect(legacyRuns).toBe(true);
        expect(workflowRuns).toBe(false);
        expect(shadowRuns).toBe(false);
      }
      if (mode === "shadow") {
        expect(legacyRuns).toBe(true);  // Legacy still runs as safety net
        expect(workflowRuns).toBe(false); // Workflow does NOT take real action
        expect(shadowRuns).toBe(true);    // But shadow logging happens
      }
      if (mode === "workflow") {
        expect(legacyRuns).toBe(false);  // Legacy disabled
        expect(workflowRuns).toBe(true); // Workflow takes over
        expect(shadowRuns).toBe(false);
      }
    });
  }
});
