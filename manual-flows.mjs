// CLAUDE:SUMMARY — manual-flows
// Backend for Manual Run Flows — one-shot templates with user-configurable forms
// that trigger codebase-wide transformations (audit/annotate, skill generation,
// config preparation). Each template defines form fields, validation, and an
// executor function. Runs are persisted to .bosun/manual-flows/runs/.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ────────────────────────────────────────────────────────────────────
/**
 * @typedef {Object} ManualFlowField
 * @property {string}   id          — unique field key
 * @property {string}   label       — display label
 * @property {"text"|"textarea"|"select"|"toggle"|"number"} type
 * @property {string}   [placeholder]
 * @property {*}        [defaultValue]
 * @property {boolean}  [required]
 * @property {Array<{label:string, value:string}>} [options] — for select fields
 * @property {string}   [helpText]
 */

/**
 * @typedef {Object} ManualFlowTemplate
 * @property {string}   id
 * @property {string}   name
 * @property {string}   description
 * @property {string}   icon         — icon key for UI
 * @property {string}   category     — e.g. "audit", "transform", "generate"
 * @property {ManualFlowField[]} fields
 * @property {string[]} tags
 * @property {boolean}  [builtin]    — true for built-in templates
 * @property {string}   [version]
 */

/**
 * @typedef {Object} ManualFlowRun
 * @property {string}   id
 * @property {string}   templateId
 * @property {string}   templateName
 * @property {Object}   formValues   — user-submitted field values
 * @property {"pending"|"running"|"completed"|"failed"} status
 * @property {string}   startedAt
 * @property {string}   [completedAt]
 * @property {Object}   [result]     — executor output
 * @property {string}   [error]
 */

// ── Directories ──────────────────────────────────────────────────────────────

function getFlowsDir(rootDir) {
  return resolve(rootDir, ".bosun", "manual-flows");
}

function getRunsDir(rootDir) {
  return resolve(getFlowsDir(rootDir), "runs");
}

function getTemplatesDir(rootDir) {
  return resolve(getFlowsDir(rootDir), "templates");
}

function ensureDirs(rootDir) {
  mkdirSync(getRunsDir(rootDir), { recursive: true });
  mkdirSync(getTemplatesDir(rootDir), { recursive: true });
}

// ── Built-in Templates ───────────────────────────────────────────────────────

/** @type {ManualFlowTemplate[]} */
export const BUILTIN_FLOW_TEMPLATES = [
  {
    id: "codebase-annotation-audit",
    name: "Codebase Annotation Audit",
    description:
      "Systematically audit & annotate the codebase with CLAUDE:SUMMARY and CLAUDE:WARN comments so future AI agents navigate 4× faster. Documentation-only — no code behavior changes.",
    icon: "search",
    category: "audit",
    tags: ["audit", "annotation", "documentation", "onboarding"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "targetDir",
        label: "Target Directory",
        type: "text",
        placeholder: "src/  (leave blank for entire repo)",
        defaultValue: "",
        required: false,
        helpText: "Relative path from repo root. Leave empty to audit the entire repository.",
      },
      {
        id: "fileExtensions",
        label: "File Extensions",
        type: "text",
        placeholder: ".mjs, .js, .ts, .py",
        defaultValue: ".mjs, .js, .ts, .tsx, .jsx, .py",
        required: false,
        helpText: "Comma-separated list of extensions to audit. Leave empty for all source files.",
      },
      {
        id: "skipGenerated",
        label: "Skip Generated Files",
        type: "toggle",
        defaultValue: true,
        helpText: "Skip lockfiles, build output, .min.js, etc.",
      },
      {
        id: "phases",
        label: "Phases to Run",
        type: "select",
        defaultValue: "all",
        options: [
          { label: "All Phases (1-6)", value: "all" },
          { label: "Inventory Only (Phase 1)", value: "inventory" },
          { label: "Summaries Only (Phase 2)", value: "summaries" },
          { label: "Warnings Only (Phase 3)", value: "warnings" },
          { label: "Manifest Audit (Phase 4)", value: "manifest" },
          { label: "Conformity Check (Phase 5)", value: "conformity" },
          { label: "Regeneration Schedule (Phase 6)", value: "schedule" },
        ],
        required: true,
        helpText: "Which audit phases to execute. Run 'All' for a full audit.",
      },
      {
        id: "dryRun",
        label: "Dry Run",
        type: "toggle",
        defaultValue: false,
        helpText: "Preview what would be annotated without writing any files.",
      },
      {
        id: "commitMessage",
        label: "Commit Message",
        type: "text",
        placeholder: "docs(audit): annotate codebase",
        defaultValue: "docs(audit): annotate codebase with CLAUDE:SUMMARY and CLAUDE:WARN",
        required: false,
        helpText: "Commit message for the annotation changes. Leave empty to skip auto-commit.",
      },
    ],
  },
  {
    id: "generate-skills",
    name: "Generate Agent Skills",
    description:
      "Analyze the codebase and auto-generate Bosun skill files (.md) capturing key patterns, domain knowledge, and pitfalls for future agents.",
    icon: "book",
    category: "generate",
    tags: ["skills", "knowledge", "patterns", "automation"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "targetModules",
        label: "Target Modules",
        type: "text",
        placeholder: "e.g. auth, payments, api  (blank = all)",
        defaultValue: "",
        required: false,
        helpText: "Comma-separated module/directory names to analyze.",
      },
      {
        id: "skillScope",
        label: "Skill Scope",
        type: "select",
        defaultValue: "global",
        options: [
          { label: "Global (shared across workspaces)", value: "global" },
          { label: "Workspace-local", value: "workspace" },
        ],
        required: true,
      },
      {
        id: "includeExamples",
        label: "Include Code Examples",
        type: "toggle",
        defaultValue: true,
        helpText: "Embed short code snippets demonstrating patterns.",
      },
      {
        id: "maxSkills",
        label: "Max Skills to Generate",
        type: "number",
        defaultValue: 10,
        required: false,
        helpText: "Maximum number of skill files to create in one run.",
      },
    ],
  },
  {
    id: "prepare-agents-md",
    name: "Prepare AGENTS.md",
    description:
      "Generate or update the AGENTS.md file at repo root with accurate build commands, module inventory, environment variables, and project conventions.",
    icon: "file-text",
    category: "generate",
    tags: ["agents", "documentation", "onboarding", "config"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "repoRoot",
        label: "Repository Root",
        type: "text",
        placeholder: "(current workspace)",
        defaultValue: "",
        required: false,
        helpText: "Absolute path to repo root. Defaults to current workspace.",
      },
      {
        id: "includeEnvVars",
        label: "Include Environment Variables",
        type: "toggle",
        defaultValue: true,
        helpText: "Document all .env / env var references found in the codebase.",
      },
      {
        id: "includeModuleInventory",
        label: "Include Module Inventory",
        type: "toggle",
        defaultValue: true,
        helpText: "List all top-level modules with 1-line descriptions.",
      },
      {
        id: "mode",
        label: "Mode",
        type: "select",
        defaultValue: "update",
        options: [
          { label: "Update existing AGENTS.md", value: "update" },
          { label: "Generate from scratch", value: "generate" },
        ],
        required: true,
      },
    ],
  },
  {
    id: "codebase-health-check",
    name: "Codebase Health Check",
    description:
      "Run a comprehensive health check: dead code detection, dependency audit, circular imports, and test coverage gaps.",
    icon: "activity",
    category: "audit",
    tags: ["health", "quality", "dead-code", "dependencies", "coverage"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "checks",
        label: "Checks to Run",
        type: "select",
        defaultValue: "all",
        options: [
          { label: "All Checks", value: "all" },
          { label: "Dead Code Detection", value: "dead-code" },
          { label: "Dependency Audit", value: "deps" },
          { label: "Circular Import Detection", value: "circular" },
          { label: "Test Coverage Gaps", value: "coverage" },
        ],
        required: true,
      },
      {
        id: "targetDir",
        label: "Target Directory",
        type: "text",
        placeholder: "src/  (leave blank for entire repo)",
        defaultValue: "",
        required: false,
      },
      {
        id: "outputFormat",
        label: "Output Format",
        type: "select",
        defaultValue: "json",
        options: [
          { label: "JSON Report", value: "json" },
          { label: "Markdown Report", value: "markdown" },
          { label: "Both", value: "both" },
        ],
        required: true,
      },
    ],
  },
  {
    id: "context-index-full",
    name: "Context Index (Full)",
    description:
      "Build a Bosun-native context index (SQLite + optional tree-sitter + optional Zoekt) and generate agent-first index artifacts.",
    icon: "database",
    category: "audit",
    tags: ["context", "index", "sqlite", "agents"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "includeTests",
        label: "Include Tests",
        type: "toggle",
        defaultValue: true,
        helpText: "Include test/spec files in the context index.",
      },
      {
        id: "maxFileBytes",
        label: "Max File Size (bytes)",
        type: "number",
        defaultValue: 800000,
        helpText: "Skip files larger than this size when indexing.",
      },
      {
        id: "useTreeSitter",
        label: "Use tree-sitter",
        type: "toggle",
        defaultValue: true,
        helpText: "Use tree-sitter tags for symbol extraction when available.",
      },
      {
        id: "useZoekt",
        label: "Use Zoekt",
        type: "toggle",
        defaultValue: true,
        helpText: "Build an optional Zoekt index when zoekt-index is installed.",
      },
    ],
  },
  {
    id: "research-agent",
    name: "Research Agent (Aletheia-Style)",
    description:
      "Launch an iterative research agent inspired by Google DeepMind's Aletheia. " +
      "Generates a candidate solution, verifies it with an independent model, " +
      "and iterates through revision or full regeneration cycles until convergence. " +
      "Supports literature search, configurable iteration limits, and multi-domain research.",
    icon: "microscope",
    category: "research",
    tags: ["research", "aletheia", "convergence", "verification", "ai-agent"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "problem",
        label: "Research Problem",
        type: "textarea",
        placeholder: "e.g. Prove that for every ε > 0 there exists a δ > 0 such that...",
        defaultValue: "",
        required: true,
        helpText: "The research problem or question to investigate. Be as specific as possible.",
      },
      {
        id: "domain",
        label: "Domain",
        type: "select",
        defaultValue: "mathematics",
        options: [
          { label: "Mathematics", value: "mathematics" },
          { label: "Computer Science", value: "computer-science" },
          { label: "Physics", value: "physics" },
          { label: "Biology", value: "biology" },
          { label: "Chemistry", value: "chemistry" },
          { label: "Engineering", value: "engineering" },
        ],
        required: true,
        helpText: "Research domain — guides literature search and agent prompts.",
      },
      {
        id: "maxIterations",
        label: "Max Iterations",
        type: "number",
        defaultValue: 10,
        required: false,
        helpText: "Maximum generate→verify→revise cycles before stopping (1-50).",
      },
      {
        id: "searchLiterature",
        label: "Search Literature First",
        type: "toggle",
        defaultValue: true,
        helpText: "Run a web search for relevant papers before generating a solution.",
      },
      {
        id: "executionMode",
        label: "Execution Mode",
        type: "select",
        defaultValue: "workflow",
        options: [
          { label: "Workflow Engine (back-edge loops)", value: "workflow" },
          { label: "Task Dispatch (agent picks up)", value: "task" },
        ],
        required: true,
        helpText: "Workflow mode runs the full generate→verify→revise loop automatically. Task mode dispatches to an available agent.",
      },
    ],
  },
];

// ── Template Registry ────────────────────────────────────────────────────────

/**
 * List all available manual flow templates (built-in + user-created).
 *
 * @param {string} [rootDir]
 * @returns {ManualFlowTemplate[]}
 */
export function listFlowTemplates(rootDir) {
  const templates = [...BUILTIN_FLOW_TEMPLATES];

  if (rootDir) {
    const dir = getTemplatesDir(rootDir);
    if (existsSync(dir)) {
      try {
        for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
          try {
            const tpl = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
            if (tpl.id && tpl.name) {
              tpl.builtin = false;
              templates.push(tpl);
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* dir read error */ }
    }
  }

  return templates;
}

/**
 * Get a specific template by ID.
 *
 * @param {string} templateId
 * @param {string} [rootDir]
 * @returns {ManualFlowTemplate|null}
 */
export function getFlowTemplate(templateId, rootDir) {
  return listFlowTemplates(rootDir).find((t) => t.id === templateId) || null;
}

/**
 * Save a user-created template.
 *
 * @param {ManualFlowTemplate} template
 * @param {string} rootDir
 * @returns {ManualFlowTemplate}
 */
export function saveFlowTemplate(template, rootDir) {
  ensureDirs(rootDir);
  const id = template.id || `custom-${Date.now().toString(36)}`;
  const tpl = { ...template, id, builtin: false };
  const filePath = resolve(getTemplatesDir(rootDir), `${id}.json`);
  writeFileSync(filePath, JSON.stringify(tpl, null, 2) + "\n", "utf8");
  return tpl;
}

/**
 * Delete a user-created template (built-ins cannot be deleted).
 *
 * @param {string} templateId
 * @param {string} rootDir
 * @returns {boolean}
 */
export function deleteFlowTemplate(templateId, rootDir) {
  if (BUILTIN_FLOW_TEMPLATES.some((t) => t.id === templateId)) return false;
  const filePath = resolve(getTemplatesDir(rootDir), `${templateId}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

// ── Run Management ───────────────────────────────────────────────────────────

/**
 * Create a new manual flow run.
 *
 * @param {string} templateId
 * @param {Object} formValues
 * @param {string} rootDir
 * @returns {ManualFlowRun}
 */
export function createRun(templateId, formValues, rootDir) {
  ensureDirs(rootDir);
  const template = getFlowTemplate(templateId, rootDir);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  // Validate required fields
  for (const field of template.fields) {
    if (field.required) {
      const val = formValues[field.id];
      if (val === undefined || val === null || val === "") {
        throw new Error(`Required field missing: ${field.label} (${field.id})`);
      }
    }
  }

  // Apply defaults for missing optional fields
  const resolved = {};
  for (const field of template.fields) {
    if (formValues[field.id] !== undefined && formValues[field.id] !== null) {
      resolved[field.id] = formValues[field.id];
    } else if (field.defaultValue !== undefined) {
      resolved[field.id] = field.defaultValue;
    }
  }

  const run = {
    id: `mfr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    templateId,
    templateName: template.name,
    formValues: resolved,
    status: "pending",
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
    error: null,
  };

  writeRunToDisk(run, rootDir);
  return run;
}

/**
 * Mark a run as started.
 *
 * @param {string} runId
 * @param {string} rootDir
 * @returns {ManualFlowRun}
 */
export function startRun(runId, rootDir) {
  const run = getRun(runId, rootDir);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.status = "running";
  writeRunToDisk(run, rootDir);
  return run;
}

/**
 * Mark a run as completed with a result.
 *
 * @param {string} runId
 * @param {Object} result
 * @param {string} rootDir
 * @returns {ManualFlowRun}
 */
export function completeRun(runId, result, rootDir) {
  const run = getRun(runId, rootDir);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  run.result = result || {};
  writeRunToDisk(run, rootDir);
  return run;
}

/**
 * Mark a run as failed.
 *
 * @param {string} runId
 * @param {string} error
 * @param {string} rootDir
 * @returns {ManualFlowRun}
 */
export function failRun(runId, error, rootDir) {
  const run = getRun(runId, rootDir);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.status = "failed";
  run.completedAt = new Date().toISOString();
  run.error = error;
  writeRunToDisk(run, rootDir);
  return run;
}

/**
 * Get a single run by ID.
 */
export function getRun(runId, rootDir) {
  const filePath = resolve(getRunsDir(rootDir), `${runId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * List all runs, newest first.
 *
 * @param {string}  rootDir
 * @param {Object}  [opts]
 * @param {string}  [opts.templateId]  — filter by template
 * @param {string}  [opts.status]      — filter by status
 * @param {number}  [opts.limit=50]
 * @returns {ManualFlowRun[]}
 */
export function listRuns(rootDir, opts = {}) {
  const dir = getRunsDir(rootDir);
  if (!existsSync(dir)) return [];

  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const limit = opts.limit || 50;
  const results = [];

  for (const f of files) {
    if (results.length >= limit) break;
    try {
      const run = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
      if (opts.templateId && run.templateId !== opts.templateId) continue;
      if (opts.status && run.status !== opts.status) continue;
      results.push(run);
    } catch { /* skip */ }
  }

  return results;
}

// ── Execution Dispatcher ─────────────────────────────────────────────────────

/**
 * Execute a manual flow: create a run, dispatch to the appropriate executor,
 * and return the run record. The actual work is dispatched as a Bosun task or
 * run inline depending on the template.
 *
 * @param {string} templateId
 * @param {Object} formValues
 * @param {string} rootDir
 * @param {Object} [context]  — optional: { taskManager, agentPool, config }
 * @returns {Promise<ManualFlowRun>}
 */
export async function executeFlow(templateId, formValues, rootDir, context = {}) {
  const run = createRun(templateId, formValues, rootDir);

  try {
    startRun(run.id, rootDir);

    const template = getFlowTemplate(templateId, rootDir);
    if (!template) throw new Error(`Template not found: ${templateId}`);

    // Execute based on template category / id
    let result;
    switch (templateId) {
      case "codebase-annotation-audit":
        result = await executeAnnotationAudit(run.formValues, rootDir, context);
        break;
      case "generate-skills":
        result = await executeSkillGeneration(run.formValues, rootDir, context);
        break;
      case "prepare-agents-md":
        result = await executeAgentsMdPrep(run.formValues, rootDir, context);
        break;
      case "codebase-health-check":
        result = await executeHealthCheck(run.formValues, rootDir, context);
        break;
      case "context-index-full":
        result = await executeContextIndexFull(run.formValues, rootDir, context);
        break;
      case "research-agent":
        result = await executeResearchAgent(run.formValues, rootDir, context);
        break;
      default:
        // For custom templates, create a Bosun task
        result = await executeCustomFlow(template, run.formValues, rootDir, context);
        break;
    }

    return completeRun(run.id, result, rootDir);
  } catch (err) {
    return failRun(run.id, err.message || String(err), rootDir);
  }
}

// ── Built-in Executors ───────────────────────────────────────────────────────

/**
 * Execute the Codebase Annotation Audit flow.
 * Creates a Bosun task with the audit skill injected, or runs a lightweight
 * inventory inline for dry runs.
 */
async function executeAnnotationAudit(formValues, rootDir, context) {
  const {
    targetDir = "",
    fileExtensions = ".mjs, .js, .ts, .tsx, .jsx, .py",
    skipGenerated = true,
    phases = "all",
    dryRun = false,
  } = formValues;

  // Parse extensions
  const extensions = fileExtensions
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  // Build inventory inline (lightweight — no agent needed)
  const scanRoot = targetDir ? resolve(rootDir, targetDir) : rootDir;
  const inventory = buildInventory(scanRoot, extensions, skipGenerated, rootDir);

  if (dryRun) {
    return {
      mode: "dry-run",
      filesScanned: inventory.length,
      filesNeedingSummary: inventory.filter((f) => !f.has_summary).length,
      filesNeedingWarn: inventory.filter((f) => !f.has_warn).length,
      phases,
      inventory,
    };
  }

  // For actual execution, create a task that the agent will pick up
  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const taskDescription = buildAuditTaskDescription(formValues, inventory);
    const task = await context.taskManager.createTask({
      title: `docs(audit): codebase annotation audit`,
      description: taskDescription,
      priority: "high",
      labels: ["audit", "documentation", "annotation"],
      skills: ["codebase-annotation-audit"],
    });
    return {
      mode: "task-dispatched",
      taskId: task.id || task._id,
      filesScanned: inventory.length,
      filesNeedingSummary: inventory.filter((f) => !f.has_summary).length,
      phases,
    };
  }

  // Fallback: return inventory with instructions for manual execution
  const auditDir = resolve(rootDir, ".bosun", "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    resolve(auditDir, "inventory.json"),
    JSON.stringify(inventory, null, 2) + "\n",
    "utf8",
  );

  return {
    mode: "inventory-saved",
    inventoryPath: resolve(auditDir, "inventory.json"),
    filesScanned: inventory.length,
    filesNeedingSummary: inventory.filter((f) => !f.has_summary).length,
    filesNeedingWarn: inventory.filter((f) => !f.has_warn).length,
    phases,
    instructions:
      "Inventory saved. Assign a docs(audit) task to an agent with the codebase-annotation-audit skill to complete annotation.",
  };
}

/**
 * Scan files to build an audit inventory.
 */
function buildInventory(scanDir, extensions, skipGenerated, repoRoot) {
  const inventory = [];
  const GENERATED_PATTERNS = [
    /node_modules/,
    /\.min\.\w+$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.next\//,
    /dist\//,
    /build\//,
    /coverage\//,
    /\.bosun-worktrees\//,
    /\.git\//,
  ];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      const relPath = fullPath.replace(repoRoot, "").replace(/\\/g, "/").replace(/^\//, "");

      if (entry.isDirectory()) {
        if (skipGenerated && GENERATED_PATTERNS.some((p) => p.test(relPath))) continue;
        if (entry.name.startsWith(".") && entry.name !== ".bosun") continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (extensions.length > 0 && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
      if (skipGenerated && GENERATED_PATTERNS.some((p) => p.test(relPath))) continue;

      let content = "";
      let lines = 0;
      let hasSummary = false;
      let hasWarn = false;

      try {
        content = readFileSync(fullPath, "utf8");
        lines = content.split("\n").length;
        hasSummary = /CLAUDE:SUMMARY/i.test(content);
        hasWarn = /CLAUDE:WARN/i.test(content);
      } catch { /* unreadable */ }

      const ext = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")) : "";
      const category = categorizeFile(relPath, ext);

      inventory.push({
        path: relPath,
        lang: ext,
        lines,
        has_summary: hasSummary,
        has_warn: hasWarn,
        category,
      });
    }
  }

  walk(scanDir);
  return inventory;
}

function categorizeFile(relPath, ext) {
  if (/test|spec|__tests__/i.test(relPath)) return "test";
  if (/\.config\.|tsconfig|jest\.config|webpack|vite\.config|\.env/i.test(relPath)) return "config";
  if (/\.min\.|dist\/|build\/|generated/i.test(relPath)) return "generated";
  if (/util|helper|lib\//i.test(relPath)) return "util";
  return "core";
}

function buildAuditTaskDescription(formValues, inventory) {
  const needsSummary = inventory.filter((f) => !f.has_summary).length;
  const needsWarn = inventory.filter((f) => !f.has_warn).length;
  return `## Codebase Annotation Audit

**Phases:** ${formValues.phases || "all"}
**Target:** ${formValues.targetDir || "(entire repo)"}
**Extensions:** ${formValues.fileExtensions || "all source files"}

### Inventory Summary
- Total files: ${inventory.length}
- Files needing CLAUDE:SUMMARY: ${needsSummary}
- Files needing CLAUDE:WARN review: ${needsWarn}

### Instructions
Follow the codebase-annotation-audit skill (loaded in your skills).
Run phases as specified above. Do NOT change any program behavior — documentation only.
${formValues.commitMessage ? `\nCommit with: \`${formValues.commitMessage}\`` : ""}
`;
}

/** Stub executor for skill generation flow. */
async function executeSkillGeneration(formValues, rootDir, context) {
  const modules = (formValues.targetModules || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const task = await context.taskManager.createTask({
      title: "docs(skills): generate agent skills from codebase analysis",
      description: `Analyze ${modules.length > 0 ? modules.join(", ") : "all modules"} and generate up to ${formValues.maxSkills || 10} skill files.\nScope: ${formValues.skillScope || "global"}\nInclude examples: ${formValues.includeExamples !== false}`,
      priority: "medium",
      labels: ["skills", "documentation", "automation"],
    });
    return { mode: "task-dispatched", taskId: task.id || task._id };
  }

  return {
    mode: "instructions",
    instructions:
      "Create a task with title 'docs(skills): generate agent skills' to have an agent analyze the codebase and produce skill files.",
    targetModules: modules,
    scope: formValues.skillScope || "global",
  };
}

/** Stub executor for AGENTS.md preparation flow. */
async function executeAgentsMdPrep(formValues, rootDir, context) {
  const agentsMdPath = resolve(formValues.repoRoot || rootDir, "AGENTS.md");
  const exists = existsSync(agentsMdPath);

  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const task = await context.taskManager.createTask({
      title: `docs(agents): ${formValues.mode === "generate" ? "generate" : "update"} AGENTS.md`,
      description: `${formValues.mode === "generate" ? "Generate" : "Update"} the AGENTS.md file at repo root.\nCurrent state: ${exists ? "exists" : "missing"}\nInclude env vars: ${formValues.includeEnvVars !== false}\nInclude module inventory: ${formValues.includeModuleInventory !== false}`,
      priority: "medium",
      labels: ["docs", "agents-md"],
    });
    return { mode: "task-dispatched", taskId: task.id || task._id };
  }

  return {
    mode: "instructions",
    agentsMdExists: exists,
    instructions: `${exists ? "Update" : "Create"} AGENTS.md at repo root with build commands, module inventory, and env vars.`,
  };
}

/** Stub executor for health check flow. */
async function executeHealthCheck(formValues, rootDir, context) {
  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const task = await context.taskManager.createTask({
      title: `chore(health): codebase health check — ${formValues.checks || "all"}`,
      description: `Run ${formValues.checks === "all" ? "all" : formValues.checks} health check(s).\nTarget: ${formValues.targetDir || "entire repo"}\nOutput: ${formValues.outputFormat || "json"}`,
      priority: "medium",
      labels: ["health", "quality", "audit"],
    });
    return { mode: "task-dispatched", taskId: task.id || task._id };
  }

  return {
    mode: "instructions",
    checks: formValues.checks || "all",
    targetDir: formValues.targetDir || "(entire repo)",
    instructions: "Create a health check task to analyze: dead code, deps, circular imports, coverage gaps.",
  };
}

async function executeContextIndexFull(formValues, rootDir, _context = {}) {
  const { runContextIndex } = await import("./context-indexer.mjs");
  const result = await runContextIndex({
    rootDir,
    includeTests: formValues.includeTests !== false,
    maxFileBytes: Number(formValues.maxFileBytes || 800000),
    useTreeSitter: formValues.useTreeSitter !== false,
    useZoekt: formValues.useZoekt !== false,
  });
  return {
    ...result,
    mode: "indexed",
  };
}

/** Executor for user-created custom templates. */
async function executeCustomFlow(template, formValues, rootDir, context) {
  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const task = await context.taskManager.createTask({
      title: `run(${template.category || "custom"}): ${template.name}`,
      description: `Manual flow execution: ${template.description || template.name}\n\nForm values:\n${JSON.stringify(formValues, null, 2)}`,
      priority: "medium",
      labels: ["manual-flow", template.category || "custom"],
    });
    return { mode: "task-dispatched", taskId: task.id || task._id };
  }

  return {
    mode: "instructions",
    template: template.id,
    formValues,
    instructions: `Create a task to execute the "${template.name}" flow with the submitted form values.`,
  };
}

// ── Persistence helpers ──────────────────────────────────────────────────────

function writeRunToDisk(run, rootDir) {
  const dir = getRunsDir(rootDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${run.id}.json`), JSON.stringify(run, null, 2) + "\n", "utf8");
}
