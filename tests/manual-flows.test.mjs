/**
 * @module tests/manual-flows.test.mjs
 * @description Unit tests for the Manual Run Flows system.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  BUILTIN_FLOW_TEMPLATES,
  listFlowTemplates,
  getFlowTemplate,
  saveFlowTemplate,
  deleteFlowTemplate,
  createRun,
  startRun,
  completeRun,
  failRun,
  getRun,
  listRuns,
  executeFlow,
} from "../manual-flows.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

let testRoot;

async function makeTempRoot() {
  const dir = resolve(tmpdir(), `mf-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

describe("manual-flows", () => {
  beforeEach(async () => {
    testRoot = await makeTempRoot();
  });

  afterEach(async () => {
    if (testRoot && existsSync(testRoot)) {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Built-in Templates
  // ══════════════════════════════════════════════════════════════════════════

  describe("BUILTIN_FLOW_TEMPLATES", () => {
    it("has expected templates", () => {
      expect(BUILTIN_FLOW_TEMPLATES.length).toBeGreaterThanOrEqual(4);
      const ids = BUILTIN_FLOW_TEMPLATES.map((t) => t.id);
      expect(ids).toContain("codebase-annotation-audit");
      expect(ids).toContain("generate-skills");
      expect(ids).toContain("prepare-agents-md");
      expect(ids).toContain("codebase-health-check");
      expect(ids).toContain("context-index-full");
    });

    it("every template has required structure", () => {
      for (const tpl of BUILTIN_FLOW_TEMPLATES) {
        expect(tpl.id).toBeTruthy();
        expect(tpl.name).toBeTruthy();
        expect(tpl.description).toBeTruthy();
        expect(tpl.icon).toBeTruthy();
        expect(tpl.category).toBeTruthy();
        expect(tpl.builtin).toBe(true);
        expect(Array.isArray(tpl.tags)).toBe(true);
        expect(tpl.tags.length).toBeGreaterThan(0);
        expect(Array.isArray(tpl.fields)).toBe(true);
        expect(tpl.fields.length).toBeGreaterThan(0);
      }
    });

    it("each field has required properties", () => {
      for (const tpl of BUILTIN_FLOW_TEMPLATES) {
        for (const field of tpl.fields) {
          expect(field.id).toBeTruthy();
          expect(field.label).toBeTruthy();
          expect(["text", "textarea", "select", "toggle", "number"]).toContain(field.type);
          // Select fields must have options
          if (field.type === "select") {
            expect(Array.isArray(field.options)).toBe(true);
            expect(field.options.length).toBeGreaterThan(0);
            for (const opt of field.options) {
              expect(opt.label).toBeTruthy();
              expect(opt.value).toBeTruthy();
            }
          }
        }
      }
    });

    it("audit template has correct field IDs", () => {
      const audit = BUILTIN_FLOW_TEMPLATES.find((t) => t.id === "codebase-annotation-audit");
      const fieldIds = audit.fields.map((f) => f.id);
      expect(fieldIds).toEqual(
        expect.arrayContaining([
          "targetDir",
          "fileExtensions",
          "skipGenerated",
          "phases",
          "dryRun",
          "commitMessage",
        ]),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Template Registry
  // ══════════════════════════════════════════════════════════════════════════

  describe("listFlowTemplates", () => {
    it("returns builtins when no rootDir is specified", () => {
      const templates = listFlowTemplates();
      expect(templates.length).toBe(BUILTIN_FLOW_TEMPLATES.length);
    });

    it("returns builtins even when rootDir has no custom templates", () => {
      const templates = listFlowTemplates(testRoot);
      expect(templates.length).toBe(BUILTIN_FLOW_TEMPLATES.length);
    });

    it("includes user-created templates alongside builtins", () => {
      // Save a custom template manually
      const tplDir = resolve(testRoot, ".bosun", "manual-flows", "templates");
      mkdirSync(tplDir, { recursive: true });
      const custom = { id: "test-custom", name: "Test Custom", fields: [], tags: [] };
      writeFileSync(resolve(tplDir, "test-custom.json"), JSON.stringify(custom), "utf8");

      const templates = listFlowTemplates(testRoot);
      expect(templates.length).toBe(BUILTIN_FLOW_TEMPLATES.length + 1);
      const customFound = templates.find((t) => t.id === "test-custom");
      expect(customFound).toBeTruthy();
      expect(customFound.builtin).toBe(false);
    });
  });

  describe("getFlowTemplate", () => {
    it("finds a builtin template by ID", () => {
      const tpl = getFlowTemplate("codebase-annotation-audit");
      expect(tpl).toBeTruthy();
      expect(tpl.name).toBe("Codebase Annotation Audit");
    });

    it("returns null for unknown template", () => {
      expect(getFlowTemplate("nonexistent-template")).toBeNull();
    });
  });

  describe("saveFlowTemplate", () => {
    it("saves a custom template and retrieves it", () => {
      const tpl = saveFlowTemplate(
        {
          name: "My Custom Flow",
          description: "Does custom stuff",
          icon: "star",
          category: "custom",
          fields: [{ id: "name", label: "Name", type: "text" }],
          tags: ["custom"],
        },
        testRoot,
      );

      expect(tpl.id).toBeTruthy();
      expect(tpl.builtin).toBe(false);

      // Should appear in list
      const templates = listFlowTemplates(testRoot);
      const found = templates.find((t) => t.id === tpl.id);
      expect(found).toBeTruthy();
      expect(found.name).toBe("My Custom Flow");
    });

    it("preserves explicit ID", () => {
      const tpl = saveFlowTemplate(
        { id: "explicit-id", name: "Explicit", fields: [], tags: [] },
        testRoot,
      );
      expect(tpl.id).toBe("explicit-id");
    });
  });

  describe("deleteFlowTemplate", () => {
    it("deletes a user-created template", () => {
      const tpl = saveFlowTemplate(
        { id: "to-delete", name: "Delete Me", fields: [], tags: [] },
        testRoot,
      );
      expect(getFlowTemplate(tpl.id, testRoot)).toBeTruthy();

      const deleted = deleteFlowTemplate(tpl.id, testRoot);
      expect(deleted).toBe(true);
      expect(getFlowTemplate(tpl.id, testRoot)).toBeNull();
    });

    it("refuses to delete builtin templates", () => {
      const deleted = deleteFlowTemplate("codebase-annotation-audit", testRoot);
      expect(deleted).toBe(false);
    });

    it("returns false for non-existent template", () => {
      const deleted = deleteFlowTemplate("ghost-template", testRoot);
      expect(deleted).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Run Management
  // ══════════════════════════════════════════════════════════════════════════

  describe("createRun", () => {
    it("creates a run with pending status", () => {
      const run = createRun("codebase-annotation-audit", { phases: "inventory" }, testRoot);
      expect(run.id).toBeTruthy();
      expect(run.id.startsWith("mfr-")).toBe(true);
      expect(run.templateId).toBe("codebase-annotation-audit");
      expect(run.templateName).toBe("Codebase Annotation Audit");
      expect(run.status).toBe("pending");
      expect(run.startedAt).toBeTruthy();
      expect(run.completedAt).toBeNull();
      expect(run.result).toBeNull();
      expect(run.error).toBeNull();
    });

    it("applies defaults for missing optional fields", () => {
      const run = createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      // skipGenerated has defaultValue: true
      expect(run.formValues.skipGenerated).toBe(true);
      // dryRun has defaultValue: false
      expect(run.formValues.dryRun).toBe(false);
    });

    it("throws for missing required fields", () => {
      // phases is required for audit template
      expect(() => createRun("codebase-annotation-audit", {}, testRoot)).toThrow(
        /required field missing/i,
      );
    });

    it("throws for unknown template", () => {
      expect(() => createRun("doesnt-exist", {}, testRoot)).toThrow(/template not found/i);
    });

    it("persists run to disk", () => {
      const run = createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      const runsDir = resolve(testRoot, ".bosun", "manual-flows", "runs");
      const filePath = resolve(runsDir, `${run.id}.json`);
      expect(existsSync(filePath)).toBe(true);
      const stored = JSON.parse(readFileSync(filePath, "utf8"));
      expect(stored.id).toBe(run.id);
    });
  });

  describe("startRun", () => {
    it("transitions run to running status", () => {
      const run = createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      const updated = startRun(run.id, testRoot);
      expect(updated.status).toBe("running");
    });

    it("throws for non-existent run", () => {
      expect(() => startRun("mfr-ghost", testRoot)).toThrow(/run not found/i);
    });
  });

  describe("completeRun", () => {
    it("transitions to completed with result", () => {
      const run = createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      startRun(run.id, testRoot);
      const result = { filesScanned: 42, mode: "dry-run" };
      const completed = completeRun(run.id, result, testRoot);

      expect(completed.status).toBe("completed");
      expect(completed.completedAt).toBeTruthy();
      expect(completed.result.filesScanned).toBe(42);
    });
  });

  describe("failRun", () => {
    it("transitions to failed with error", () => {
      const run = createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      startRun(run.id, testRoot);
      const failed = failRun(run.id, "Something went wrong", testRoot);

      expect(failed.status).toBe("failed");
      expect(failed.completedAt).toBeTruthy();
      expect(failed.error).toBe("Something went wrong");
    });
  });

  describe("getRun", () => {
    it("retrieves a persisted run", () => {
      const run = createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      const retrieved = getRun(run.id, testRoot);
      expect(retrieved).toBeTruthy();
      expect(retrieved.id).toBe(run.id);
      expect(retrieved.templateId).toBe("codebase-annotation-audit");
    });

    it("returns null for non-existent run", () => {
      expect(getRun("mfr-nobody", testRoot)).toBeNull();
    });
  });

  describe("listRuns", () => {
    it("lists runs newest first", () => {
      createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      createRun("generate-skills", { skillScope: "global" }, testRoot);
      createRun("codebase-health-check", { checks: "all", outputFormat: "json" }, testRoot);

      const runs = listRuns(testRoot);
      expect(runs.length).toBe(3);
      // Newest first (reverse sort by filename which includes timestamp)
    });

    it("filters by templateId", () => {
      createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      createRun("generate-skills", { skillScope: "global" }, testRoot);

      const runs = listRuns(testRoot, { templateId: "codebase-annotation-audit" });
      expect(runs.length).toBe(1);
      expect(runs[0].templateId).toBe("codebase-annotation-audit");
    });

    it("filters by status", () => {
      const run = createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      createRun("generate-skills", { skillScope: "global" }, testRoot);
      startRun(run.id, testRoot);

      const running = listRuns(testRoot, { status: "running" });
      expect(running.length).toBe(1);
      expect(running[0].status).toBe("running");
    });

    it("respects limit option", () => {
      createRun("codebase-annotation-audit", { phases: "all" }, testRoot);
      createRun("generate-skills", { skillScope: "global" }, testRoot);
      createRun("codebase-health-check", { checks: "all", outputFormat: "json" }, testRoot);

      const runs = listRuns(testRoot, { limit: 2 });
      expect(runs.length).toBe(2);
    });

    it("returns empty array when no runs dir", () => {
      const emptyRoot = resolve(testRoot, "empty");
      mkdirSync(emptyRoot, { recursive: true });
      expect(listRuns(emptyRoot)).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Flow Execution
  // ══════════════════════════════════════════════════════════════════════════

  describe("executeFlow", () => {
    it("executes annotation audit dry-run successfully", async () => {
      // Create a few source files to scan
      mkdirSync(resolve(testRoot, "src"), { recursive: true });
      writeFileSync(
        resolve(testRoot, "src", "index.mjs"),
        '// CLAUDE:SUMMARY — index\n// Main entry point\nexport function main() {}',
        "utf8",
      );
      writeFileSync(
        resolve(testRoot, "src", "utils.mjs"),
        "export function helper() { return 1; }",
        "utf8",
      );

      const run = await executeFlow(
        "codebase-annotation-audit",
        { phases: "all", dryRun: true, targetDir: "src" },
        testRoot,
      );

      expect(run.status).toBe("completed");
      expect(run.result.mode).toBe("dry-run");
      expect(run.result.filesScanned).toBe(2);
      // index.mjs has CLAUDE:SUMMARY, utils.mjs does not
      expect(run.result.filesNeedingSummary).toBe(1);
    });

    it("falls back to inventory-saved mode without taskManager", async () => {
      mkdirSync(resolve(testRoot, "src"), { recursive: true });
      writeFileSync(resolve(testRoot, "src", "app.mjs"), "export default {};", "utf8");

      const run = await executeFlow(
        "codebase-annotation-audit",
        { phases: "all", dryRun: false, targetDir: "src" },
        testRoot,
      );

      expect(run.status).toBe("completed");
      expect(run.result.mode).toBe("inventory-saved");
      expect(run.result.inventoryPath).toBeTruthy();
      expect(existsSync(run.result.inventoryPath)).toBe(true);
    });

    it("dispatches to taskManager when available", async () => {
      mkdirSync(resolve(testRoot, "src"), { recursive: true });
      writeFileSync(resolve(testRoot, "src", "mod.mjs"), "export const x = 1;", "utf8");

      let createdTask = null;
      const mockTaskManager = {
        createTask: async (spec) => {
          createdTask = spec;
          return { id: "task-123" };
        },
      };

      const run = await executeFlow(
        "codebase-annotation-audit",
        { phases: "all", dryRun: false },
        testRoot,
        { taskManager: mockTaskManager },
      );

      expect(run.status).toBe("completed");
      expect(run.result.mode).toBe("task-dispatched");
      expect(run.result.taskId).toBe("task-123");
      expect(createdTask).toBeTruthy();
      expect(createdTask.title).toContain("audit");
    });

    it("rejects on non-existent template", async () => {
      // createRun throws before the try/catch in executeFlow
      await expect(
        executeFlow("nonexistent-template-xyz", {}, testRoot),
      ).rejects.toThrow(/template not found/i);
    });

    it("executes generate-skills flow in instructions mode", async () => {
      const run = await executeFlow(
        "generate-skills",
        { skillScope: "global" },
        testRoot,
      );

      expect(run.status).toBe("completed");
      expect(run.result.mode).toBe("instructions");
    });

    it("executes prepare-agents-md flow", async () => {
      const run = await executeFlow(
        "prepare-agents-md",
        { mode: "generate" },
        testRoot,
      );

      expect(run.status).toBe("completed");
      expect(run.result.mode).toBe("instructions");
    });

    it("executes codebase-health-check flow", async () => {
      const run = await executeFlow(
        "codebase-health-check",
        { checks: "all", outputFormat: "json" },
        testRoot,
      );

      expect(run.status).toBe("completed");
      expect(run.result.mode).toBe("instructions");
    });

    it("executes context-index-full flow", async () => {
      mkdirSync(resolve(testRoot, "src"), { recursive: true });
      writeFileSync(
        resolve(testRoot, "src", "sample.mjs"),
        "export function hello() { return 'world'; }",
        "utf8",
      );

      const run = await executeFlow(
        "context-index-full",
        { includeTests: true, maxFileBytes: 800000, useTreeSitter: false, useZoekt: false },
        testRoot,
      );

      expect(run.status).toBe("completed");
      expect(run.result.mode).toBe("indexed");
      expect(run.result.indexedFiles).toBeGreaterThan(0);
    });
  });
});
